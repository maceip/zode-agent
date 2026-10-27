import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProcessRunnerService } from './process-runner-api.js'
import type { GitRepositoryState } from './git-support-api.js'
import type { Context } from 'cordis'
import type { HarnessPlugin, TurnDraft } from '../../src/server/plugin-api.js'
import { isRecord, type JsonValue, type LocalProject } from '../../src/shared/protocol.js'
import type {
  WorkCheckout,
  WorkContextRegistryService,
  WorkContextSnapshot,
  WorkContextSourceRegistration,
  WorkContextSourceSnapshot,
  LocalBranchPlacement,
  WorkProvider,
  WorkProviderDescriptor,
  WorkProviderRegistration,
  WorkTarget,
  Workstream,
} from './work-contexts-api.js'

const execFileAsync = promisify(execFile)
const STATE_NAME = 'work-contexts.state'
const REFRESH_METHOD = 'work-contexts.refresh'
const SET_TARGET_METHOD = 'work-contexts.set-target'
const OPEN_LOCATION_METHOD = 'work-contexts.open-location'
const CREATE_BRANCH_METHOD = 'work-contexts.create-branch'
const CREATE_WORKTREE_METHOD = 'work-contexts.create-worktree'
const CREATE_PROVIDER_TARGET_METHOD = 'work-contexts.create-provider-target'
const CREATE_PROVIDER_BRANCH_METHOD = 'work-contexts.create-provider-branch-target'
const REFRESH_INTERVAL_MS = 5 * 60_000
const STATUS_MAX_AGE_MS = 90_000

interface WorkTargetFile {
  version: 1
  threadTargets: Record<string, WorkTarget>
}

interface GitWorktree {
  path: string
  head?: string
  branch?: string
  detached: boolean
  bare: boolean
}

function identity(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function sourceId(value: string): string {
  const id = value.trim()
  if (!/^[a-z][a-z0-9-]*$/iu.test(id) || id.length > 80) {
    throw new Error(`invalid work-context source id: ${value}`)
  }
  return id
}

function workKind(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return sourceId(value)
  } catch {
    return undefined
  }
}

function providerCheckout(value: unknown): WorkCheckout | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !value.id.trim()
    || !workKind(value.kind)
    || typeof value.projectId !== 'string'
    || !value.projectId.trim()
    || typeof value.branch !== 'string'
    || !value.branch.trim()
    || typeof value.label !== 'string'
    || !value.label.trim()
    || typeof value.location !== 'string'
    || !value.location.trim()
  ) return undefined
  return structuredClone(value) as unknown as WorkCheckout
}

function targetFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.codex-cordis', 'work-targets.json')
}

function parsedTarget(value: unknown): WorkTarget | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.checkoutId !== 'string'
    || !workKind(value.kind)
    || typeof value.projectId !== 'string'
    || typeof value.branch !== 'string'
    || typeof value.label !== 'string'
    || typeof value.location !== 'string'
    || typeof value.updatedAt !== 'string'
  ) return undefined
  return {
    id: value.id,
    checkoutId: value.checkoutId,
    kind: workKind(value.kind) as string,
    projectId: value.projectId,
    branch: value.branch,
    label: value.label,
    location: value.location,
    updatedAt: value.updatedAt,
    ...(typeof value.repository === 'string' ? { repository: value.repository } : {}),
    ...(typeof value.head === 'string' ? { head: value.head } : {}),
    ...(typeof value.dirty === 'boolean' ? { dirty: value.dirty } : {}),
    ...(typeof value.primary === 'boolean' ? { primary: value.primary } : {}),
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(typeof value.statusTone === 'string'
      && ['neutral', 'progress', 'success', 'warning', 'danger'].includes(value.statusTone)
      ? { statusTone: value.statusTone as NonNullable<WorkCheckout['statusTone']> }
      : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
    ...(typeof value.lastUsedAt === 'string' ? { lastUsedAt: value.lastUsedAt } : {}),
  }
}

export function parseWorkTargetFile(value: unknown): Record<string, WorkTarget> {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.threadTargets)) return {}
  return Object.fromEntries(Object.entries(value.threadTargets).flatMap(([threadId, candidate]) => {
    const target = parsedTarget(candidate)
    return target ? [[threadId, target]] : []
  }))
}

