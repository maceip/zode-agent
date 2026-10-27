import type { ProcessRunnerService } from './process-runner-api.js'
import type { HarnessContext, HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import type {
  GitBranchInspectOptions,
  GitBranchState,
  GitChangedFile,
  GitCheckDetail,
  GitCheckState,
  GitInspectOptions,
  GitPullRequest,
  GitPullRequestStack,
  GitRepositoryState,
  GitSupportService,
  GitSupportSnapshot,
} from './git-support-api.js'

const STATE_NAME = 'git-support.state'
const INSPECT_METHOD = 'git-support.inspect'
const INSPECT_BRANCH_METHOD = 'git-support.inspect-branch'
const LOCAL_TTL_MS = 4_000
const REMOTE_TTL_MS = 45_000

interface GitSupportConfig {
  localTtlMs?: number
  remoteTtlMs?: number
}

// Native stack membership and positions come from GitHub, never branch-name inference.
// https://docs.github.com/en/graphql/reference/pulls#pullrequeststack
const PULL_REQUEST_QUERY = `
  query AltoBranchPullRequests($owner: String!, $name: String!, $branch: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(headRefName: $branch, states: OPEN, first: 5,
        orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes {
          ...PullRequestDetails
          stack {
            id number baseRefName size
            entries(first: 100) {
              nodes { position pullRequest { ...PullRequestDetails } }
            }
          }
        }
      }
    }
  }
  fragment PullRequestDetails on PullRequest {
    number title url state isDraft headRefName baseRefName updatedAt
    statusCheckRollup {
      state
      contexts(first: 100) {
        totalCount
        nodes {
          ... on CheckRun { name status conclusion detailsUrl }
          ... on StatusContext { context state description targetUrl }
        }
      }
    }
  }
`

function normalizedPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
}

async function command(
  runner: ProcessRunnerService,
  executable: string,
  args: string[],
  options: { cwd?: string; timeout?: number; trim?: boolean } = {},
): Promise<string> {
  const { stdout } = await runner.execFile(executable, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeout ?? 5_000,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  return options.trim === false ? stdout : stdout.trim()
}

async function git(runner: ProcessRunnerService, location: string, args: string[], trim = true): Promise<string> {
  return command(runner, 'git', ['-C', location, ...args], { trim })
}

export function parseGitStatus(value: string): GitChangedFile[] {
  const records = value.split('\0')
  const files: GitChangedFile[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 3) continue
    const indexStatus = record[0] ?? ' '
    const worktreeStatus = record[1] ?? ' '
    const path = record.slice(3)
    if (!path) continue
    const renamed = /[RC]/u.test(indexStatus) || /[RC]/u.test(worktreeStatus)
    const previousPath = renamed ? records[index + 1] : undefined
    if (renamed) index += 1
    files.push({
      path,
      indexStatus,
      worktreeStatus,
      ...(previousPath ? { previousPath } : {}),
    })
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path))
}

function individualCheckState(value: unknown): GitCheckState | undefined {
  if (!isRecord(value)) return undefined
  const conclusion = typeof value.conclusion === 'string' ? value.conclusion.toUpperCase() : ''
  const state = typeof value.state === 'string' ? value.state.toUpperCase() : ''
  const status = typeof value.status === 'string' ? value.status.toUpperCase() : ''
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(conclusion)
    || ['FAILURE', 'ERROR'].includes(state)) return 'failing'
  if ((status && status !== 'COMPLETED') || ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(state)) {
    return 'pending'
  }
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion) || state === 'SUCCESS') return 'passing'
  return undefined
}

export function checkState(checks: unknown): GitCheckState | undefined {
  if (!Array.isArray(checks)) return undefined
  const states = checks.map(individualCheckState)
  if (states.includes('failing')) return 'failing'
  if (states.includes('pending')) return 'pending'
  return states.includes('passing') ? 'passing' : undefined
}

export function checkDetails(checks: unknown): GitCheckDetail[] {
  if (!Array.isArray(checks)) return []
  return checks.flatMap((check) => {
    if (!isRecord(check)) return []
    const state = individualCheckState(check)
    const name = typeof check.name === 'string' ? check.name
      : typeof check.context === 'string' ? check.context : undefined
    if (!state || !name) return []
    const url = typeof check.detailsUrl === 'string' ? check.detailsUrl
      : typeof check.targetUrl === 'string' ? check.targetUrl : undefined
    const label = typeof check.conclusion === 'string' && check.conclusion
      ? check.conclusion : typeof check.status === 'string' ? check.status : undefined
    const description = typeof check.description === 'string' && check.description
      ? check.description : label?.toLowerCase().replaceAll('_', ' ')
    return [{ name, state, ...(url ? { url } : {}), ...(description ? { description } : {}) }]
  })
}

