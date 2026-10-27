import { Context, type Plugin } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ClientUiService } from '../src/client/plugin-api.js'
import type { ThreadSummary } from '../src/shared/protocol.js'
import type { ClientHotkeysService, HotkeyAction } from '../program/plugins/hotkeys-api.js'
import harpoonClient, {
  assignHarpoonSlot,
  assignHarpoonSlotAt,
  harpoonCandidates,
  harpoonKeyCommand,
  HarpoonService,
  harpoonScopeKey,
} from '../program/plugins/harpoon.client.js'
import type { ClientSessionService, ClientSessionSnapshot } from '../program/plugins/session-api.js'

function thread(id: string): ThreadSummary {
  return {
    id,
    title: `Chat ${id}`,
    preview: `Preview ${id}`,
    cwd: '/tmp/project',
    createdAt: 1,
    updatedAt: 1,
  }
}

function sessionSnapshot(): ClientSessionSnapshot {
  return {
    revision: 0,
    connected: true,
    session: { workspace: '/tmp/project', permissionMode: 'ask' },
    turn: { tag: 'idle' },
    threadId: 'a',
    agentStatus: { tag: 'idle' },
    activities: [],
    history: { tag: 'ready' },
    threads: [thread('a'), thread('b'), thread('c')],
    projects: [],
    skills: [],
  } as unknown as ClientSessionSnapshot
}

