import type { BrowserPlugin, ClientHostService } from '../../src/client/plugin-api.js'
import { isRecord } from '../../src/shared/protocol.js'
import styles from './git-support.css'
import type { ClientGitSupportService } from './git-support-client-api.js'
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
  GitSupportSnapshot,
} from './git-support-api.js'

const EMPTY: GitSupportSnapshot = {
  version: 1,
  revision: 0,
  aliases: {},
  repositories: {},
  updatedAt: new Date(0).toISOString(),
}

function normalizedPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
}

function changedFile(value: unknown): GitChangedFile | undefined {
  if (
    !isRecord(value)
    || typeof value.path !== 'string'
    || typeof value.indexStatus !== 'string'
    || typeof value.worktreeStatus !== 'string'
  ) return undefined
  return {
    path: value.path,
    indexStatus: value.indexStatus,
    worktreeStatus: value.worktreeStatus,
    ...(typeof value.previousPath === 'string' ? { previousPath: value.previousPath } : {}),
  }
}

function checkState(value: unknown): GitCheckState | undefined {
  return value === 'pending' || value === 'passing' || value === 'failing' ? value : undefined
}

function checkDetail(value: unknown): GitCheckDetail | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined
  const state = checkState(value.state)
  if (!state) return undefined
  return {
    name: value.name,
    state,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
  }
}

function pullRequestStack(value: unknown): GitPullRequestStack | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.number !== 'number'
    || typeof value.baseBranch !== 'string'
    || typeof value.size !== 'number'
    || !Array.isArray(value.entries)
  ) return undefined
  const entries = value.entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.position !== 'number' || entry.position < 1) return []
    const parsed = pullRequest(entry.pullRequest, false)
    return parsed ? [{ position: entry.position, pullRequest: parsed }] : []
  }).sort((left, right) => left.position - right.position)
  return { id: value.id, number: value.number, baseBranch: value.baseBranch, size: value.size, entries }
}

function pullRequest(value: unknown, includeStack = true): GitPullRequest | undefined {
  if (
    !isRecord(value)
    || typeof value.number !== 'number'
    || typeof value.title !== 'string'
    || typeof value.url !== 'string'
    || typeof value.state !== 'string'
    || typeof value.draft !== 'boolean'
    || typeof value.headBranch !== 'string'
    || typeof value.baseBranch !== 'string'
  ) return undefined
  const checks = checkState(value.checks)
  const checkDetails = Array.isArray(value.checkDetails) ? value.checkDetails
    .map(checkDetail).filter((check): check is GitCheckDetail => Boolean(check)) : undefined
  const stack = includeStack ? pullRequestStack(value.stack) : undefined
  return {
    number: value.number,
    title: value.title,
    url: value.url,
    state: value.state,
    draft: value.draft,
    headBranch: value.headBranch,
    baseBranch: value.baseBranch,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    ...(checks ? { checks } : {}),
    ...(checkDetails ? { checkDetails } : {}),
    ...(typeof value.checkCount === 'number' ? { checkCount: value.checkCount } : {}),
    ...(stack ? { stack } : {}),
  }
}

function branchState(value: unknown): GitBranchState | undefined {
  if (
    !isRecord(value)
    || typeof value.branch !== 'string'
    || typeof value.updatedAt !== 'string'
    || !Array.isArray(value.pullRequests)
  ) return undefined
  const pullRequests = value.pullRequests.map((value) => pullRequest(value))
  if (pullRequests.some((candidate) => !candidate)) return undefined
  return {
    branch: value.branch,
    pullRequests: pullRequests as GitPullRequest[],
    updatedAt: value.updatedAt,
    ...(typeof value.repository === 'string' ? { repository: value.repository } : {}),
  }
}

function repository(value: unknown): GitRepositoryState | undefined {
  if (
    !isRecord(value)
    || typeof value.root !== 'string'
    || typeof value.branch !== 'string'
    || typeof value.head !== 'string'
    || typeof value.ahead !== 'number'
    || typeof value.behind !== 'number'
    || typeof value.updatedAt !== 'string'
    || !Array.isArray(value.files)
    || !Array.isArray(value.pullRequests)
  ) return undefined
  const files = value.files.map(changedFile)
  const pullRequests = value.pullRequests.map((value) => pullRequest(value))
  if (files.some((candidate) => !candidate) || pullRequests.some((candidate) => !candidate)) return undefined
  return {
    ...value,
    files: files as GitChangedFile[],
    pullRequests: pullRequests as GitPullRequest[],
  } as GitRepositoryState
}

