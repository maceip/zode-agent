import { describe, expect, it, vi } from 'vitest'
import type { ClientHostService } from '../src/client/plugin-api.js'
import type { ThreadSummary, ThreadView } from '../src/shared/protocol.js'
import {
  readActiveThreadId,
  RoutedSessionService,
  SessionResources,
  SessionService,
  writeActiveThreadId,
} from '../program/plugins/session.client.js'

function thread(updatedAt = 5): ThreadSummary {
  return {
    id: 'thread-a',
    title: 'Cached chat',
    preview: 'Cached preview',
    cwd: '/tmp/project',
    createdAt: 1,
    updatedAt,
  }
}

function view(updatedAt = 5, olderCursor?: string): ThreadView {
  return {
    summary: thread(updatedAt),
    messages: [{
      id: 'message-a',
      role: 'user',
      text: 'Cached prompt',
    }],
    ...(olderCursor ? { olderCursor } : {}),
  }
}

function host(openThread: ReturnType<typeof vi.fn>): ClientHostService {
  return {
    snapshot: () => ({
      revision: 0,
      connection: 'online',
      connected: true,
    }),
    subscribe: () => () => undefined,
    onEvent: () => () => undefined,
    journal: () => [],
    command: openThread,
    call: vi.fn(),
  } as unknown as ClientHostService
}

function readyHost(command: ReturnType<typeof vi.fn>): ClientHostService {
  return {
    snapshot: () => ({
      revision: 0,
      connection: 'online',
      connected: true,
      snapshot: {
        codex: { status: 'ready', models: [] },
        program: {
          revision: 0,
          profileText: '',
          plugins: [],
          files: [],
          tools: [],
          proposals: [],
        },
        projects: { revision: 0, projects: [] },
        ui: { regions: [], surfaces: [], contributions: [] },
        extensions: { 'session.workspace': '/tmp/alto-scratch' },
        pendingRequests: [],
        server: { port: 4317, host: '127.0.0.1', projectRoot: '/tmp/project' },
      },
    }),
    subscribe: () => () => undefined,
    onEvent: () => () => undefined,
    journal: () => [],
    command,
    call: vi.fn(),
  } as unknown as ClientHostService
}

