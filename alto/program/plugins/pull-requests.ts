import type { ProcessRunnerService } from './process-runner-api.js'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { readPullRequestCache, writePullRequestCache } from './pull-requests-cache.js'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import type { JsonValue } from '../../src/shared/protocol.js'
import { EMPTY_PR_SNAPSHOT, PR_REFRESH, PR_REFRESH_INTERVAL, PR_STATE, type OpenPullRequest, type PullRequestData, type PullRequestSnapshot } from './pull-requests-api.js'

const execFileAsync = promisify(execFile)
export const OPEN_PULL_REQUESTS_QUERY = `query AltoOpenPullRequests($cursor: String) {
  viewer {
    login
    pullRequests(first: 20, after: $cursor, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title isDraft createdAt updatedAt headRefName baseRefName mergeable mergeStateStatus reviewDecision
        body additions deletions changedFiles
        repository { nameWithOwner }
        headRepository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        reviewThreads(first: 30) { nodes { isResolved } pageInfo { hasNextPage } }
      }
    }
  }
}`

const repositorySchema = z.object({ nameWithOwner: z.string().regex(/^[a-z\d][a-z\d-]*\/[\w.-]+$/iu).refine((value) => !['.', '..'].includes(value.split('/')[1] ?? '')) })
const responseSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z.object({ viewer: z.object({
    login: z.string().min(1),
    pullRequests: z.object({
      totalCount: z.number().int().nonnegative(),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(z.object({
        body: z.string().optional(), additions: z.number().int().nonnegative().optional(), deletions: z.number().int().nonnegative().optional(), changedFiles: z.number().int().nonnegative().optional(),
        id: z.string(), number: z.number().int().positive(), title: z.string(), isDraft: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
        headRefName: z.string(), baseRefName: z.string(), mergeable: z.string(), mergeStateStatus: z.string(), reviewDecision: z.string().nullable(),
        repository: repositorySchema, headRepository: repositorySchema.nullable(),
        commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })) }),
        reviewThreads: z.object({ nodes: z.array(z.object({ isResolved: z.boolean() })), pageInfo: z.object({ hasNextPage: z.boolean() }) }),
      })),
    }),
  }) }),
})

export type PullRequestQuery = (cursor: string | null, signal: AbortSignal) => Promise<unknown>
async function queryGitHub(cursor: string | null, signal: AbortSignal, runner?: ProcessRunnerService): Promise<unknown> {
  const { stdout } = await (runner ? runner.execFile.bind(runner) : execFileAsync)('gh', ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${OPEN_PULL_REQUESTS_QUERY}`, ...(cursor ? ['-f', `cursor=${cursor}`] : [])], {
    signal, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
  })
  return JSON.parse(stdout) as unknown
}

export async function fetchOpenPullRequests(signal: AbortSignal, query: PullRequestQuery = queryGitHub, progress?: (data: PullRequestData) => void): Promise<PullRequestData> {
  let cursor: string | null = null
  let viewer = ''
  let total = 0
  const items = new Map<string, OpenPullRequest>()
  const cursors = new Set<string>()
  for (let page = 0; page < 100; page += 1) {
    signal.throwIfAborted()
    const response = responseSchema.parse(await query(cursor, signal))
    signal.throwIfAborted()
    if (response.errors?.length) throw new Error('GitHub returned incomplete pull request data')
    const current = response.data.viewer
    if (viewer && current.login !== viewer) throw new Error('GitHub account changed during refresh')
    viewer = current.login
    total = current.pullRequests.totalCount
    for (const pr of current.pullRequests.nodes) {
      items.set(pr.id, {
        id: pr.id, number: pr.number, title: pr.title,
        ...(pr.body === undefined ? {} : { description: pr.body.slice(0, 8_000), additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles }), url: `https://github.com/${pr.repository.nameWithOwner}/pull/${pr.number}`,
        repository: pr.repository.nameWithOwner, headRepository: pr.headRepository?.nameWithOwner ?? null,
        branch: pr.headRefName, baseBranch: pr.baseRefName, draft: pr.isDraft, createdAt: pr.createdAt, updatedAt: pr.updatedAt, review: pr.reviewDecision,
        checks: pr.commits.nodes.length === 0 ? 'UNKNOWN' : pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
        mergeable: pr.mergeable, mergeState: pr.mergeStateStatus,
        unresolvedThreads: pr.reviewThreads.nodes.filter((thread) => !thread.isResolved).length, moreThreads: pr.reviewThreads.pageInfo.hasNextPage,
      })
    }
    progress?.({ viewer, total, items: [...items.values()], complete: false })
    const next = current.pullRequests.pageInfo
    if (!next.hasNextPage) return { viewer, total, items: [...items.values()], complete: true }
    if (!next.endCursor || cursors.has(next.endCursor)) throw new Error('GitHub pagination did not advance')
    cursors.add(next.endCursor)
    cursor = next.endCursor
  }
  return { viewer, total, items: [...items.values()], complete: false }
}

