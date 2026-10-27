import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import workContexts, { WorkContextRegistry } from '../program/plugins/work-contexts.js'
import { GitSupportRegistry } from '../program/plugins/git-support.js'
import type { ProcessOptions } from '../program/plugins/process-runner-api.js'

describe('worktree discovery and shared Git status', () => {
  const cleanups: Array<() => void | Promise<void>> = []
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T18:00:00Z')) })
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    vi.useRealTimers()
  })

  async function fixture() {
    const temporary = await mkdtemp(path.join(tmpdir(), 'alto-status-'))
    cleanups.push(() => rm(temporary, { recursive: true, force: true }))
    const roots = Array.from({ length: 50 }, (_, index) => `/repo-${index}`)
    const branches = new Map(roots.map((root, index) => [root, `branch-${index}`]))
    const heads = new Map(roots.map((root) => [root, '0123456789abcdef']))
    const files = new Map<string, string>()
    let failStatus = false
    const execFile = vi.fn(async (_file: string, args: string[], _options?: ProcessOptions) => {
      const cwd = args[1]!
      const command = args.slice(2).join(' ')
      let stdout: string
      if (command === 'worktree list --porcelain') {
        stdout = roots.map((root) => `worktree ${root}\nHEAD ${heads.get(root)}\n${branches.get(root) ? `branch refs/heads/${branches.get(root)}` : 'detached'}\n`).join('\n')
      } else if (command === 'remote get-url origin') stdout = 'git@github.com:example/repo.git'
      else if (command === 'rev-parse --show-toplevel') stdout = cwd
      else if (command === 'branch --show-current') stdout = branches.get(cwd)!
      else if (command === 'rev-parse --short HEAD') stdout = heads.get(cwd)!.slice(0, 7)
      else if (command.startsWith('status ')) {
        if (failStatus) throw new Error('status timed out')
        stdout = files.get(cwd) ?? ''
      } else throw new Error(`unavailable Git command: ${command}`)
      return { stdout, stderr: '' }
    })
    const update = vi.fn()
    const owner = {
      program: { projectRoot: temporary },
      projects: { snapshot: () => ({ projects: [{ id: 'repo', name: 'repo', primaryRoot: roots[0], roots }] }) },
      processRunner: { execFile },
      clientExtensions: { registerState: () => ({ update }), registerMethod: vi.fn() },
      effect: (setup: () => () => void) => { const cleanup = setup(); cleanups.push(cleanup); return cleanup },
      on: vi.fn(),
      provide(name: string, service: unknown) { Object.assign(this, { [name]: service }) },
    } as unknown as Context
    Object.assign(owner, { gitSupport: new GitSupportRegistry(owner, 4_000, 45_000) })
    const registry = new WorkContextRegistry(owner)
    await registry.start(owner)
    return { owner, registry, execFile, branches, heads, files, update, roots,
      failStatus: () => { failStatus = true },
      statuses: () => execFile.mock.calls.filter(([, args]) => args[2] === 'status'),
    }
  }

  it('discovers fifty worktrees without scanning their files, even on explicit refresh', async () => {
    const run = await fixture()
    expect(run.registry.snapshot().workstreams).toHaveLength(50)
    expect(run.execFile).toHaveBeenCalledTimes(2)
    expect(run.statuses()).toHaveLength(0)
    await run.registry.refresh()
    expect(run.statuses()).toHaveLength(0)
    expect(run.registry.snapshot().workstreams.every((stream) => stream.checkouts[0]?.dirty === undefined)).toBe(true)
    for (const [, , options] of run.execFile.mock.calls) expect(options?.env?.GIT_OPTIONAL_LOCKS).toBe('0')
  })

  it('reuses a Git badge inspection and leaves inactive worktrees unscanned', async () => {
    const run = await fixture()
    run.files.set('/repo-0', ' M changed.md\0')
    await run.owner.gitSupport.inspect('/repo-0')
    const count = run.execFile.mock.calls.length
    await Promise.all([
      run.registry.refreshLocalCheckout('/repo-0'),
      run.registry.refreshLocalCheckout('/repo-0/nested'),
    ])
    expect(run.execFile).toHaveBeenCalledTimes(count)
    expect(run.statuses()).toHaveLength(1)
    expect(run.registry.checkout(run.registry.localCheckoutForPath('/repo-0')!.id)?.dirty).toBe(true)
    expect(run.registry.checkout(run.registry.localCheckoutForPath('/repo-1')!.id)?.dirty).toBeUndefined()
  })

  it('deduplicates concurrent status reads through the existing Git service', async () => {
    const run = await fixture()
    await Promise.all(Array.from({ length: 12 }, () => run.registry.refreshLocalCheckout('/repo-0')))
    expect(run.statuses()).toHaveLength(1)
    expect(run.registry.checkout(run.registry.localCheckoutForPath('/repo-0')!.id)?.dirty).toBe(false)
  })

  it('shares an in-flight status scan with a Git badge also loading remote metadata', async () => {
    const run = await fixture()
    await Promise.all([
      run.owner.gitSupport.inspect('/repo-0', { includeRemote: true }),
      run.registry.refreshLocalCheckout('/repo-0'),
    ])
    expect(run.statuses()).toHaveLength(1)
  })

  it('clears failed and expired status without reviving a persisted dirty flag', async () => {
    const run = await fixture()
    run.files.set('/repo-0', '?? new.md\0')
    await run.registry.refreshLocalCheckout('/repo-0')
    const checkout = run.registry.checkout(run.registry.localCheckoutForPath('/repo-0')!.id)!
    await run.registry.setThreadTarget('chat', checkout)
    expect(run.registry.targetForThread('chat')?.dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(90_001)
    expect(run.registry.targetForThread('chat')?.dirty).toBeUndefined()
    run.failStatus()
    await run.registry.refreshLocalCheckout('/repo-0', true)
    expect(run.registry.targetForThread('chat')?.dirty).toBeUndefined()
  })

  it('refreshes branch topology after a targeted status read notices a checkout change', async () => {
    const run = await fixture()
    const id = run.registry.localCheckoutForPath('/repo-0')!.id
    run.branches.set('/repo-0', 'new-branch')
    run.heads.set('/repo-0', 'fedcba9876543210')
    await run.registry.refreshLocalCheckout('/repo-0')
    expect(run.registry.checkout(id)).toMatchObject({ branch: 'new-branch', head: 'fedcba9876543210', dirty: false })
    expect(run.statuses()).toHaveLength(1)
  })

  it('never scans an unregistered path', async () => {
    const run = await fixture()
    const count = run.execFile.mock.calls.length
    await run.registry.refreshLocalCheckout('/unregistered')
    expect(run.execFile).toHaveBeenCalledTimes(count)
  })

  it('recognizes detached HEAD across the two services without rediscovering every checkout', async () => {
    const run = await fixture()
    run.branches.set('/repo-0', '')
    await run.registry.refresh()
    run.execFile.mockClear()
    await run.registry.refreshLocalCheckout('/repo-0')
    const checkout = run.registry.checkout(run.registry.localCheckoutForPath('/repo-0')!.id)
    expect(checkout).toMatchObject({ branch: 'detached/01234567', dirty: false })
    expect(run.execFile.mock.calls.some(([, args]) => args[2] === 'worktree')).toBe(false)
  })

  it('uses only inexpensive topology discovery for the five-minute fallback', async () => {
    const run = await fixture()
    await (workContexts as (ctx: Context) => Promise<void>)(run.owner)
    run.execFile.mockClear()
    await vi.advanceTimersByTimeAsync(299_999)
    expect(run.execFile).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run.execFile).toHaveBeenCalledTimes(2)
    expect(run.statuses()).toHaveLength(0)
  })
})