export function githubRepository(remote: string): string | undefined {
  const value = remote.trim().replace(/\.git$/u, '')
  if (/^[a-z0-9.-]+\/[^/]+\/[^/]+$/iu.test(value)) return value
  const scp = value.includes('://') ? null : /^(?:[^@]+@)?([^:]+):(.+\/.+)$/u.exec(value)
  if (scp) return `${scp[1]}/${scp[2]}`
  try {
    const url = new URL(value)
    const path = url.pathname.replace(/^\/+|\/+$/gu, '')
    return path ? `${url.hostname}/${path}` : undefined
  } catch {
    return undefined
  }
}

export function parseGitPullRequest(value: unknown, includeStack = true): GitPullRequest | undefined {
  if (
    !isRecord(value)
    || typeof value.number !== 'number'
    || typeof value.title !== 'string'
    || typeof value.url !== 'string'
    || typeof value.state !== 'string'
    || typeof value.isDraft !== 'boolean'
    || typeof value.headRefName !== 'string'
    || typeof value.baseRefName !== 'string'
  ) return undefined
  const rollup = value.statusCheckRollup
  const contexts = isRecord(rollup) && isRecord(rollup.contexts) ? rollup.contexts : undefined
  const rawChecks = contexts?.nodes ?? rollup
  const checks = individualCheckState(rollup) ?? checkState(rawChecks)
  const details = checkDetails(rawChecks)
  const checkCount = typeof contexts?.totalCount === 'number' ? contexts.totalCount : details.length
  const stack = includeStack ? parsePullRequestStack(value.stack) : undefined
  return {
    number: value.number,
    title: value.title,
    url: value.url,
    state: value.state,
    draft: value.isDraft,
    headBranch: value.headRefName,
    baseBranch: value.baseRefName,
    ...(checks ? { checks } : {}),
    ...(details.length ? { checkDetails: details } : {}),
    ...(checkCount ? { checkCount } : {}),
    ...(stack ? { stack } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  }
}

function parsePullRequestStack(value: unknown): GitPullRequestStack | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.number !== 'number'
    || typeof value.baseRefName !== 'string'
    || typeof value.size !== 'number'
    || !isRecord(value.entries)
    || !Array.isArray(value.entries.nodes)
  ) return undefined
  const entries = value.entries.nodes.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.position !== 'number' || entry.position < 1) return []
    const pullRequest = parseGitPullRequest(entry.pullRequest, false)
    return pullRequest ? [{ position: entry.position, pullRequest }] : []
  }).sort((left, right) => left.position - right.position)
  return { id: value.id, number: value.number, baseBranch: value.baseRefName, size: value.size, entries }
}

async function readPullRequests(runner: ProcessRunnerService, root: string, branch: string): Promise<GitPullRequest[]> {
  if (!branch || branch.startsWith('detached@')) return []
  let remote: string
  try {
    remote = await git(runner, root, ['remote', 'get-url', 'origin'])
  } catch {
    return []
  }
  const repository = githubRepository(remote)
  if (!repository) return []
  return readPullRequestsForRepository(runner, repository, branch, root)
}

export async function readPullRequestsForRepository(
  runner: ProcessRunnerService,
  repository: string,
  branch: string,
  cwd?: string,
): Promise<GitPullRequest[]> {
  if (!branch || branch.startsWith('detached@')) return []
  const [hostname, owner, name] = repository.split('/')
  if (hostname && owner && name) {
    try {
      const output = await command(runner, 'gh', [
        'api', 'graphql', '--hostname', hostname,
        '-f', `query=${PULL_REQUEST_QUERY}`,
        '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `branch=${branch}`,
      ], { ...(cwd ? { cwd } : {}), timeout: 7_000 })
      const result = JSON.parse(output) as unknown
      const data = isRecord(result) && isRecord(result.data) ? result.data : undefined
      const repo = data && isRecord(data.repository) ? data.repository : undefined
      const pullRequests = repo && isRecord(repo.pullRequests) ? repo.pullRequests : undefined
      if (pullRequests && Array.isArray(pullRequests.nodes)) {
        return pullRequests.nodes.map((value) => parseGitPullRequest(value))
          .filter((candidate): candidate is GitPullRequest => Boolean(candidate))
      }
    } catch {
      // Stack fields are newer than some GitHub hosts. Keep ordinary PRs available.
    }
  }
  try {
    const output = await command(runner, 'gh', [
      'pr', 'list',
      '--repo', repository,
      '--head', branch,
      '--state', 'open',
      '--limit', '5',
      '--json', 'number,title,url,state,isDraft,headRefName,baseRefName,updatedAt,statusCheckRollup',
    ], { ...(cwd ? { cwd } : {}), timeout: 7_000 })
    const parsed = JSON.parse(output) as unknown
    return Array.isArray(parsed)
      ? parsed.map((value) => parseGitPullRequest(value)).filter((candidate): candidate is GitPullRequest => Boolean(candidate))
      : []
  } catch {
    // GitHub CLI is optional. Local branch and file state remain available.
    return []
  }
}