export function parseGitSupportSnapshot(value: unknown): GitSupportSnapshot {
  if (
    !isRecord(value)
    || value.version !== 1
    || typeof value.revision !== 'number'
    || typeof value.updatedAt !== 'string'
    || !isRecord(value.aliases)
    || !isRecord(value.repositories)
  ) return EMPTY
  const aliases = Object.fromEntries(Object.entries(value.aliases).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ))
  const repositories = Object.fromEntries(Object.entries(value.repositories).flatMap(([root, candidate]) => {
    const parsed = repository(candidate)
    return parsed ? [[root, parsed]] : []
  }))
  return { version: 1, revision: value.revision, aliases, repositories, updatedAt: value.updatedAt }
}

export class ClientGitSupport implements ClientGitSupportService {
  private readonly listeners = new Set<() => void>()
  private readonly inflight = new Map<string, Promise<GitRepositoryState | undefined>>()
  private readonly branchInflight = new Map<string, Promise<GitBranchState | undefined>>()
  private readonly unsubscribe: () => void
  private current = EMPTY

  constructor(private readonly host: ClientHostService) {
    this.read()
    this.unsubscribe = host.subscribe(() => this.read())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): GitSupportSnapshot => this.current

  repositoryFor(location: string): GitRepositoryState | undefined {
    const candidate = normalizedPath(location)
    const root = this.current.aliases[candidate]
    if (root) return this.current.repositories[root]
    return Object.values(this.current.repositories)
      .filter((repository) => candidate === repository.root || candidate.startsWith(`${repository.root}/`))
      .toSorted((left, right) => right.root.length - left.root.length)[0]
  }

  async inspect(
    location: string,
    options: GitInspectOptions = {},
  ): Promise<GitRepositoryState | undefined> {
    const candidate = normalizedPath(location)
    if (!candidate) return undefined
    const key = `${candidate}:${options.includeRemote ? 'remote' : 'local'}:${options.force ? 'force' : 'cached'}`
    const running = this.inflight.get(key)
    if (running) return running
    const work = this.host.call('git-support.inspect', {
      location: candidate,
      includeRemote: options.includeRemote === true,
      force: options.force === true,
    }).then((value) => repository(value)).catch(() => undefined).finally(() => this.inflight.delete(key))
    this.inflight.set(key, work)
    return work
  }

  async inspectBranch(
    location: string,
    branch: string,
    options: GitBranchInspectOptions = {},
  ): Promise<GitBranchState | undefined> {
    const candidate = normalizedPath(location)
    const name = branch.trim()
    if (!candidate || !name) return undefined
    const key = `${options.repository ?? options.originUrl ?? candidate}\0${name}:${options.force ? 'force' : 'cached'}`
    const running = this.branchInflight.get(key)
    if (running) return running
    const work = this.host.call('git-support.inspect-branch', {
      location: candidate,
      branch: name,
      ...(options.repository ? { repository: options.repository } : {}),
      ...(options.originUrl ? { originUrl: options.originUrl } : {}),
      force: options.force === true,
    }).then((value) => branchState(value)).catch(() => undefined).finally(() => {
      this.branchInflight.delete(key)
    })
    this.branchInflight.set(key, work)
    return work
  }

  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  private read(): void {
    const next = parseGitSupportSnapshot(
      this.host.snapshot().snapshot?.extensions['git-support.state'],
    )
    if (next.revision === this.current.revision) return
    this.current = next
    for (const listener of this.listeners) listener()
  }
}

const gitSupport: BrowserPlugin = (ctx) => {
  const service = new ClientGitSupport(ctx.clientHost)
  ctx.provide('clientGitSupport', service)
  ctx.clientUi.registerStyle(ctx, 'git-support', String(styles))
  ctx.effect(() => () => service.dispose(), 'clientGitSupport.lifecycle')
}

gitSupport.inject = ['clientHost', 'clientUi']
gitSupport.provide = 'clientGitSupport'

export default gitSupport
