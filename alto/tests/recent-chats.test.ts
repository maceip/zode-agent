import { Context, type Plugin } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ClientUiService } from '../src/client/plugin-api.js'
import type { LocalProject, ThreadSummary } from '../src/shared/protocol.js'
import type { ClientHotkeysService, HotkeyAction } from '../program/plugins/hotkeys-api.js'
import recentChatsClient, {
  nextRecentThread,
  orderRecentThreads,
  RecentChatsService,
  recentChatsShortcutEnabled,
  recentSwitcherPane,
  recentThreadWorkspace,
  shouldCommitRecentGesture,
} from '../program/plugins/recent-chats.client.js'
import type {
  ClientConversationService,
  ClientSessionSnapshot,
} from '../program/plugins/session-api.js'

function thread(id: string, cwd = `/tmp/${id}`, projectId?: string): ThreadSummary {
  return {
    id,
    title: `Chat ${id}`,
    preview: `Preview ${id}`,
    cwd,
    createdAt: 1,
    updatedAt: 1,
    ...(projectId ? { projectId } : {}),
  }
}

function sessionSnapshot(): ClientSessionSnapshot {
  return {
    revision: 0,
    connected: true,
    session: { workspace: '/tmp/a', permissionMode: 'ask' },
    turn: { tag: 'idle' },
    threadId: 'a',
    agentStatus: { tag: 'idle' },
    activities: [],
    history: { tag: 'ready', entries: [] },
    threads: [thread('a'), thread('b'), thread('c')],
    projects: [],
    skills: [],
  } as unknown as ClientSessionSnapshot
}

function installWindow(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const storage = new Map<string, string>()
  const target = new EventTarget() as EventTarget & {
    localStorage: Pick<Storage, 'getItem' | 'setItem'>
  }
  target.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: target,
  })
  return () => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete (globalThis as { window?: Window }).window
  }
}