describe('session thread cache', () => {
  it('coalesces shared history and skill requests across mounted panes', async () => {
    const command = vi.fn(async (type: string) => {
      if (type === 'thread.list') return [thread()]
      if (type === 'skill.list') return []
      throw new Error(`unexpected command: ${type}`)
    })
    const resources = new SessionResources(readyHost(command))
    const historyToken = {}
    const skillsToken = {}

    await Promise.all([
      resources.listThreads(200, historyToken),
      resources.listThreads(200, historyToken),
      resources.listSkills('/tmp/project', skillsToken),
      resources.listSkills('/tmp/project', skillsToken),
    ])
    await resources.listThreads(200, historyToken)
    await resources.listSkills('/tmp/project', skillsToken)

    expect(command.mock.calls.filter(([type]) => type === 'thread.list')).toHaveLength(1)
    expect(command.mock.calls.filter(([type]) => type === 'skill.list')).toHaveLength(1)

    await resources.listThreads(200, {})
    await resources.listSkills('/tmp/project', {})
    expect(command.mock.calls.filter(([type]) => type === 'thread.list')).toHaveLength(2)
    expect(command.mock.calls.filter(([type]) => type === 'skill.list')).toHaveLength(2)
  })

  it('runs one follow-up refresh when a newer invalidation arrives in flight', async () => {
    const pending: Array<(value: ThreadSummary[]) => void> = []
    const command = vi.fn((type: string) => {
      if (type !== 'thread.list') throw new Error(`unexpected command: ${type}`)
      return new Promise<ThreadSummary[]>((resolve) => pending.push(resolve))
    })
    const resources = new SessionResources(readyHost(command))
    const first = resources.listThreads(200, { revision: 1 })
    const second = resources.listThreads(200, { revision: 2 })

    expect(command).toHaveBeenCalledTimes(1)
    pending.shift()?.([thread(1)])
    await expect(first).resolves.toEqual([thread(1)])
    await Promise.resolve()
    expect(command).toHaveBeenCalledTimes(2)
    pending.shift()?.([thread(2)])

    await expect(second).resolves.toEqual([thread(2)])
  })

  it('coalesces concurrent thread loads shared by pane sessions', async () => {
    let finish: ((value: ThreadView) => void) | undefined
    const command = vi.fn((type: string) => {
      if (type !== 'thread.open') throw new Error(`unexpected command: ${type}`)
      return new Promise<ThreadView>((resolve) => { finish = resolve })
    })
    const resources = new SessionResources(host(command))
    const options = {
      workspace: '/tmp/project',
      permissionMode: 'ask' as const,
    }

    const first = resources.openThread(thread(), options)
    const second = resources.openThread(thread(), options)
    expect(command).toHaveBeenCalledTimes(1)
    finish?.(view())

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('promotes authoritative thread metadata when a prefetched transcript matches', async () => {
    const listed = thread()
    const resumed: ThreadSummary = {
      ...listed,
      gitInfo: {
        branch: 'jm/supply-chain-security',
        sha: '7ebc8382',
      },
    }
    const messages: ThreadView['messages'] = [{
      id: 'message-a',
      role: 'user',
      text: 'Cached prompt',
    }]
    const command = vi.fn(async (type: string) => {
      if (type === 'thread.page') return { messages }
      if (type === 'thread.open') return { summary: resumed, messages }
      throw new Error(`unexpected command: ${type}`)
    })
    const resources = new SessionResources(host(command))
    const session = new SessionService(host(command), {
      restoreActiveThread: false,
      persistActiveThread: false,
    }, resources)

    try {
      await session.prefetchThread(listed)
      await session.openThread(listed)

      expect(session.snapshot().threads.find(({ id }) => id === listed.id)?.gitInfo)
        .toEqual(resumed.gitInfo)
      expect(session.snapshot().history.entries.find(({ id }) => id === listed.id)?.gitInfo)
        .toEqual(resumed.gitInfo)
    } finally {
      session.dispose()
      resources.clear()
    }
  })

  it('routes app-wide session reads and actions to the focused pane without reopening it', () => {
    const base = new SessionService(host(vi.fn()))
    const pane = new SessionService(host(vi.fn()), {
      initialWorkspace: '/work/pane',
      restoreActiveThread: false,
      persistActiveThread: false,
    })
    const router = new RoutedSessionService(base)

    try {
      router.setActive('view-a:pane-a', pane)
      expect(router.activeKey()).toBe('view-a:pane-a')
      expect(router.snapshot().session.workspace).toBe('/work/pane')
      expect(router.globalSession()).toBe(base)

      router.setPermissionMode('full')
      expect(pane.snapshot().session.permissionMode).toBe('full')
      expect(base.snapshot().session.permissionMode).toBe('ask')

      router.clearActive('view-a:pane-a')
      expect(router.snapshot()).toBe(base.snapshot())
    } finally {
      router.dispose()
      pane.dispose()
      base.dispose()
    }
  })

  it('starts a blank chat in the explicitly selected workspace', () => {
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
    const session = new SessionService(readyHost(vi.fn()))

    try {
      session.newThread({
        id: 'atlas',
        name: 'atlas',
        primaryRoot: '/work/atlas',
        roots: ['/work/atlas'],
      })

      expect(session.snapshot().session.workspace).toBe('/work/atlas')
      expect(session.snapshot().projectScope).toBe('workspace')
      expect(session.snapshot().threadId).toBeUndefined()
      expect(session.snapshot().activities).toEqual([])

      session.newThread()

      expect(session.snapshot().session.workspace).toBe('/tmp/alto-scratch')
      expect(session.snapshot().projectScope).toBe('unscoped')
      expect(session.snapshot().activeProjectId).toBeUndefined()
    } finally {
      session.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('materializes an empty thread at a selected worktree before the first message', async () => {
    const command = vi.fn(async (type: string) => {
      if (type === 'thread.new') return { thread: { id: 'thread-worktree' } }
      throw new Error(`unexpected command: ${type}`)
    })
    const session = new SessionService(host(command), {
      initialWorkspace: '/work/repo',
      restoreActiveThread: false,
      persistActiveThread: false,
    })

    try {
      await expect(session.ensureThread('/work/repo-feature')).resolves.toBe('thread-worktree')
      expect(command).toHaveBeenCalledWith('thread.new', expect.objectContaining({
        workspace: '/work/repo-feature',
      }))
      expect(session.snapshot()).toMatchObject({
        threadId: 'thread-worktree',
        session: { workspace: '/work/repo-feature' },
      })
      await expect(session.ensureThread('/work/ignored')).resolves.toBe('thread-worktree')
      expect(command).toHaveBeenCalledTimes(1)
    } finally {
      session.dispose()
    }
  })

  it('retargets only a blank chat and refuses to move an existing thread', async () => {
    const open = vi.fn(async () => view())
    const session = new SessionService(host(open))
    const atlas = {
      id: 'atlas',
      name: 'atlas',
      primaryRoot: '/work/atlas',
      roots: ['/work/atlas'],
    }

    try {
      expect(session.retargetNewThread(atlas)).toBe(true)
      expect(session.snapshot().session.workspace).toBe('/work/atlas')

      await session.openThread(thread())

      expect(session.snapshot().threadId).toBe('thread-a')
      expect(session.snapshot().session.workspace).toBe('/tmp/project')
      expect(session.retargetNewThread(atlas)).toBe(false)
      expect(session.snapshot().threadId).toBe('thread-a')
      expect(session.snapshot().session.workspace).toBe('/tmp/project')
    } finally {
      session.dispose()
    }
  })

  it('restores the active chat after history loads and forgets it for a new chat', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: storage,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    })
    writeActiveThreadId('thread-a', storage)
    const command = vi.fn(async (type: string) => {
      if (type === 'thread.list') return [thread()]
      if (type === 'thread.open') return view()
      if (type === 'skill.list') return []
      throw new Error(`unexpected command: ${type}`)
    })
    const session = new SessionService(readyHost(command))

    try {
      await session.refreshHistory()

      expect(session.snapshot().threadId).toBe('thread-a')
      expect(session.snapshot().activities[0]?.content).toBe('Cached prompt')
      expect(command).toHaveBeenCalledWith('thread.open', expect.objectContaining({
        threadId: 'thread-a',
      }))
      expect(readActiveThreadId(storage)).toBe('thread-a')

      session.newThread()
      expect(session.snapshot().threadId).toBeUndefined()
      expect(readActiveThreadId(storage)).toBeUndefined()
    } finally {
      session.dispose()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
    }
  })

  it('keeps additional pane selection out of global active-chat storage', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: storage,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    })
    writeActiveThreadId('global-thread', storage)
    const session = new SessionService(host(vi.fn(async () => view())), {
      initialWorkspace: '/work/pane',
      restoreActiveThread: false,
      persistActiveThread: false,
    })

    try {
      expect(session.snapshot().session.workspace).toBe('/work/pane')
      await session.openThread(thread())
      expect(session.snapshot().threadId).toBe('thread-a')
      expect(readActiveThreadId(storage)).toBe('global-thread')
    } finally {
      session.dispose()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
    }
  })

  it('activates a prefetched thread immediately while resuming it in the background', async () => {
    let finishResume: ((value: ThreadView) => void) | undefined
    const command = vi.fn((type: string) => {
      if (type === 'thread.page') return Promise.resolve({
        messages: view().messages,
        olderCursor: 'older-page',
      })
      if (type === 'thread.open') return new Promise<ThreadView>((resolve) => {
        finishResume = resolve
      })
      throw new Error(`unexpected command: ${type}`)
    })
    const session = new SessionService(host(command))
    let emissions = 0
    const unsubscribe = session.subscribe(() => { emissions += 1 })

    try {
      await session.prefetchThread(thread())
      expect(command).toHaveBeenCalledTimes(1)

      const opened = session.openThread(thread())
      expect(emissions).toBe(1)
      expect(session.snapshot().threadId).toBe('thread-a')
      expect(session.snapshot().activities[0]?.content).toBe('Cached prompt')
      expect(session.snapshot().hasEarlierActivities).toBe(true)
      expect(command).toHaveBeenCalledWith('thread.open', expect.objectContaining({
        threadId: 'thread-a',
      }))
      finishResume?.(view())
      await opened
      expect(command).toHaveBeenCalledTimes(2)
      expect(emissions).toBe(1)
    } finally {
      unsubscribe()
      session.dispose()
    }
  })

  it('revalidates a cached thread when its summary version advances', async () => {
    const command = vi.fn((type: string) => type === 'thread.page'
      ? Promise.resolve({ messages: view(5).messages })
      : Promise.resolve(view(6)))
    const session = new SessionService(host(command))

    try {
      await session.prefetchThread(thread(5))
      await session.openThread(thread(6))
      expect(command).toHaveBeenCalledTimes(2)
    } finally {
      session.dispose()
    }
  })

  it('prepends older pages without replacing the active chat', async () => {
    const command = vi.fn((type: string) => {
      if (type === 'thread.open') return Promise.resolve(view(5, 'older-page'))
      if (type === 'thread.page') return Promise.resolve({
        messages: [{ id: 'message-older', role: 'user', text: 'Earlier prompt' }],
      })
      throw new Error(`unexpected command: ${type}`)
    })
    const session = new SessionService(host(command))

    try {
      await session.openThread(thread())
      expect(session.snapshot().hasEarlierActivities).toBe(true)

      await session.loadEarlierActivities()

      expect(session.snapshot().threadId).toBe('thread-a')
      expect(session.snapshot().activities.map((activity) => activity.content)).toEqual([
        'Earlier prompt',
        'Cached prompt',
      ])
      expect(session.snapshot().hasEarlierActivities).toBe(false)
      expect(session.snapshot().loadingEarlierActivities).toBe(false)
      expect(command).toHaveBeenLastCalledWith('thread.page', {
        threadId: 'thread-a',
        cursor: 'older-page',
        limit: 24,
      })
    } finally {
      session.dispose()
    }
  })
})