describe('Harpoon plugin', () => {
  it('assigns slots idempotently and uses the first gap', () => {
    expect(assignHarpoonSlot(['a', undefined, 'c'], 'b', 3))
      .toEqual(['a', 'b', 'c'])
    expect(assignHarpoonSlot(['a', 'b'], 'a', 2))
      .toEqual(['a', 'b'])
  })

  it('moves a selected chat to an exact numbered slot', () => {
    expect(assignHarpoonSlotAt(['a', 'b', 'c'], 'a', 2, 3))
      .toEqual([undefined, 'b', 'a'])
    expect(assignHarpoonSlotAt(['a', 'b', 'c'], 'd', 1, 3))
      .toEqual(['a', 'd', 'c'])
    expect(assignHarpoonSlotAt(['a'], 'b', 8, 3))
      .toEqual(['a', undefined, undefined])
  })

  it('maps arrows, vim keys, slots, and open/close to Harpoon commands', () => {
    const key = (value: string, modifiers: Partial<{
      ctrlKey: boolean
      metaKey: boolean
      altKey: boolean
    }> = {}) => ({
      key: value,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...modifiers,
    })
    expect(harpoonKeyCommand(key('ArrowDown'))).toEqual({ kind: 'move', direction: 1 })
    expect(harpoonKeyCommand(key('j'))).toEqual({ kind: 'move', direction: 1 })
    expect(harpoonKeyCommand(key('k'))).toEqual({ kind: 'move', direction: -1 })
    expect(harpoonKeyCommand(key('g'))).toEqual({ kind: 'boundary', boundary: 'first' })
    expect(harpoonKeyCommand(key('G'))).toEqual({ kind: 'boundary', boundary: 'last' })
    expect(harpoonKeyCommand(key('p'))).toEqual({ kind: 'toggle' })
    expect(harpoonKeyCommand(key('4'))).toEqual({ kind: 'assign', index: 3 })
    expect(harpoonKeyCommand(key('Enter'))).toEqual({ kind: 'open' })
    expect(harpoonKeyCommand(key('Escape'))).toEqual({ kind: 'close' })
    expect(harpoonKeyCommand(key('j', { metaKey: true }))).toBeUndefined()
  })

  it('browses only the active workspace and keeps the current chat first', () => {
    const snapshot = sessionSnapshot()
    snapshot.activeProjectId = 'one'
    snapshot.projects = [
      { id: 'one', name: 'One', primaryRoot: '/tmp/project', roots: ['/tmp/project'] },
      { id: 'two', name: 'Two', primaryRoot: '/tmp/other', roots: ['/tmp/other'] },
    ]
    snapshot.threads = [
      { ...thread('b'), projectId: 'one', updatedAt: 3 },
      { ...thread('c'), projectId: 'two', cwd: '/tmp/other', updatedAt: 4 },
      { ...thread('a'), projectId: 'one', updatedAt: 1 },
    ]
    expect(harpoonCandidates(snapshot).map((candidate) => candidate.id)).toEqual(['a', 'b'])
  })

  it('scopes slots to a project, falling back to the workspace', () => {
    const session = { workspace: '/tmp/project', permissionMode: 'ask' as const }
    expect(harpoonScopeKey({ activeProjectId: 'project-1', session }))
      .toBe('project:project-1')
    expect(harpoonScopeKey({ activeProjectId: undefined, session }))
      .toBe('workspace:/tmp/project')
  })

  it('prefetches a chat when it is tagged', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    })
    const prefetchThread = vi.fn().mockResolvedValue(undefined)
    const session = {
      snapshot: sessionSnapshot,
      subscribe: () => () => undefined,
      prefetchThread,
    } as unknown as ClientSessionService
    const ui = {
      overlays: { open: vi.fn() },
    } as unknown as ClientUiService
    const service = new HarpoonService(session, ui, { slotCount: 3 })

    try {
      service.toggleTag('b')
      await Promise.resolve()
      await Promise.resolve()
      expect(prefetchThread).toHaveBeenCalledWith(thread('b'))
    } finally {
      service.dispose()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
    }
  })

  it('ignores transcript-only session updates', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: { getItem: () => null, setItem: () => undefined } },
    })
    let current = sessionSnapshot()
    let notify = (): void => undefined
    const session = {
      snapshot: () => current,
      subscribe: (listener: () => void) => {
        notify = listener
        return () => undefined
      },
    } as unknown as ClientSessionService
    const ui = { overlays: { open: vi.fn() } } as unknown as ClientUiService
    const service = new HarpoonService(session, ui, { slotCount: 3, prefetch: false })
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
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
    }
  })

  it('selects, pins, assigns, and opens chats without a mouse', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    })
    const openThread = vi.fn().mockResolvedValue(undefined)
    const session = {
      snapshot: sessionSnapshot,
      subscribe: () => () => undefined,
      openThread,
    } as unknown as ClientSessionService
    const overlays = { open: vi.fn(), closeAll: vi.fn() }
    const ui = { overlays } as unknown as ClientUiService
    const service = new HarpoonService(session, ui, { slotCount: 3, prefetch: false })

    try {
      expect(service.snapshot().selectedThreadId).toBe('a')
      service.moveSelection(1)
      expect(service.snapshot().selectedThreadId).toBe('b')
      service.assignSelectedSlot(1)
      expect(service.snapshot().slots[1]?.threadId).toBe('b')
      service.selectBoundary('last')
      expect(service.snapshot().selectedThreadId).toBe('c')
      service.toggleSelected()
      expect(service.snapshot().slots[0]?.threadId).toBe('c')
      service.toggleSelected()
      expect(service.snapshot().slots[0]?.threadId).toBeUndefined()
      service.openSelected()
      expect(overlays.closeAll).toHaveBeenCalledOnce()
      expect(openThread).toHaveBeenCalledWith(thread('c'))
    } finally {
      service.dispose()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
    }
  })

  it('unloads its actions, UI, and service without unloading Hotkeys', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    })

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
    } as unknown as ClientSessionService
    const ui = {
      overlays: {
        subscribe: () => () => undefined,
        snapshot: () => undefined,
        open: vi.fn(),
        toggle: vi.fn(),
        close: vi.fn(),
        closeAll: vi.fn(),
      },
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
    const sessionProvider: Plugin = (ctx) => ctx.provide('clientSession', session)
    sessionProvider.provide = 'clientSession'
    const uiProvider: Plugin = (ctx) => ctx.provide('clientUi', ui)
    uiProvider.provide = 'clientUi'
    let consumerActive = false
    const consumer: Plugin = (ctx) => ctx.effect(() => {
      void ctx.clientHarpoon
      consumerActive = true
      return () => {
        consumerActive = false
      }
    })
    consumer.inject = ['clientHarpoon']

    const harpoonFiber = context.plugin(harpoonClient, { slotCount: 3 })
    const consumerFiber = context.plugin(consumer)
    const hotkeysFiber = await context.plugin(hotkeysProvider)
    const sessionFiber = await context.plugin(sessionProvider)
    const uiFiber = await context.plugin(uiProvider)

    try {
      await harpoonFiber.await()
      await consumerFiber.await()
      expect(consumerActive).toBe(true)
      expect(roots).toEqual(new Set(['harpoon']))
      expect(styles).toEqual(new Set(['harpoon']))
      expect([...actions.keys()]).toEqual([
        'hotkeys.open',
        'harpoon.tag',
        'harpoon.open',
        'harpoon.slot.1',
        'harpoon.slot.2',
        'harpoon.slot.3',
      ])
      expect(actions.get('harpoon.slot.1')?.aliases).toBeUndefined()

      await harpoonFiber.dispose()
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
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
    }
  })
})