describe('Recent Chats plugin', () => {
  it('yields Control-Tab to workspace tabs when their layout is available', () => {
    expect(recentChatsShortcutEnabled(true, false)).toBe(true)
    expect(recentChatsShortcutEnabled(true, true)).toBe(false)
    expect(recentChatsShortcutEnabled(false, false)).toBe(false)
  })

  it('orders MRU chats and cycles around the visible list', () => {
    const threads = [thread('a'), thread('b'), thread('c')]
    expect(orderRecentThreads(['c', 'a'], threads).map((candidate) => candidate.id))
      .toEqual(['c', 'a', 'b'])
    expect(nextRecentThread(threads, 'a', undefined, 1)?.id).toBe('b')
    expect(nextRecentThread(threads, 'a', 'c', 1)?.id).toBe('a')
    expect(nextRecentThread(threads, 'a', undefined, -1)?.id).toBe('c')
  })

  it('uses project names and falls back to the workspace folder', () => {
    const projects: LocalProject[] = [{
      id: 'p',
      name: 'Cordis',
      roots: ['/tmp/cordis'],
      primaryRoot: '/tmp/cordis',
      source: 'manual',
    }]
    expect(recentThreadWorkspace(thread('a', '/tmp/cordis', 'p'), projects)).toBe('Cordis')
    expect(recentThreadWorkspace(thread('a', '/tmp/project-api'), projects)).toBe('project-api')
  })

  it('constrains the switcher layer to the visible conversation pane', () => {
    expect(recentSwitcherPane(246, 718, 1_200)).toEqual({ left: 246, width: 718 })
    expect(recentSwitcherPane(-20, 500, 1_200)).toEqual({ left: 0, width: 480 })
    expect(recentSwitcherPane(900, 500, 1_200)).toEqual({ left: 900, width: 300 })
  })

  it('commits when Control is released or Tab arrives without Control held', () => {
    expect(shouldCommitRecentGesture({ key: 'Control', code: 'ControlLeft', ctrlKey: false })).toBe(true)
    expect(shouldCommitRecentGesture({ key: 'Tab', code: 'Tab', ctrlKey: false })).toBe(true)
    expect(shouldCommitRecentGesture({ key: 'Tab', code: 'Tab', ctrlKey: true })).toBe(false)
  })

  it('previews the selection and opens it only when committed', () => {
    const restoreWindow = installWindow()
    const openThread = vi.fn().mockResolvedValue(undefined)
    const prefetchThread = vi.fn().mockResolvedValue(undefined)
    const session = {
      snapshot: sessionSnapshot,
      subscribe: () => () => undefined,
      openThread,
      prefetchThread,
    } as unknown as ClientConversationService
    const service = new RecentChatsService(session, { previewLimit: 3 })

    try {
      service.cycle(1)
      expect(service.snapshot().selectedThreadId).toBe('b')
      expect(openThread).not.toHaveBeenCalled()
      service.cycle(1)
      expect(service.snapshot().selectedThreadId).toBe('c')
      service.commit()
      expect(service.snapshot().selectedThreadId).toBeUndefined()
      expect(openThread).toHaveBeenCalledWith(thread('c'))
      expect(prefetchThread).not.toHaveBeenCalled()
    } finally {
      service.dispose()
      restoreWindow()
    }
  })

  it('shows only the ten most recent chats by default', () => {
    const restoreWindow = installWindow()
    const threads = Array.from({ length: 15 }, (_, index) => thread(String(index)))
    const session = {
      snapshot: () => ({
        ...sessionSnapshot(),
        threadId: '0',
        threads,
      }),
      subscribe: () => () => undefined,
      openThread: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClientConversationService
    const service = new RecentChatsService(session, {})

    try {
      expect(service.snapshot().recent.map((candidate) => candidate.id))
        .toEqual(Array.from({ length: 10 }, (_, index) => String(index)))
    } finally {
      service.dispose()
      restoreWindow()
    }
  })

  it('ignores transcript-only session updates', () => {
    const restoreWindow = installWindow()
    let current = sessionSnapshot()
    let notify = (): void => undefined
    const session = {
      snapshot: () => current,
      subscribe: (listener: () => void) => {
        notify = listener
        return () => undefined
      },
      openThread: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClientConversationService
    const service = new RecentChatsService(session, {})
    const changed = vi.fn()
    const unsubscribe = service.subscribe(changed)

    try {
      current = { ...current, revision: 1, activities: [...current.activities] }
      notify()
      expect(changed).not.toHaveBeenCalled()

      current = { ...current, turn: { tag: 'running' } }
      notify()
      expect(changed).toHaveBeenCalledOnce()
    } finally {
      unsubscribe()
      service.dispose()
      restoreWindow()
    }
  })

  it('keeps one stable candidate order until Control is released or cancelled', () => {
    const restoreWindow = installWindow()
    let current = {
      ...sessionSnapshot(),
      threads: [thread('a'), thread('b'), thread('c'), thread('d')],
    }
    let notify = (): void => undefined
    const session = {
      snapshot: () => current,
      subscribe: (listener: () => void) => {
        notify = listener
        return () => undefined
      },
      openThread: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClientConversationService
    const service = new RecentChatsService(session, { previewLimit: 4 })

    try {
      service.cycle(1)
      expect(service.snapshot().selectedThreadId).toBe('b')

      current = { ...current, threads: [thread('a'), thread('d'), thread('c'), thread('b')] }
      notify()
      expect(service.snapshot().recent.map((candidate) => candidate.id))
        .toEqual(['a', 'b', 'c', 'd'])

      service.cycle(1)
      expect(service.snapshot().selectedThreadId).toBe('c')
      service.cancel()
      service.cycle(1)
      expect(service.snapshot().selectedThreadId).toBe('d')
    } finally {
      service.dispose()
      restoreWindow()
    }
  })

  it('advances from a pending destination when gestures happen back to back', () => {
    const restoreWindow = installWindow()
    const openThread = vi.fn(() => new Promise<void>(() => undefined))
    const session = {
      snapshot: sessionSnapshot,
      subscribe: () => () => undefined,
      openThread,
    } as unknown as ClientConversationService
    const service = new RecentChatsService(session, { previewLimit: 3 })

    try {
      service.cycle(1)
      expect(service.snapshot().selectedThreadId).toBe('b')
      service.commit()
      expect(openThread).toHaveBeenNthCalledWith(1, thread('b'))

      service.cycle(1)
      expect(service.snapshot().selectedThreadId).toBe('c')
      service.commit()
      expect(openThread).toHaveBeenNthCalledWith(2, thread('c'))
    } finally {
      service.dispose()
      restoreWindow()
    }
  })

  it('unloads only its shortcuts, UI, and service', async () => {
    const restoreWindow = installWindow()
    const context = new Context()
    const actions = new Map<string, HotkeyAction>([[
      'hotkeys.open',
      {
        id: 'hotkeys.open',
        label: 'Hotkey control',
        category: 'Panels',
        binding: { kind: 'leader', key: '?' },
        run: () => undefined,
      },
    ]])
    const roots = new Set<string>()
    const styles = new Set<string>()
    const hotkeys = {
      registerAction: (owner: Context, action: HotkeyAction) => {
        const dispose = owner.effect(() => {
          actions.set(action.id, action)
          return () => actions.delete(action.id)
        }, `test.hotkey(${action.id})`)
        return { dispose: async () => dispose() }
      },
    } as unknown as ClientHotkeysService
    const session = {
      snapshot: sessionSnapshot,
      subscribe: () => () => undefined,
      openThread: vi.fn().mockResolvedValue(undefined),
      prefetchThread: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClientConversationService
    const ui = {
      registerRoot: (owner: Context, id: string) => {
        const dispose = owner.effect(() => {
          roots.add(id)
          return () => roots.delete(id)
        }, `test.root(${id})`)
        return { update: vi.fn(), dispose: async () => dispose() }
      },
      registerStyle: (owner: Context, id: string) => {
        const dispose = owner.effect(() => {
          styles.add(id)
          return () => styles.delete(id)
        }, `test.style(${id})`)
        return { update: vi.fn(), dispose: async () => dispose() }
      },
    } as unknown as ClientUiService
    const hotkeysProvider: Plugin = (ctx) => ctx.provide('clientHotkeys', hotkeys)
    hotkeysProvider.provide = 'clientHotkeys'
    const sessionProvider: Plugin = (ctx) => ctx.provide('clientConversation', session)
    sessionProvider.provide = 'clientConversation'
    const uiProvider: Plugin = (ctx) => ctx.provide('clientUi', ui)
    uiProvider.provide = 'clientUi'
    let consumerActive = false
    const consumer: Plugin = (ctx) => ctx.effect(() => {
      void ctx.clientRecentChats
      consumerActive = true
      return () => {
        consumerActive = false
      }
    })
    consumer.inject = ['clientRecentChats']

    const recentFiber = context.plugin(recentChatsClient, { previewLimit: 3 })
    const consumerFiber = context.plugin(consumer)
    const hotkeysFiber = await context.plugin(hotkeysProvider)
    const sessionFiber = await context.plugin(sessionProvider)
    const uiFiber = await context.plugin(uiProvider)

    try {
      await recentFiber.await()
      await consumerFiber.await()
      expect(consumerActive).toBe(true)
      expect(roots).toEqual(new Set(['recent-chats']))
      expect(styles).toEqual(new Set(['recent-chats']))
      expect([...actions.keys()]).toEqual([
        'hotkeys.open',
        'recent-chats.next',
        'recent-chats.previous',
      ])

      await recentFiber.dispose()
      await consumerFiber.await()
      expect(consumerActive).toBe(false)
      expect(roots.size).toBe(0)
      expect(styles.size).toBe(0)
      expect([...actions.keys()]).toEqual(['hotkeys.open'])
    } finally {
      await consumerFiber.dispose()
      await uiFiber.dispose()
      await sessionFiber.dispose()
      await hotkeysFiber.dispose()
      restoreWindow()
    }
  })
})