export class PullRequestCache {
  private value: PullRequestSnapshot = { ...EMPTY_PR_SNAPSHOT }
  private pending: Promise<void> | undefined
  private lastAttempt: number | null = null
  private disposed = false
  private readonly controller = new AbortController()
  constructor(private readonly publish: (snapshot: PullRequestSnapshot) => void, private readonly load: (signal: AbortSignal, progress?: (data: PullRequestData) => void) => Promise<PullRequestData> = (signal, progress) => fetchOpenPullRequests(signal, queryGitHub, progress), private readonly now = Date.now) {}
  snapshot(): PullRequestSnapshot { return this.value }
  restore(snapshot: PullRequestSnapshot): void {
    if (this.pending || this.value.fetchedAt !== null) return
    this.update(snapshot)
  }
  private update(next: PullRequestSnapshot): void {
    if (this.disposed) return
    this.value = next
    this.publish(next)
  }
  refresh(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.pending) return this.pending
    if (!force && this.lastAttempt !== null && this.now() - this.lastAttempt < PR_REFRESH_INTERVAL) return Promise.resolve()
    this.lastAttempt = this.now()
    this.update({ ...this.value, phase: 'loading', error: null })
    this.pending = Promise.resolve().then(() => this.load(this.controller.signal, (data) => {
      if (this.value.fetchedAt === null) this.update({ ...this.value, ...data, phase: 'loading' })
    })).then((data) => {
      this.update({ ...data, phase: 'ready', fetchedAt: this.now(), error: null })
    }).catch(() => {
      this.update({ ...this.value, phase: 'error', error: 'Could not refresh GitHub. Check your connection and run gh auth status --hostname github.com. Private repositories may require organization SSO authorization.' })
    }).finally(() => { this.pending = undefined })
    return this.pending
  }
  dispose(): void { this.disposed = true; this.controller.abort() }
}

const pullRequests: HarnessPlugin = (ctx) => {
  ctx.ui.register(ctx, { id: 'pull-requests-toggle', slot: 'header-right', order: 1000, nodes: [] })
  const registration = ctx.clientExtensions.registerState(ctx, PR_STATE, EMPTY_PR_SNAPSHOT as unknown as JsonValue)
  const file = path.join(ctx.program.projectRoot, '.codex-cordis', 'cache', 'pull-requests.json')
  let active = true
  let writes = Promise.resolve()
  const cache = new PullRequestCache((snapshot) => {
    registration.update(snapshot as unknown as JsonValue)
    if (snapshot.phase === 'ready') {
      writes = writes.then(async () => { if (active) await writePullRequestCache(file, snapshot) }).catch(() => {})
    }
  }, (signal, progress) => fetchOpenPullRequests(signal, (cursor, signal) => queryGitHub(cursor, signal, ctx.processRunner), progress))
  ctx.effect(() => {
    void readPullRequestCache(file).then((saved) => {
      if (!active) return
      if (saved) cache.restore(saved)
      void cache.refresh()
    })
    const timer = setInterval(() => { void cache.refresh() }, 300_000)
    return async () => { active = false; clearInterval(timer); cache.dispose(); await writes }
  }, 'pull-requests.cache')
  ctx.clientExtensions.registerMethod(ctx, PR_REFRESH, (payload) => {
    void cache.refresh(typeof payload === 'object' && payload !== null && !Array.isArray(payload) && payload.force === true)
    return null
  })
}
pullRequests.inject = ['clientExtensions', 'ui', 'program', 'processRunner']
export default pullRequests