async function readTargets(file: string): Promise<Record<string, WorkTarget>> {
  try {
    return parseWorkTargetFile(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return {}
    throw error
  }
}

async function writeTargets(file: string, threadTargets: Record<string, WorkTarget>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const document: WorkTargetFile = { version: 1, threadTargets }
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function branchName(value: string | undefined, head: string | undefined): string {
  if (value?.startsWith('refs/heads/')) return value.slice('refs/heads/'.length)
  if (value) return value
  return head ? `detached/${head.slice(0, 8)}` : 'workspace'
}

type LocalCheckoutStatus = Pick<GitRepositoryState, 'branch' | 'head' | 'updatedAt' | 'error'> & {
  dirty: boolean
}

function checkoutMatchesStatus(checkout: WorkCheckout, status: Pick<GitRepositoryState, 'branch' | 'head'>): boolean {
  if (!status.head || !checkout.head?.startsWith(status.head)) return false
  return checkout.branch === status.branch
    || (checkout.branch === `detached/${checkout.head.slice(0, 8)}` && status.branch === `detached@${status.head}`)
}

function repositoryKey(value: string): string {
  const cleaned = value.trim()
    .replace(/^git@github\.com:/iu, 'github.com/')
    .replace(/^ssh:\/\/git@github\.com\//iu, 'github.com/')
    .replace(/^https?:\/\/github\.com\//iu, 'github.com/')
    .replace(/\.git$/iu, '')
  return cleaned.split('?', 1)[0] ?? cleaned
}

export function parseGitWorktrees(output: string): GitWorktree[] {
  return output.trim().split(/\n\s*\n/gu).flatMap((block) => {
    const lines = block.split('\n')
    const worktree = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
    if (!worktree) return []
    const head = lines.find((line) => line.startsWith('HEAD '))?.slice('HEAD '.length)
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length)
    return [{
      path: path.resolve(worktree),
      ...(head ? { head } : {}),
      ...(branch ? { branch } : {}),
      detached: lines.includes('detached'),
      bare: lines.includes('bare'),
    }]
  })
}

async function git(
  cwd: string,
  args: string[],
  timeout = 5_000,
  runner?: ProcessRunnerService,
): Promise<string | undefined> {
  try {
    const { stdout } = await (runner ? runner.execFile.bind(runner) : execFileAsync)('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout.trim()
  } catch {
    return undefined
  }
}

export type GitReader = (
  cwd: string,
  args: string[],
  timeout?: number,
) => Promise<string | undefined>

async function gitRemote(
  cwd: string,
  readGit: GitReader = git,
): Promise<string | undefined> {
  const origin = await readGit(cwd, ['remote', 'get-url', 'origin'])
  if (origin) return origin
  const remote = (await readGit(cwd, ['remote']))?.split(/\s+/u).find(Boolean)
  return remote ? readGit(cwd, ['remote', 'get-url', remote]) : undefined
}

function gitFailure(error: unknown): string {
  if (isRecord(error)) {
    if (typeof error.stderr === 'string' && error.stderr.trim()) return error.stderr.trim()
    if (typeof error.stdout === 'string' && error.stdout.trim()) return error.stdout.trim()
    if (typeof error.message === 'string' && error.message.trim()) return error.message.trim()
  }
  return String(error)
}

async function strictGit(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout.trim()
  } catch (error) {
    throw new Error(gitFailure(error))
  }
}

async function gitRefExists(cwd: string, reference: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', cwd, 'show-ref', '--verify', '--quiet', reference], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return true
  } catch (error) {
    if (isRecord(error) && error.code === 1) return false
    throw new Error(gitFailure(error))
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false
    throw error
  }
}

async function availableWorktreePath(primary: string, branch: string): Promise<string> {
  const slug = branch.toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'worktree'
  const base = path.join(path.dirname(primary), `${path.basename(primary)}-${slug}`)
  if (!await pathExists(base)) return base
  for (let suffix = 2; suffix <= 100; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!await pathExists(candidate)) return candidate
  }
  throw new Error(`could not find an available folder beside ${JSON.stringify(primary)}`)
}

export interface LocalGitWorktreeResult {
  branch: string
  location: string
  created: boolean
}

async function validBranchName(sourcePath: string, requestedBranch: string): Promise<string> {
  const branch = requestedBranch.trim()
  if (!branch || branch.length > 240) throw new Error('branch must be between 1 and 240 characters')
  try {
    await strictGit(sourcePath, ['check-ref-format', '--branch', branch], 5_000)
  } catch {
    throw new Error(`${JSON.stringify(branch)} is not a valid Git branch name`)
  }
  return branch
}

async function resolvedBaseCommit(
  sourcePath: string,
  requestedBaseRef: string | undefined,
): Promise<string | undefined> {
  if (requestedBaseRef === undefined) return undefined
  const baseRef = requestedBaseRef.trim()
  if (!baseRef || baseRef.length > 240 || baseRef.startsWith('-') || /[\0-\x1f\x7f]/u.test(baseRef)) {
    throw new Error('baseRef must be a valid Git reference between 1 and 240 characters')
  }
  try {
    return await strictGit(sourcePath, ['rev-parse', '--verify', `${baseRef}^{commit}`], 10_000)
  } catch {
    throw new Error(`Git base reference ${JSON.stringify(baseRef)} does not exist in this checkout`)
  }
}

export async function switchLocalGitBranch(
  sourcePath: string,
  requestedBranch: string,
  baseRef?: string,
): Promise<LocalGitWorktreeResult> {
  const branch = await validBranchName(sourcePath, requestedBranch)
  const current = await strictGit(sourcePath, ['branch', '--show-current'], 5_000)
  if (current === branch) return { branch, location: path.resolve(sourcePath), created: false }

  const localBranch = await gitRefExists(sourcePath, `refs/heads/${branch}`)
  const remoteBranch = !localBranch && await gitRefExists(sourcePath, `refs/remotes/origin/${branch}`)
  const baseCommit = !localBranch && !remoteBranch
    ? await resolvedBaseCommit(sourcePath, baseRef)
    : undefined
  const args = localBranch
    ? ['switch', branch]
    : remoteBranch
      ? ['switch', '--track', '-c', branch, `origin/${branch}`]
      : ['switch', '-c', branch, ...(baseCommit ? [baseCommit] : [])]
  await strictGit(sourcePath, args, 60_000)
  return { branch, location: path.resolve(sourcePath), created: !localBranch && !remoteBranch }
}

export async function createLocalGitWorktree(
  sourcePath: string,
  requestedBranch: string,
  baseRef?: string,
): Promise<LocalGitWorktreeResult> {
  const branch = await validBranchName(sourcePath, requestedBranch)

  const listed = parseGitWorktrees(await strictGit(sourcePath, ['worktree', 'list', '--porcelain']))
    .filter((worktree) => !worktree.bare)
  const existing = listed.find((worktree) => worktree.branch === `refs/heads/${branch}`)
  if (existing) return { branch, location: existing.path, created: false }

  const primary = listed[0]?.path ?? path.resolve(sourcePath)
  const location = await availableWorktreePath(primary, branch)
  const localBranch = await gitRefExists(sourcePath, `refs/heads/${branch}`)
  const remoteBranch = !localBranch && await gitRefExists(sourcePath, `refs/remotes/origin/${branch}`)
  const baseCommit = !localBranch && !remoteBranch
    ? await resolvedBaseCommit(sourcePath, baseRef)
    : undefined
  const args = localBranch
    ? ['worktree', 'add', location, branch]
    : remoteBranch
      ? ['worktree', 'add', '--track', '-b', branch, location, `origin/${branch}`]
      : ['worktree', 'add', '-b', branch, location, ...(baseCommit ? [baseCommit] : [])]
  await strictGit(sourcePath, args, 60_000)
  return { branch, location, created: true }
}

export async function discoverLocalCheckouts(
  project: LocalProject,
  readGit: GitReader = git,
): Promise<WorkCheckout[]> {
  const roots = [...new Set(project.roots.map((root) => path.resolve(root)))]
  const worktrees = new Map<string, GitWorktree>()
  const repositoryForWorktree = new Map<string, string>()
  const remainingRoots = new Set(roots)

  // `git worktree list` returns every checkout for a repository. Once one
  // root discovers that topology, skip the other roots it already covers.
  // A workspace with forty worktrees therefore needs one topology command,
  // not forty identical commands every refresh.
  while (remainingRoots.size) {
    const root = remainingRoots.values().next().value as string
    remainingRoots.delete(root)
    const output = await readGit(root, ['worktree', 'list', '--porcelain'])
    const discovered = (output ? parseGitWorktrees(output) : [])
      .filter((worktree) => !worktree.bare)
    if (!discovered.length) continue
    const repository = discovered[0]!.path
    for (const worktree of discovered) {
      worktrees.set(worktree.path, worktree)
      repositoryForWorktree.set(worktree.path, repository)
    }
    for (const candidate of remainingRoots) {
      if (discovered.some((worktree) => contains(worktree.path, candidate))) {
        remainingRoots.delete(candidate)
      }
    }
  }

  if (!worktrees.size) {
    return roots.map((root) => ({
      id: `local-${identity(project.id, root)}`,
      kind: 'local',
      projectId: project.id,
      branch: 'workspace',
      label: path.basename(root) || project.name,
      location: root,
      primary: root === path.resolve(project.primaryRoot),
    }))
  }

  const remoteByRepository = new Map<string, Promise<string | undefined>>()
  return Promise.all([...worktrees.values()].map(async (worktree): Promise<WorkCheckout> => {
    const branch = branchName(worktree.branch, worktree.head)
    const repository = repositoryForWorktree.get(worktree.path) ?? worktree.path
    let remoteRequest = remoteByRepository.get(repository)
    if (!remoteRequest) {
      remoteRequest = gitRemote(repository, readGit)
      remoteByRepository.set(repository, remoteRequest)
    }
    // Listing checkouts must not walk every worktree's files. Dirty state is
    // inspected through Git Support only when a checkout is being used.
    const remote = await remoteRequest
    return {
      id: `local-${identity(project.id, worktree.path)}`,
      kind: 'local',
      projectId: project.id,
      branch,
      label: path.basename(worktree.path) || project.name,
      location: worktree.path,
      ...(remote ? { repository: repositoryKey(remote) } : {}),
      ...(worktree.head ? { head: worktree.head } : {}),
      primary: worktree.path === path.resolve(project.primaryRoot),
    }
  }))
}

function workstreamId(projectId: string, branch: string): string {
  return `workstream-${identity(projectId, branch)}`
}

export function groupWorkstreams(checkouts: readonly WorkCheckout[]): Workstream[] {
  const grouped = new Map<string, Workstream>()
  for (const checkout of checkouts) {
    const id = workstreamId(checkout.projectId, checkout.branch)
    let workstream = grouped.get(id)
    if (!workstream) {
      workstream = {
        id,
        projectId: checkout.projectId,
        name: checkout.branch,
        branch: checkout.branch,
        ...(checkout.repository ? { repository: checkout.repository } : {}),
        checkouts: [],
      }
      grouped.set(id, workstream)
    }
    if (!workstream.repository && checkout.repository) workstream.repository = checkout.repository
    workstream.checkouts.push({ ...checkout })
  }
  return [...grouped.values()]
    .map((workstream) => ({
      ...workstream,
      checkouts: workstream.checkouts.toSorted((left, right) => (
        Number(right.kind === 'local') - Number(left.kind === 'local')
        || Number(right.primary) - Number(left.primary)
        || left.label.localeCompare(right.label)
      )),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name))
}

function asJson(value: WorkContextSnapshot | Record<string, JsonValue>): JsonValue {
  return value as unknown as JsonValue
}

export class WorkContextRegistry implements WorkContextRegistryService {
  private readonly file: string
  private readonly sources = new Map<string, WorkContextSourceSnapshot>()
  private readonly providers = new Map<string, {
    provider: WorkProvider
    snapshot: WorkContextSourceSnapshot
  }>()
  private local: WorkCheckout[] = []
  private readonly localStatus = new Map<string, LocalCheckoutStatus>()
  private discoveredAt = 0
  private threadTargets: Record<string, WorkTarget> = {}
  private revision = 0
  private updatedAt = new Date(0).toISOString()
  private problem: string | undefined
  private state: ReturnType<Context['clientExtensions']['registerState']> | undefined
  private refreshing: Promise<WorkContextSnapshot> | undefined
  private signature = ''
  private active = true

  constructor(private readonly ctx: Context) {
    this.file = targetFilePath(ctx.program.projectRoot)
  }

  async start(owner: Context): Promise<void> {
    owner.effect(() => () => {
      this.active = false
    }, 'workContexts.lifecycle')
    this.threadTargets = await readTargets(this.file)
    if (!this.active) return
    await this.refresh()
    if (!this.active) return
    this.state = this.ctx.clientExtensions.registerState(owner, STATE_NAME, asJson(this.snapshot()))
  }

  snapshot(): WorkContextSnapshot {
    const checkouts = this.checkouts()
    const threadTargets = Object.fromEntries(Object.entries(this.threadTargets).map(([threadId, target]) => {
      const current = checkouts.find((checkout) => checkout.id === target.checkoutId)
      // A saved dirty flag is not authoritative after a status check expires.
      const { dirty: _dirty, ...saved } = target
      return [threadId, current
        ? { ...saved, ...current, checkoutId: current.id, updatedAt: target.updatedAt }
        : target.kind === 'local' ? saved : { ...target }]
    }))
    return {
      version: 1,
      revision: this.revision,
      workstreams: groupWorkstreams(checkouts),
      providers: this.providerDescriptors(),
      threadTargets,
      updatedAt: this.updatedAt,
      ...(this.problem ? { problem: this.problem } : {}),
    }
  }

  refresh(): Promise<WorkContextSnapshot> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.discover().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  async refreshLocalCheckout(location: string, force = false): Promise<WorkContextSnapshot> {
    if (!this.active) return this.snapshot()
    if (Date.now() - this.discoveredAt >= REFRESH_INTERVAL_MS) await this.refresh()
    if (!this.active) return this.snapshot()
    const checkout = this.localCheckoutForPath(location)
    if (!checkout) return this.snapshot()
    try {
      // The pane's Git badge and work-target picker share the same status cache.
      const status = await this.ctx.gitSupport.inspect(checkout.location, { force })
      if (!this.active) return this.snapshot()
      if (!checkoutMatchesStatus(checkout, status)) {
        await this.refresh()
        if (!this.active) return this.snapshot()
      }
      this.localStatus.set(checkout.location, {
        branch: status.branch,
        head: status.head,
        dirty: status.files.length > 0,
        updatedAt: status.updatedAt,
        ...(status.error ? { error: status.error } : {}),
      })
    } catch {
      if (!this.active) return this.snapshot()
      // A timeout or unavailable checkout is unknown, never a clean worktree.
      this.localStatus.delete(checkout.location)
    }
    this.publish()
    return this.snapshot()
  }

  registerSource(
    owner: Context,
    id: string,
    snapshot: WorkContextSourceSnapshot,
  ): WorkContextSourceRegistration {
    const key = sourceId(id)
    let current = structuredClone(snapshot)
    let active = false
    const dispose = owner.effect(() => {
      if (this.sources.has(key) || this.providers.has(key)) {
        throw new Error(`work-context source "${key}" is already registered`)
      }
      active = true
      this.sources.set(key, current)
      this.publish()
      return () => {
        active = false
        if (this.sources.get(key) === current) this.sources.delete(key)
        this.publish()
      }
    }, `workContexts.registerSource(${JSON.stringify(key)})`)

    return {
      update: (next) => {
        if (!active) throw new Error(`work-context source "${key}" is not active`)
        const signature = JSON.stringify(next)
        if (signature === JSON.stringify(current)) return
        current = structuredClone(next)
        this.sources.set(key, current)
        this.publish()
      },
      dispose: async () => dispose(),
    }
  }

  registerProvider(
    owner: Context,
    provider: WorkProvider,
    snapshot: WorkContextSourceSnapshot = { checkouts: [] },
  ): WorkProviderRegistration {
    const key = sourceId(provider.id)
    if (!provider.label.trim()) throw new Error(`work provider ${JSON.stringify(key)} requires a label`)
    if (!provider.createTarget && !provider.createBranchTarget) {
      throw new Error(`work provider ${JSON.stringify(key)} must implement at least one target operation`)
    }
    const registeredProvider: WorkProvider = { ...provider, id: key, label: provider.label.trim() }
    let current = structuredClone(snapshot)
    let active = false
    const dispose = owner.effect(() => {
      if (this.providers.has(key) || this.sources.has(key)) {
        throw new Error(`work provider "${key}" is already registered`)
      }
      active = true
      this.providers.set(key, { provider: registeredProvider, snapshot: current })
      this.publish()
      return () => {
        active = false
        const registered = this.providers.get(key)
        if (registered?.provider === registeredProvider) this.providers.delete(key)
        this.publish()
      }
    }, `workContexts.registerProvider(${JSON.stringify(key)})`)

    return {
      update: (next) => {
        if (!active) throw new Error(`work provider "${key}" is not active`)
        if (JSON.stringify(next) === JSON.stringify(current)) return
        current = structuredClone(next)
        this.providers.set(key, { provider: registeredProvider, snapshot: current })
        this.publish()
      },
      dispose: async () => dispose(),
    }
  }

  async createProviderTarget(
    providerId: string,
    threadId: string,
    sourceCheckoutId: string,
    options?: Record<string, JsonValue>,
  ): Promise<WorkCheckout> {
    const key = sourceId(providerId)
    const entry = this.requireProvider(key)
    if (!entry.provider.createTarget) {
      throw new Error(`work provider ${JSON.stringify(providerId)} cannot target an existing branch`)
    }
    const source = this.requireLocalSource(sourceCheckoutId)
    const checkout = await entry.provider.createTarget({ threadId, source, ...(options ? { options } : {}) })
    return this.rememberProviderTarget(key, entry, source, threadId, checkout)
  }

  async createProviderBranchTarget(
    providerId: string,
    threadId: string,
    sourceCheckoutId: string,
    branch: string,
    baseRef?: string,
    options?: Record<string, JsonValue>,
  ): Promise<WorkCheckout> {
    const key = sourceId(providerId)
    const entry = this.requireProvider(key)
    if (!entry.provider.createBranchTarget) {
      throw new Error(`work provider ${JSON.stringify(providerId)} cannot create branches`)
    }
    const source = this.requireLocalSource(sourceCheckoutId)
    const checkout = await entry.provider.createBranchTarget({
      threadId,
      source,
      branch,
      ...(baseRef ? { baseRef } : {}),
      ...(options ? { options } : {}),
    })
    return this.rememberProviderTarget(key, entry, source, threadId, checkout)
  }

  async createLocalWorktree(
    sourceCheckoutId: string,
    branch: string,
    baseRef?: string,
  ): Promise<WorkCheckout> {
    return this.createLocalBranch(sourceCheckoutId, branch, 'worktree', baseRef)
  }

  async createLocalBranch(
    sourceCheckoutId: string,
    branch: string,
    placement: LocalBranchPlacement,
    baseRef?: string,
  ): Promise<WorkCheckout> {
    const source = this.checkout(sourceCheckoutId)
    if (!source || source.kind !== 'local') throw new Error('the source checkout is no longer available')
    if (this.refreshing) await this.refreshing
    const result = placement === 'checkout'
      ? await switchLocalGitBranch(source.location, branch, baseRef)
      : await createLocalGitWorktree(source.location, branch, baseRef)
    await this.refresh()
    const checkout = this.local.find((candidate) => (
      candidate.projectId === source.projectId
      && path.resolve(candidate.location) === path.resolve(result.location)
    ))
    if (!checkout) throw new Error('the branch was created but Alto could not discover its checkout')
    await this.refreshLocalCheckout(checkout.location, true)
    return this.checkout(checkout.id) ?? checkout
  }

  localCheckoutForPath(candidate: string): WorkCheckout | undefined {
    if (!path.isAbsolute(candidate)) return undefined
    const resolved = path.resolve(candidate)
    return this.local
      .filter((checkout) => contains(checkout.location, resolved))
      .toSorted((left, right) => right.location.length - left.location.length)[0]
  }

  targetForThread(threadId: string): WorkTarget | undefined {
    return this.snapshot().threadTargets[threadId]
  }

  async setThreadTarget(threadId: string, checkout: WorkCheckout | undefined): Promise<void> {
    const id = threadId.trim()
    if (!id || id.length > 200) throw new Error('threadId is invalid')
    if (!checkout) {
      delete this.threadTargets[id]
    } else {
      this.threadTargets[id] = {
        ...structuredClone(checkout),
        checkoutId: checkout.id,
        updatedAt: new Date().toISOString(),
      }
    }
    await writeTargets(this.file, this.threadTargets)
    this.publish()
  }

  checkout(id: string): WorkCheckout | undefined {
    return this.checkouts().find((checkout) => checkout.id === id)
  }

  private async discover(): Promise<WorkContextSnapshot> {
    try {
      const projects = this.ctx.projects.snapshot().projects
      const local = (await Promise.all(projects.map((project) => (
        discoverLocalCheckouts(project, (cwd, args, timeout) => git(cwd, args, timeout, this.ctx.processRunner))
      )))).flat()
      if (!this.active) return this.snapshot()
      this.local = local
      this.discoveredAt = Date.now()
      for (const location of this.localStatus.keys()) {
        if (!local.some((checkout) => checkout.location === location)) this.localStatus.delete(location)
      }
      this.problem = undefined
    } catch (error) {
      this.problem = error instanceof Error ? error.message : String(error)
    }
    this.publish()
    return this.snapshot()
  }

  private publish(): void {
    if (!this.active) return
    const snapshot = this.snapshot()
    const signature = JSON.stringify({
      workstreams: snapshot.workstreams,
      providers: snapshot.providers,
      threadTargets: snapshot.threadTargets,
      problem: snapshot.problem,
    })
    if (signature === this.signature) return
    this.signature = signature
    this.revision += 1
    this.updatedAt = new Date().toISOString()
    const next = this.snapshot()
    this.state?.update(asJson(next))
  }

  private checkouts(): WorkCheckout[] {
    return [
      ...this.local.map((checkout) => {
        const status = this.localStatus.get(checkout.location)
        if (!status || status.error || Date.now() - Date.parse(status.updatedAt) >= STATUS_MAX_AGE_MS
          || !checkoutMatchesStatus(checkout, status)) return checkout
        return { ...checkout, dirty: status.dirty }
      }),
      ...[...this.sources.values()].flatMap((source) => source.checkouts),
      ...[...this.providers.values()].flatMap((entry) => entry.snapshot.checkouts),
    ]
  }

  private providerDescriptors(): WorkProviderDescriptor[] {
    return [...this.providers.values()]
      .map(({ provider }) => ({
        id: provider.id,
        label: provider.label,
        ...(provider.description ? { description: provider.description } : {}),
        supportsExistingTarget: Boolean(provider.createTarget),
        supportsBranchTarget: Boolean(provider.createBranchTarget),
      }))
      .toSorted((left, right) => left.label.localeCompare(right.label))
  }

  private requireProvider(id: string): { provider: WorkProvider; snapshot: WorkContextSourceSnapshot } {
    const key = sourceId(id)
    const provider = this.providers.get(key)
    if (!provider) throw new Error(`work provider ${JSON.stringify(key)} is not available`)
    return provider
  }

  private requireLocalSource(id: string): WorkCheckout {
    const source = this.checkout(id)
    if (!source || source.kind !== 'local') throw new Error('the local source checkout is no longer available')
    return source
  }

  private async rememberProviderTarget(
    providerId: string,
    entry: { provider: WorkProvider; snapshot: WorkContextSourceSnapshot },
    source: WorkCheckout,
    threadId: string,
    candidate: WorkCheckout,
  ): Promise<WorkCheckout> {
    const checkout = providerCheckout(candidate)
    if (!checkout) {
      throw new Error(`work provider ${JSON.stringify(providerId)} returned an invalid checkout`)
    }
    if (checkout.kind !== providerId) {
      throw new Error(`work provider ${JSON.stringify(providerId)} returned checkout kind ${JSON.stringify(checkout.kind)}`)
    }
    if (checkout.projectId !== source.projectId) {
      throw new Error(`work provider ${JSON.stringify(providerId)} returned a checkout for another project`)
    }
    const existing = entry.snapshot.checkouts.filter((candidate) => candidate.id !== checkout.id)
    entry.snapshot = { checkouts: [...existing, structuredClone(checkout)] }
    this.providers.set(providerId, entry)
    this.publish()
    await this.setThreadTarget(threadId, checkout)
    return checkout
  }
}

export function localExecutionContext(target: WorkTarget): string {
  return `Alto work target: local checkout ${JSON.stringify(target.location)} on branch ${JSON.stringify(target.branch)}.
Use this checkout for repository reads, edits, commands, tests, and git operations in this turn. Do not silently operate on another worktree.`
}

export function remoteExecutionContext(target: WorkTarget): string {
  return `Alto work target: remote ${target.kind} checkout ${JSON.stringify(target.label)} on branch ${JSON.stringify(target.branch)}.
Repository work must run through the plugin that owns this remote checkout. Do not modify or test the project in the local checkout. If the provider is unavailable, report that instead of silently falling back to local execution.`
}

export async function openLocalCheckout(
  payload: unknown,
  contexts: Pick<WorkContextRegistryService, 'checkout'>,
  runner: Pick<ProcessRunnerService, 'execFile'>,
  signal: AbortSignal,
): Promise<{ location: string }> {
  if (!isRecord(payload) || typeof payload.checkoutId !== 'string') {
    throw new Error('checkoutId is required')
  }
  const checkout = contexts.checkout(payload.checkoutId)
  if (!checkout || checkout.kind !== 'local' || !path.isAbsolute(checkout.location) || checkout.location.includes('\0')) {
    throw new Error('Choose an available local checkout.')
  }
  const info = await stat(checkout.location).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error('This checkout no longer exists on this computer.')
  if (process.platform !== 'darwin') throw new Error('Opening a checkout in Finder is only supported on macOS.')
  signal.throwIfAborted()
  try {
    await runner.execFile('open', [checkout.location], { timeout: 15_000, signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error('Could not open this checkout in Finder.', { cause: error })
  }
  return { location: checkout.location }
}

const workContexts: HarnessPlugin = async (ctx) => {
  const registry = new WorkContextRegistry(ctx)
  ctx.provide('workContexts', registry)
  await registry.start(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'workContexts.openLocation')
  ctx.clientExtensions.registerMethod(ctx, OPEN_LOCATION_METHOD, async (payload) => (
    openLocalCheckout(payload, registry, ctx.processRunner, lifetime.signal)
  ))

  ctx.clientExtensions.registerMethod(ctx, REFRESH_METHOD, async (payload) => {
    if (isRecord(payload) && typeof payload.location === 'string') {
      return asJson(await registry.refreshLocalCheckout(payload.location))
    }
    return asJson(await registry.refresh())
  })
  ctx.clientExtensions.registerMethod(ctx, SET_TARGET_METHOD, async (payload) => {
    if (!isRecord(payload) || typeof payload.threadId !== 'string' || typeof payload.checkoutId !== 'string') {
      throw new Error('threadId and checkoutId are required')
    }
    const checkout = registry.checkout(payload.checkoutId)
    if (!checkout) throw new Error('that checkout is no longer available')
    await registry.setThreadTarget(payload.threadId, checkout)
    return asJson({
      threadId: payload.threadId,
      checkoutId: checkout.id,
      kind: checkout.kind,
    })
  })
  ctx.clientExtensions.registerMethod(ctx, CREATE_WORKTREE_METHOD, async (payload) => {
    if (
      !isRecord(payload)
      || typeof payload.threadId !== 'string'
      || typeof payload.sourceCheckoutId !== 'string'
      || typeof payload.branch !== 'string'
    ) throw new Error('threadId, sourceCheckoutId, and branch are required')
    const checkout = await registry.createLocalWorktree(
      payload.sourceCheckoutId,
      payload.branch,
      typeof payload.baseRef === 'string' ? payload.baseRef : undefined,
    )
    await registry.setThreadTarget(payload.threadId, checkout)
    return asJson({
      checkoutId: checkout.id,
      branch: checkout.branch,
      location: checkout.location,
    })
  })
  ctx.clientExtensions.registerMethod(ctx, CREATE_BRANCH_METHOD, async (payload) => {
    if (
      !isRecord(payload)
      || typeof payload.threadId !== 'string'
      || typeof payload.sourceCheckoutId !== 'string'
      || typeof payload.branch !== 'string'
      || (payload.placement !== 'checkout' && payload.placement !== 'worktree')
    ) throw new Error('threadId, sourceCheckoutId, branch, and placement are required')
    const checkout = await registry.createLocalBranch(
      payload.sourceCheckoutId,
      payload.branch,
      payload.placement,
      typeof payload.baseRef === 'string' ? payload.baseRef : undefined,
    )
    await registry.setThreadTarget(payload.threadId, checkout)
    return asJson({
      checkoutId: checkout.id,
      branch: checkout.branch,
      location: checkout.location,
      placement: payload.placement,
    })
  })
  ctx.clientExtensions.registerMethod(ctx, CREATE_PROVIDER_TARGET_METHOD, async (payload) => {
    if (
      !isRecord(payload)
      || typeof payload.providerId !== 'string'
      || typeof payload.threadId !== 'string'
      || typeof payload.sourceCheckoutId !== 'string'
    ) throw new Error('providerId, threadId, and sourceCheckoutId are required')
    const checkout = await registry.createProviderTarget(
      payload.providerId,
      payload.threadId,
      payload.sourceCheckoutId,
      isRecord(payload.options) ? payload.options as Record<string, JsonValue> : undefined,
    )
    return asJson({ checkoutId: checkout.id, kind: checkout.kind, branch: checkout.branch })
  })
  ctx.clientExtensions.registerMethod(ctx, CREATE_PROVIDER_BRANCH_METHOD, async (payload) => {
    if (
      !isRecord(payload)
      || typeof payload.providerId !== 'string'
      || typeof payload.threadId !== 'string'
      || typeof payload.sourceCheckoutId !== 'string'
      || typeof payload.branch !== 'string'
    ) throw new Error('providerId, threadId, sourceCheckoutId, and branch are required')
    const checkout = await registry.createProviderBranchTarget(
      payload.providerId,
      payload.threadId,
      payload.sourceCheckoutId,
      payload.branch,
      typeof payload.baseRef === 'string' ? payload.baseRef : undefined,
      isRecord(payload.options) ? payload.options as Record<string, JsonValue> : undefined,
    )
    return asJson({ checkoutId: checkout.id, kind: checkout.kind, branch: checkout.branch })
  })
  ctx.on('codex/turn/prepare', async (_draft: TurnDraft, next) => {
    const prepared = await next()
    const target = registry.targetForThread(prepared.threadId)
    if (!target) return prepared
    return {
      ...prepared,
      ...(target.kind === 'local' ? { cwd: target.location } : {}),
      additionalContext: {
        ...prepared.additionalContext,
        alto_work_target: {
          kind: 'application',
          value: target.kind === 'local'
            ? localExecutionContext(target)
            : remoteExecutionContext(target),
        },
      },
    }
  })

  const refresh = (): void => {
    void registry.refresh()
  }
  ctx.on('projects/changed', refresh)
  ctx.effect(() => {
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'workContexts.refreshTimer')
}

workContexts.inject = ['clientExtensions', 'program', 'projects', 'turnProgram', 'processRunner', 'gitSupport']
workContexts.provide = 'workContexts'

export default workContexts