async function readLocalState(runner: ProcessRunnerService, location: string): Promise<GitRepositoryState> {
  const root = normalizedPath(await git(runner, location, ['rev-parse', '--show-toplevel']))
  const [branchText, head, statusText] = await Promise.all([
    git(runner, root, ['branch', '--show-current']),
    git(runner, root, ['rev-parse', '--short', 'HEAD']),
    git(runner, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], false),
  ])
  const branch = branchText || `detached@${head}`
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  try {
    upstream = await git(runner, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    const [behindText, aheadText] = (await git(runner, root, [
      'rev-list', '--left-right', '--count', '@{upstream}...HEAD',
    ])).split(/\s+/u)
    behind = Number(behindText) || 0
    ahead = Number(aheadText) || 0
  } catch {
    // Local-only branches legitimately have no upstream.
  }
  return {
    root,
    branch,
    head,
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    files: parseGitStatus(statusText),
    pullRequests: [],
    updatedAt: new Date().toISOString(),
  }
}

export function preserveRemoteState(
  local: GitRepositoryState,
  known: GitRepositoryState | undefined,
): GitRepositoryState {
  if (!known || known.root !== local.root || known.branch !== local.branch) return local
  return {
    ...local,
    pullRequests: known.pullRequests,
    ...(known.remoteUpdatedAt ? { remoteUpdatedAt: known.remoteUpdatedAt } : {}),
  }
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function inspectPayload(value: JsonValue | undefined): { location: string; options: GitInspectOptions } {
  if (!isRecord(value) || typeof value.location !== 'string' || !value.location.trim()) {
    throw new Error('git-support.inspect requires a location')
  }
  return {
    location: value.location,
    options: {
      includeRemote: value.includeRemote === true,
      force: value.force === true,
    },
  }
}

function inspectBranchPayload(value: JsonValue | undefined): {
  location: string
  branch: string
  options: GitBranchInspectOptions
} {
  if (
    !isRecord(value)
    || typeof value.location !== 'string'
    || !value.location.trim()
    || typeof value.branch !== 'string'
    || !value.branch.trim()
  ) throw new Error('git-support.inspect-branch requires a location and branch')
  return {
    location: value.location,
    branch: value.branch,
    options: {
      ...(typeof value.repository === 'string' ? { repository: value.repository } : {}),
      ...(typeof value.originUrl === 'string' ? { originUrl: value.originUrl } : {}),
      force: value.force === true,
    },
  }
}

export class GitSupportRegistry implements GitSupportService {
  private readonly aliases = new Map<string, string>()
  private readonly repositories = new Map<string, GitRepositoryState>()
  private readonly inflight = new Map<string, Promise<GitRepositoryState>>()
  private readonly localInflight = new Map<string, Promise<GitRepositoryState>>()
  private readonly branches = new Map<string, GitBranchState>()
  private readonly branchInflight = new Map<string, Promise<GitBranchState>>()
  private revision = 0
  private readonly state
  private readonly runner: ProcessRunnerService

  constructor(
    owner: HarnessContext,
    private readonly localTtlMs: number,
    private readonly remoteTtlMs: number,
  ) {
    this.runner = owner.processRunner
    this.state = owner.clientExtensions.registerState(owner, STATE_NAME, json(this.snapshot()))
  }

  snapshot(): GitSupportSnapshot {
    return {
      version: 1,
      revision: this.revision,
      aliases: Object.fromEntries(this.aliases),
      repositories: Object.fromEntries(this.repositories),
      updatedAt: new Date().toISOString(),
    }
  }

  async inspect(location: string, options: GitInspectOptions = {}): Promise<GitRepositoryState> {
    const alias = normalizedPath(location)
    const knownRoot = this.aliases.get(alias)
    const known = knownRoot ? this.repositories.get(knownRoot) : undefined
    const now = Date.now()
    const localFresh = known && now - Date.parse(known.updatedAt) < this.localTtlMs
    const remoteFresh = !options.includeRemote || (
      known?.remoteUpdatedAt && now - Date.parse(known.remoteUpdatedAt) < this.remoteTtlMs
    )
    if (!options.force && known && localFresh && remoteFresh) return known

    const key = `${alias}:${options.includeRemote ? 'remote' : 'local'}:${options.force ? 'force' : 'cached'}`
    const running = this.inflight.get(key)
    if (running) return running
    const work = this.load(alias, known, options).finally(() => this.inflight.delete(key))
    this.inflight.set(key, work)
    return work
  }

  async inspectBranch(
    location: string,
    branch: string,
    options: GitBranchInspectOptions = {},
  ): Promise<GitBranchState> {
    const name = branch.trim()
    if (!name || name.length > 240) throw new Error('Git branch is invalid')
    let repository = options.repository ? githubRepository(options.repository) : undefined
    if (!repository && options.originUrl) repository = githubRepository(options.originUrl)
    let cwd: string | undefined
    if (!repository) {
      const local = await this.inspect(location)
      cwd = local.root
      try {
        repository = githubRepository(await git(this.runner, local.root, ['remote', 'get-url', 'origin']))
      } catch {
        // A local-only repository can still provide a stable empty branch result.
      }
    }
    const key = `${repository ?? normalizedPath(location)}\0${name}`
    const known = this.branches.get(key)
    if (!options.force && known && Date.now() - Date.parse(known.updatedAt) < this.remoteTtlMs) {
      return known
    }
    const running = this.branchInflight.get(key)
    if (running) return running
    const work = (async (): Promise<GitBranchState> => {
      const next: GitBranchState = {
        branch: name,
        pullRequests: repository
          ? await readPullRequestsForRepository(this.runner, repository, name, cwd)
          : [],
        updatedAt: new Date().toISOString(),
        ...(repository ? { repository } : {}),
      }
      this.branches.set(key, next)
      return next
    })().finally(() => this.branchInflight.delete(key))
    this.branchInflight.set(key, work)
    return work
  }

  private readLocal(alias: string, force: boolean): Promise<GitRepositoryState> {
    // Remote metadata requests and local badges can arrive together. They
    // should share the filesystem scan even when their final results differ.
    const key = `${alias}:${force ? 'force' : 'cached'}`
    const running = this.localInflight.get(key)
    if (running) return running
    const work = readLocalState(this.runner, alias).finally(() => this.localInflight.delete(key))
    this.localInflight.set(key, work)
    return work
  }

  private async load(
    alias: string,
    known: GitRepositoryState | undefined,
    options: GitInspectOptions,
  ): Promise<GitRepositoryState> {
    let next = known
    const now = Date.now()
    const localFresh = known && now - Date.parse(known.updatedAt) < this.localTtlMs
    if (options.force || !localFresh) {
      next = preserveRemoteState(await this.readLocal(alias, options.force === true), known)
    }
    if (!next) next = await this.readLocal(alias, options.force === true)
    if (options.includeRemote) {
      const remoteFresh = next.remoteUpdatedAt
        && now - Date.parse(next.remoteUpdatedAt) < this.remoteTtlMs
      if (options.force || !remoteFresh) {
        next = {
          ...next,
          pullRequests: await readPullRequests(this.runner, next.root, next.branch),
          remoteUpdatedAt: new Date().toISOString(),
        }
      }
    }
    this.aliases.set(alias, next.root)
    this.aliases.set(next.root, next.root)
    this.repositories.set(next.root, next)
    this.revision += 1
    this.state.update(json(this.snapshot()))
    return next
  }
}

const gitSupport: HarnessPlugin<GitSupportConfig> = (ctx, config) => {
  const registry = new GitSupportRegistry(
    ctx,
    Math.max(500, config?.localTtlMs ?? LOCAL_TTL_MS),
    Math.max(5_000, config?.remoteTtlMs ?? REMOTE_TTL_MS),
  )
  ctx.provide('gitSupport', registry)
  ctx.clientExtensions.registerMethod(ctx, INSPECT_METHOD, async (payload) => {
    const { location, options } = inspectPayload(payload)
    return json(await registry.inspect(location, options))
  })
  ctx.clientExtensions.registerMethod(ctx, INSPECT_BRANCH_METHOD, async (payload) => {
    const { location, branch, options } = inspectBranchPayload(payload)
    return json(await registry.inspectBranch(location, branch, options))
  })
}

gitSupport.inject = ['clientExtensions', 'processRunner']
gitSupport.provide = 'gitSupport'

export default gitSupport
