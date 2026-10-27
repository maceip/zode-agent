import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPullRequestCache, writePullRequestCache } from '../program/plugins/pull-requests-cache.js'
import { pullRequestViewStore } from '../program/plugins/pull-requests-store.js'
import { PullRequestCache } from '../program/plugins/pull-requests.js'
import { EMPTY_PR_SNAPSHOT, PR_STATE, type PullRequestSnapshot } from '../program/plugins/pull-requests-api.js'
import type { ClientHostService, ClientHostSnapshot } from '../src/client/plugin-api.js'
import type { HarnessSnapshot } from '../src/shared/protocol.js'

const now = Date.now()
const saved: PullRequestSnapshot = {
  phase: 'ready', error: null, fetchedAt: now, viewer: 'example', total: 1, complete: true,
  items: [{ id: 'one', number: 1, title: 'Example', url: 'https://github.com/example/repo/pull/1',
    repository: 'example/repo', headRepository: 'example/repo', branch: 'topic', baseBranch: 'main',
    draft: false, createdAt: new Date(now - 86_400_000).toISOString(), updatedAt: new Date(now).toISOString(), review: 'APPROVED', checks: 'SUCCESS',
    mergeable: 'MERGEABLE', mergeState: 'CLEAN', unresolvedThreads: 0, moreThreads: false,
    description: 'The description', additions: 2, deletions: 1, changedFiles: 1 }],
}

describe('persisted PR results', () => {
  const directories: string[] = []
  afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })
  async function file() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'alto-pr-cache-'))
    directories.push(dir)
    return path.join(dir, 'cache', 'pull-requests.json')
  }
  it('restores results and descriptions across restarts with a private cache file', async () => {
    const target = await file()
    await writePullRequestCache(target, saved)
    expect(await readPullRequestCache(target, now)).toMatchObject(saved)
    expect((await stat(target)).mode & 0o777).toBe(0o600)
  })
  it('does not restore expired, future, or corrupt data', async () => {
    const target = await file()
    await writePullRequestCache(target, saved)
    expect(await readPullRequestCache(target, now + 86_400_001)).toBeNull()
    expect(await readPullRequestCache(target, now - 1)).toBeNull()
    await writeFile(target, '{')
    expect(await readPullRequestCache(target)).toBeNull()
  })
  it('can restore older cache entries without creation dates', async () => {
    const target = await file()
    await writePullRequestCache(target, saved)
    const raw = JSON.parse(await readFile(target, 'utf8'))
    delete raw.items[0].createdAt
    await writeFile(target, JSON.stringify(raw))
    const restored = await readPullRequestCache(target, now)
    expect(restored?.items).toHaveLength(1)
    expect(restored?.items[0]?.createdAt).toBeUndefined()
  })
  it('reconstructs safe links instead of trusting stored URLs', async () => {
    const target = await file()
    await writePullRequestCache(target, saved)
    const raw = JSON.parse(await readFile(target, 'utf8'))
    raw.items[0].url = 'javascript:alert(1)'
    await writeFile(target, JSON.stringify(raw))
    expect((await readPullRequestCache(target, now))?.items[0]?.url).toBe(saved.items[0]?.url)
    raw.items[0].repository = '../bad'
    await writeFile(target, JSON.stringify(raw))
    expect(await readPullRequestCache(target, now)).toBeNull()
  })
  it('persists an empty successful response but never an in-progress fetch', async () => {
    const target = await file()
    await writePullRequestCache(target, saved)
    await writePullRequestCache(target, { ...saved, phase: 'loading', items: [] })
    expect((await readPullRequestCache(target, now))?.items).toHaveLength(1)
    await writePullRequestCache(target, { ...saved, items: [], total: 0 })
    expect((await readPullRequestCache(target, now))?.items).toHaveLength(0)
  })
  it('keeps the restored list visible while refreshing and does not restore over fresh results', async () => {
    let complete: ((data: typeof saved) => void) | undefined
    const load = vi.fn(() => new Promise<typeof saved>((resolve) => { complete = resolve }))
    const cache = new PullRequestCache(vi.fn(), load)
    cache.restore(saved)
    const pending = cache.refresh()
    await Promise.resolve()
    expect(cache.snapshot()).toMatchObject({ phase: 'loading', items: saved.items })
    cache.restore({ ...saved, items: [] })
    expect(cache.snapshot().items).toHaveLength(1)
    complete?.({ ...saved, items: [], total: 0 })
    await pending
    cache.restore(saved)
    expect(cache.snapshot().items).toHaveLength(0)
    cache.dispose()
  })
})

describe('PR rendering subscription', () => {
  it('ignores unrelated chat events and cloned extension snapshots', () => {
    let state = { connected: true, revision: 1, snapshot: { extensions: { [PR_STATE]: saved } } } as unknown as ClientHostSnapshot
    const store = pullRequestViewStore({ snapshot: () => state, subscribe: () => () => {} } as unknown as ClientHostService)
    const first = store.snapshot()
    state = { ...state, revision: 2 }
    expect(store.snapshot()).toBe(first)
    state = { ...state, snapshot: { extensions: { [PR_STATE]: structuredClone(saved) } } as unknown as HarnessSnapshot }
    expect(store.snapshot()).toBe(first)
    state = { ...state, snapshot: { extensions: { [PR_STATE]: { ...saved, fetchedAt: now + 1 } } } as unknown as HarnessSnapshot }
    expect(store.snapshot()).not.toBe(first)
  })
  it('publishes progressive results before the first complete refresh', () => {
    let snapshot = EMPTY_PR_SNAPSHOT
    const store = pullRequestViewStore({ snapshot: () => ({ connected: true, snapshot: { extensions: { [PR_STATE]: snapshot } } }), subscribe: () => () => {} } as unknown as ClientHostService)
    const first = store.snapshot()
    snapshot = { ...saved, phase: 'loading', complete: false, fetchedAt: null }
    expect(store.snapshot()).not.toBe(first)
    expect(store.snapshot().snapshot.items).toHaveLength(1)
  })
})
