import { readFile } from 'node:fs/promises'
import { Context, type Plugin } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ClientUiService } from '../src/client/plugin-api.js'
import type { ClientHotkeysService, HotkeyAction } from '../program/plugins/hotkeys-api.js'
import type { ClientPaneTabsService } from '../program/plugins/pane-tabs-api.js'
import type { ClientWorkspaceLayoutService } from '../program/plugins/workspace-layout-api.js'
import hotkeysCanvas from '../program/plugins/hotkeys-canvas.client.js'
import hotkeysComposer, {
  doubleEscapeGesture,
  shouldFocusComposer,
} from '../program/plugins/hotkeys-composer.client.js'
import hotkeysPaneTabs from '../program/plugins/hotkeys-pane-tabs.client.js'
import hotkeysSidebar from '../program/plugins/hotkeys-sidebar.client.js'
import hotkeysWorkspace from '../program/plugins/hotkeys-workspace.client.js'
import {
  editableTarget,
  HotkeysService,
  hotkeyHintPlacement,
  hotkeyHintLabel,
  leaderHudEntries,
  matchesGlobalBinding,
  nativeSafeHudPlacement,
  normalizeHotkeyKey,
  preservesEditableNavigation,
} from '../program/plugins/hotkeys.client.js'

describe('hotkeys plugin', () => {
  it('binds the leader HUD to the active floating-panel theme', async () => {
    const css = await readFile(
      new URL('../program/plugins/hotkeys.css', import.meta.url),
      'utf8',
    )

    expect(css).toMatch(/\.leader-hud\s*\{[^}]*--alto-floating-panel-background:\s*var\(--floating-panel\)/s)
    expect(css).toMatch(/\.leader-hud\s*\{[^}]*--alto-floating-panel-border:\s*var\(--floating-panel-border\)/s)
    expect(css).toMatch(/\.leader-hud\s*\{[^}]*--alto-floating-panel-shadow:\s*var\(--floating-panel-shadow\)/s)
  })

  it('places the leader HUD beside native panes without hiding them', () => {
    expect(nativeSafeHudPlacement(1200, 640, 18, [
      { left: 600, right: 1200 },
    ])).toEqual({ left: 18, width: 564 })
    expect(nativeSafeHudPlacement(1200, 420, 18, [
      { left: 0, right: 300 },
    ])).toEqual({ left: 762, width: 420 })
    expect(nativeSafeHudPlacement(1200, 640, 18, [
      { left: 0, right: 1200 },
    ])).toBeUndefined()
  })

  it('formats hover hints from the active shortcut and prefers a direct alias', () => {
    expect(hotkeyHintLabel({
      id: 'workspace.tab.new',
      label: 'New workspace tab',
      category: 'Workspace',
      binding: { kind: 'leader', key: 't' },
      aliases: [{ kind: 'global', key: 't', meta: true }],
      enabled: true,
    }, 'Alt')).toBe('⌘T')
    expect(hotkeyHintLabel({
      id: 'chat.new',
      label: 'New chat',
      category: 'Navigation',
      binding: { kind: 'leader', key: 'n' },
      enabled: true,
    }, 'Alt')).toBe('⌥ N')
    expect(hotkeyHintLabel({
      id: 'workspace.tab.next',
      label: 'Next tab',
      category: 'Workspace',
      binding: { kind: 'global', key: 'Tab', ctrl: true, shift: true },
      enabled: true,
    }, 'Alt')).toBe('⌃⇧⇥')
    expect(hotkeyHintLabel({
      id: 'disabled',
      label: 'Disabled',
      category: 'Test',
      binding: { kind: 'global', key: 'x', meta: true },
      enabled: false,
    }, 'Alt')).toBeUndefined()
  })

  it('places hints below controls in the workspace and pane header rows', () => {
    expect(hotkeyHintPlacement(48)).toBe('below')
    expect(hotkeyHintPlacement(80)).toBe('above')
  })

  it('normalizes Space and Option and matches exact global modifiers', () => {
    expect(normalizeHotkeyKey('Space')).toBe(' ')
    expect(normalizeHotkeyKey('Option')).toBe('Alt')
    expect(normalizeHotkeyKey('N')).toBe('n')
    expect(matchesGlobalBinding({
      key: 'Tab',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }, { kind: 'global', key: 'Tab', ctrl: true })).toBe(true)
    expect(matchesGlobalBinding({
      key: 'Tab',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }, { kind: 'global', key: 'Tab', ctrl: true })).toBe(false)
  })

  it('matches macOS Option shortcuts by their physical key', () => {
    expect(matchesGlobalBinding({
      key: '˙',
      code: 'KeyH',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
    }, { kind: 'global', key: 'h', alt: true })).toBe(true)
    expect(matchesGlobalBinding({
      key: '≠',
      code: 'Equal',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
    }, { kind: 'global', key: '=', alt: true })).toBe(true)
  })

  it('treats plaintext-only contenteditable controls as editable', () => {
    const target = (value: string | null) => ({
      closest: (selector: string) => selector === '[contenteditable]'
        ? { getAttribute: () => value }
        : null,
    }) as unknown as EventTarget

    expect(editableTarget(target('plaintext-only'))).toBe(true)
    expect(editableTarget(target('true'))).toBe(true)
    expect(editableTarget(target('false'))).toBe(false)
  })

  it('leaves arrow navigation inside editable controls to the editor', () => {
    const editable = {
      closest: (selector: string) => selector === '[contenteditable]'
        ? { getAttribute: () => 'plaintext-only' }
        : null,
    } as unknown as EventTarget
    const outside = {
      closest: () => null,
    } as unknown as EventTarget
    const optionLeft = {
      key: 'ArrowLeft',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
    }

    expect(preservesEditableNavigation(optionLeft, editable)).toBe(true)
    expect(preservesEditableNavigation(optionLeft, outside)).toBe(false)
    expect(preservesEditableNavigation({ ...optionLeft, key: 'k' }, editable)).toBe(false)
  })

  it('focuses the composer only from non-interactive page space', () => {
    const target = (interactive: boolean) => ({
      closest: () => interactive ? {} : null,
    })

    expect(shouldFocusComposer(target(false))).toBe(true)
    expect(shouldFocusComposer(target(true))).toBe(false)
    expect(shouldFocusComposer(null)).toBe(true)
  })

  it('recognizes two bare Escape presses without treating key repeat as the second press', () => {
    const escape = (timeStamp: number, repeat = false) => ({
      key: 'Escape',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat,
      timeStamp,
    })

    const first = doubleEscapeGesture(escape(100), undefined)
    const repeated = doubleEscapeGesture(escape(200, true), first.nextEscapeAt)
    const second = doubleEscapeGesture(escape(600), repeated.nextEscapeAt)

    expect(first).toEqual({ nextEscapeAt: 100, interrupt: false })
    expect(repeated).toEqual({ nextEscapeAt: 100, interrupt: false })
    expect(second).toEqual({ nextEscapeAt: undefined, interrupt: true })
    expect(doubleEscapeGesture(escape(800), 100)).toEqual({
      nextEscapeAt: 800,
      interrupt: false,
    })
  })

  it('opens a separate chat during an active turn and leaves native scrolling unregistered', async () => {
    const context = new Context()
    const actions = new Map<string, HotkeyAction>()
    const hotkeys = {
      registerAction: (owner: Context, action: HotkeyAction) => {
        const dispose = owner.effect(() => {
          actions.set(action.id, action)
          return () => actions.delete(action.id)
        }, `test.hotkey(${action.id})`)
        return { dispose: async () => dispose() }
      },
    } as unknown as ClientHotkeysService
    const hotkeysProvider: Plugin = (ctx) => ctx.provide('clientHotkeys', hotkeys)
    hotkeysProvider.provide = 'clientHotkeys'
    const composerProvider: Plugin = (ctx) => ctx.provide('clientComposer', { focus: vi.fn() } as never)
    composerProvider.provide = 'clientComposer'
    const replaceThread = vi.fn()
    const conversationProvider: Plugin = (ctx) => ctx.provide('clientConversation', {
      snapshot: () => ({ turn: { tag: 'running' } }),
      newThread: replaceThread,
    } as never)
    conversationProvider.provide = 'clientConversation'
    const uiProvider: Plugin = (ctx) => ctx.provide('clientUi', {
      overlays: { closeAll: vi.fn() },
    } as never)
    uiProvider.provide = 'clientUi'
    let layoutAvailable = true
    const newTab = vi.fn()
    const layoutProvider: Plugin = (ctx) => ctx.provide('clientWorkspaceLayout', {
      available: () => layoutAvailable,
      newTab,
    } as never)
    layoutProvider.provide = 'clientWorkspaceLayout'

    const actionFiber = context.plugin(hotkeysComposer)
    await actionFiber
    const hotkeysFiber = await context.plugin(hotkeysProvider)
    const composerFiber = await context.plugin(composerProvider)
    const conversationFiber = await context.plugin(conversationProvider)
    const uiFiber = await context.plugin(uiProvider)
    const layoutFiber = await context.plugin(layoutProvider)
    await actionFiber.await()

    expect([...actions.keys()]).toEqual(['chat.new', 'chat.focus'])
    const newChat = actions.get('chat.new')!
    expect(newChat.enabled?.()).toBe(true)
    newChat.run()
    expect(newTab).toHaveBeenCalledExactlyOnceWith()
    expect(replaceThread).not.toHaveBeenCalled()
    layoutAvailable = false
    expect(newChat.enabled?.()).toBe(false)
    expect([...actions.values()].some((action) => (
      action.binding?.kind === 'global' && action.binding.key === ' '
    ))).toBe(false)

    await layoutFiber.dispose()
    await uiFiber.dispose()
    await conversationFiber.dispose()
    await composerFiber.dispose()
    await hotkeysFiber.dispose()
    await actionFiber.dispose()
  })

  it('keeps the leader overlay open while navigating nested chords', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const events = new EventTarget()
    let activeOverlay: string | undefined
    const open = vi.fn((id: string) => { activeOverlay = id })
    const close = vi.fn((id: string) => {
      if (activeOverlay === id) activeOverlay = undefined
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: { getItem: () => null, setItem: () => undefined },
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
    })
    const ui = {
      overlays: {
        subscribe: () => () => undefined,
        snapshot: () => activeOverlay,
        open,
        toggle: vi.fn(),
        close,
        closeAll: vi.fn(),
      },
    } as unknown as ClientUiService
    const service = new HotkeysService(ui, {})
    const context = new Context()
    const run = vi.fn()
    const owner: Plugin = (ctx) => {
      service.registerAction(ctx, {
        id: 'test.leader',
        label: 'Leader action',
        category: 'Navigation',
        binding: {
          kind: 'leader',
          prefix: [{ key: 'h', label: 'History' }],
          key: 'j',
        },
        run,
      })
    }
    const key = (
      type: 'keydown' | 'keyup',
      value: string,
      modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'shiftKey'>> = {},
    ): void => {
      events.dispatchEvent(Object.assign(new Event(type), {
        key: value,
        ctrlKey: false,
        metaKey: false,
        altKey: modifiers.altKey ?? false,
        shiftKey: modifiers.shiftKey ?? false,
        isComposing: false,
        repeat: false,
      }))
    }

    try {
      const fiber = await context.plugin(owner)
      key('keydown', 'Alt', { altKey: true })
      expect(service.snapshot().pendingLeader).toBe(false)
      key('keyup', 'Alt')
      expect(service.snapshot().pendingLeader).toBe(true)
      expect(service.snapshot().leaderPath).toEqual([])
      expect(leaderHudEntries(service.snapshot().actions, [])).toEqual([
        { key: 'h', label: 'History', kind: 'group' },
      ])
      expect(open).toHaveBeenCalledWith('leader-hud', { occludesNativeViews: false })

      key('keydown', 'h')
      expect(service.snapshot().pendingLeader).toBe(true)
      expect(service.snapshot().leaderPath).toEqual(['h'])
      expect(leaderHudEntries(service.snapshot().actions, ['h'])).toEqual([
        { key: 'j', label: 'Leader action', kind: 'action' },
      ])
      expect(close).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()

      key('keydown', 'j')
      expect(close).toHaveBeenCalledWith('leader-hud')
      expect(activeOverlay).toBeUndefined()
      expect(run).toHaveBeenCalledOnce()

      key('keydown', 'Alt', { altKey: true })
      key('keydown', 'x', { altKey: true })
      key('keyup', 'Alt')
      expect(service.snapshot().pendingLeader).toBe(false)
      expect(run).toHaveBeenCalledOnce()
      await fiber.dispose()
    } finally {
      service.dispose()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
    }
  })

  it('migrates the former Space default to Option without blocking a later Space choice', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const events = new EventTarget()
    let persisted = JSON.stringify({ version: 1, leader: ' ', overrides: {} })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: () => persisted,
          setItem: (_key: string, value: string) => { persisted = value },
        },
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
    })
    const ui = {
      overlays: {
        subscribe: () => () => undefined,
        snapshot: () => undefined,
        open: vi.fn(),
        toggle: vi.fn(),
        close: vi.fn(),
        closeAll: vi.fn(),
      },
    } as unknown as ClientUiService
    const service = new HotkeysService(ui, { leader: 'Alt' })

    try {
      expect(service.snapshot().leader).toBe('Alt')
      service.setLeader(' ')
      expect(service.snapshot().leader).toBe(' ')
      expect(JSON.parse(persisted)).toMatchObject({ version: 2, leader: ' ' })
    } finally {
      service.dispose()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
    }
  })

  it('repeats only opted-in actions and removes them with their owning fiber', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const events = new EventTarget()
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
    })

    const ui = {
      overlays: {
        subscribe: () => () => undefined,
        snapshot: () => undefined,
        open: vi.fn(),
        toggle: vi.fn(),
        close: vi.fn(),
        closeAll: vi.fn(),
      },
    } as unknown as ClientUiService
    const service = new HotkeysService(ui, {})
    const context = new Context()
    const run = vi.fn()
    const repeatRun = vi.fn()
    const owner: Plugin = (ctx) => {
      service.registerAction(ctx, {
        id: 'test.action',
        label: 'Test action',
        category: 'Navigation',
        binding: { kind: 'leader', key: 't' },
        aliases: [{ kind: 'global', key: '1', meta: true }],
        run,
      })
      service.registerAction(ctx, {
        id: 'test.repeat',
        label: 'Repeating action',
        category: 'Navigation',
        binding: { kind: 'global', key: '2', meta: true },
        repeat: true,
        run: repeatRun,
      })
    }

    try {
      const fiber = await context.plugin(owner)
      expect(service.snapshot().actions.map((action) => action.id)).toEqual([
        'test.action',
        'test.repeat',
      ])
      const press = (key: string, repeat: boolean): void => {
        events.dispatchEvent(Object.assign(new Event('keydown'), {
          key,
          ctrlKey: false,
          metaKey: true,
          altKey: false,
          shiftKey: false,
          isComposing: false,
          repeat,
        }))
      }

      press('1', false)
      press('1', true)
      expect(run).toHaveBeenCalledOnce()
      press('2', false)
      press('2', true)
      expect(repeatRun).toHaveBeenCalledTimes(2)

      await fiber.dispose()
      expect(service.snapshot().actions).toEqual([])
    } finally {
      service.dispose()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
    }
  })

  it('suspends only the Canvas action when its dependency unloads', async () => {
    const context = new Context()
    const actions = new Map<string, HotkeyAction>()
    const hotkeys = {
      registerAction: (owner: Context, action: HotkeyAction) => {
        const dispose = owner.effect(() => {
          actions.set(action.id, action)
          return () => actions.delete(action.id)
        }, `test.hotkey(${action.id})`)
        return { dispose: async () => dispose() }
      },
    } as unknown as ClientHotkeysService
    const canvas = {
      toggle: vi.fn(),
    }
    const hotkeysProvider: Plugin = (ctx) => ctx.provide('clientHotkeys', hotkeys)
    hotkeysProvider.provide = 'clientHotkeys'
    const canvasProvider: Plugin = (ctx) => ctx.provide('clientCanvas', canvas as never)
    canvasProvider.provide = 'clientCanvas'

    const actionFiber = context.plugin(hotkeysCanvas)
    await actionFiber
    const hotkeysFiber = await context.plugin(hotkeysProvider)
    const canvasFiber = await context.plugin(canvasProvider)
    await actionFiber.await()
    expect([...actions]).toEqual([['panel.canvas.toggle', expect.objectContaining({
      binding: { kind: 'leader', key: 'c' },
    })]])

    await canvasFiber.dispose()
    await actionFiber.await()
    expect(actions.size).toBe(0)

    await hotkeysFiber.dispose()
    await actionFiber.dispose()
  })

  it('suspends only the sidebar action when its dependency unloads', async () => {
    const context = new Context()
    const actions = new Map<string, HotkeyAction>()
    const hotkeys = {
      registerAction: (owner: Context, action: HotkeyAction) => {
        const dispose = owner.effect(() => {
          actions.set(action.id, action)
          return () => actions.delete(action.id)
        }, `test.hotkey(${action.id})`)
        return { dispose: async () => dispose() }
      },
    } as unknown as ClientHotkeysService
    const sidebar = {
      snapshot: vi.fn(() => ({ collapsed: true })),
      setCollapsed: vi.fn(),
    }
    const hotkeysProvider: Plugin = (ctx) => ctx.provide('clientHotkeys', hotkeys)
    hotkeysProvider.provide = 'clientHotkeys'
    const sidebarProvider: Plugin = (ctx) => ctx.provide('clientSidebar', sidebar as never)
    sidebarProvider.provide = 'clientSidebar'

    const actionFiber = context.plugin(hotkeysSidebar)
    await actionFiber
    const hotkeysFiber = await context.plugin(hotkeysProvider)
    const sidebarFiber = await context.plugin(sidebarProvider)
    await actionFiber.await()
    expect([...actions]).toEqual([['panel.sidebar.toggle', expect.objectContaining({
      binding: { kind: 'leader', key: 'e' },
      aliases: [{ kind: 'global', key: 'b', meta: true }],
    })]])

    actions.get('panel.sidebar.toggle')?.run()
    expect(sidebar.setCollapsed).toHaveBeenCalledWith(false)

    sidebar.snapshot.mockReturnValue({ collapsed: false })
    actions.get('panel.sidebar.toggle')?.run()
    expect(sidebar.setCollapsed).toHaveBeenLastCalledWith(true)

    await sidebarFiber.dispose()
    await actionFiber.await()
    expect(actions.size).toBe(0)

    await hotkeysFiber.dispose()
    await actionFiber.dispose()
  })

  it('registers workspace tab and pane actions against the workspace layout service', async () => {
    const context = new Context()
    const actions = new Map<string, HotkeyAction>()
    const hotkeys = {
      registerAction: (owner: Context, action: HotkeyAction) => {
        const dispose = owner.effect(() => {
          actions.set(action.id, action)
          return () => actions.delete(action.id)
        }, `test.hotkey(${action.id})`)
        return { dispose: async () => dispose() }
      },
    } as unknown as ClientHotkeysService
    const canCloseFocusedPane = vi.fn(() => true)
    const canRestoreClosedTab = vi.fn(() => true)
    const workspace = {
      available: () => true,
      canCloseActiveTab: () => false,
      closeActiveTab: vi.fn(),
      canRestoreClosedTab,
      restoreClosedTab: vi.fn(),
      canCloseFocusedPane,
      closeFocusedPane: vi.fn(),
      cycleTabs: vi.fn(),
      selectTab: vi.fn(),
      moveActiveTab: vi.fn(),
      newTab: vi.fn(),
      splitFocused: vi.fn(),
      focusAdjacentPane: vi.fn(),
      resizeFocusedPane: vi.fn(),
      toggleFocusedPaneFullscreen: vi.fn(),
    } as unknown as ClientWorkspaceLayoutService
    const hotkeysProvider: Plugin = (ctx) => ctx.provide('clientHotkeys', hotkeys)
    hotkeysProvider.provide = 'clientHotkeys'
    const workspaceProvider: Plugin = (ctx) => ctx.provide('clientWorkspaceLayout', workspace)
    workspaceProvider.provide = 'clientWorkspaceLayout'
    const actionFiber = context.plugin(hotkeysWorkspace)
    await actionFiber
    const hotkeysFiber = await context.plugin(hotkeysProvider)
    const workspaceFiber = await context.plugin(workspaceProvider)
    await actionFiber.await()

    expect([...actions.keys()]).toEqual([
      'workspace.tab.new',
      'workspace.tab.close',
      'workspace.tab.restore',
      'workspace.pane.split-right',
      'workspace.pane.split-down',
      'workspace.pane.fullscreen',
      'workspace.pane.new',
      'workspace.tab.next',
      'workspace.tab.previous',
      ...Array.from({ length: 9 }, (_, index) => `workspace.tab.select.${index + 1}`),
      'workspace.pane.focus-left',
      'workspace.pane.focus-down',
      'workspace.pane.focus-up',
      'workspace.pane.focus-right',
      'workspace.tab.move-left',
      'workspace.tab.move-right',
      'workspace.pane.grow',
      'workspace.pane.shrink',
      'workspace.pane.close',
      'workspace.close-current',
    ])
    expect(actions.get('workspace.tab.next')?.binding).toEqual({ kind: 'global', key: 'Tab', ctrl: true })
    expect(actions.get('workspace.tab.previous')?.binding).toEqual({ kind: 'global', key: 'Tab', ctrl: true, shift: true })
    expect(actions.get('workspace.tab.new')).toMatchObject({
      binding: { kind: 'leader', key: 't' },
      aliases: [{ kind: 'global', key: 't', meta: true }],
    })
    expect(actions.get('workspace.tab.close')).toMatchObject({
      binding: {
        kind: 'leader',
        prefix: [{ key: 'w', label: 'Workspaces' }],
        key: 'x',
      },
    })
    expect(actions.get('workspace.tab.close')?.enabled?.()).toBe(false)
    expect(actions.get('workspace.tab.restore')).toMatchObject({
      binding: { kind: 'global', key: 't', meta: true, shift: true },
    })
    expect(actions.get('workspace.tab.restore')?.enabled?.()).toBe(true)
    expect(actions.get('workspace.pane.split-right')).toMatchObject({
      binding: {
        kind: 'leader',
        prefix: [{ key: 'p', label: 'Panes' }],
        key: 'r',
      },
      aliases: [{ kind: 'global', key: 'd', meta: true }],
    })
    expect(actions.get('workspace.pane.split-down')).toMatchObject({
      binding: {
        kind: 'leader',
        prefix: [{ key: 'p', label: 'Panes' }],
        key: 'd',
      },
      aliases: [{ kind: 'global', key: 'd', meta: true, shift: true }],
    })
    expect(actions.get('workspace.pane.fullscreen')).toMatchObject({
      binding: { kind: 'leader', key: 'f' },
      aliases: [{ kind: 'global', key: 'f', meta: true }],
    })
    expect(actions.get('workspace.tab.select.1')?.binding).toEqual({ kind: 'global', key: '1', meta: true })
    expect(actions.get('workspace.pane.focus-left')).toMatchObject({
      binding: { kind: 'global', key: 'h', alt: true },
      aliases: [{ kind: 'global', key: 'ArrowLeft', alt: true }],
    })
    expect(actions.get('workspace.tab.move-left')).toMatchObject({
      binding: { kind: 'global', key: 'i', alt: true },
      aliases: [{ kind: 'global', key: 'ArrowLeft', ctrl: true, shift: true }],
    })
    expect(actions.get('workspace.pane.close')?.binding).toEqual({
      kind: 'leader',
      prefix: [{ key: 'p', label: 'Panes' }],
      key: 'x',
    })
    expect(actions.get('workspace.pane.close')?.aliases).toBeUndefined()
    expect(actions.get('workspace.pane.close')?.enabled?.()).toBe(true)
    expect(actions.get('workspace.close-current')?.binding).toEqual({
      kind: 'global',
      key: 'w',
      meta: true,
    })

    actions.get('workspace.tab.new')?.run()
    actions.get('workspace.tab.close')?.run()
    actions.get('workspace.tab.restore')?.run()
    actions.get('workspace.pane.split-right')?.run()
    actions.get('workspace.pane.split-down')?.run()
    actions.get('workspace.pane.fullscreen')?.run()
    actions.get('workspace.pane.new')?.run()
    actions.get('workspace.tab.next')?.run()
    actions.get('workspace.tab.previous')?.run()
    actions.get('workspace.tab.select.1')?.run()
    actions.get('workspace.tab.select.9')?.run()
    actions.get('workspace.pane.focus-left')?.run()
    actions.get('workspace.pane.focus-down')?.run()
    actions.get('workspace.pane.focus-up')?.run()
    actions.get('workspace.pane.focus-right')?.run()
    actions.get('workspace.tab.move-left')?.run()
    actions.get('workspace.tab.move-right')?.run()
    actions.get('workspace.pane.grow')?.run()
    actions.get('workspace.pane.shrink')?.run()
    actions.get('workspace.pane.close')?.run()
    actions.get('workspace.close-current')?.run()
    canCloseFocusedPane.mockReturnValue(false)
    actions.get('workspace.close-current')?.run()
    expect(workspace.newTab).toHaveBeenCalledOnce()
    expect(workspace.restoreClosedTab).toHaveBeenCalledOnce()
    expect(workspace.closeActiveTab).toHaveBeenCalledTimes(2)
    expect(workspace.closeFocusedPane).toHaveBeenCalledTimes(2)
    expect(workspace.cycleTabs).toHaveBeenNthCalledWith(1, 1)
    expect(workspace.cycleTabs).toHaveBeenNthCalledWith(2, -1)
    expect(workspace.splitFocused).toHaveBeenNthCalledWith(1, 'horizontal')
    expect(workspace.splitFocused).toHaveBeenNthCalledWith(2, 'vertical')
    expect(workspace.splitFocused).toHaveBeenNthCalledWith(3, 'horizontal')
    expect(workspace.toggleFocusedPaneFullscreen).toHaveBeenCalledOnce()
    expect(workspace.selectTab).toHaveBeenNthCalledWith(1, 0)
    expect(workspace.selectTab).toHaveBeenNthCalledWith(2, 8)
    expect(workspace.focusAdjacentPane).toHaveBeenNthCalledWith(1, 'left', true)
    expect(workspace.focusAdjacentPane).toHaveBeenNthCalledWith(2, 'down', false)
    expect(workspace.focusAdjacentPane).toHaveBeenNthCalledWith(3, 'up', false)
    expect(workspace.focusAdjacentPane).toHaveBeenNthCalledWith(4, 'right', true)
    expect(workspace.moveActiveTab).toHaveBeenNthCalledWith(1, -1)
    expect(workspace.moveActiveTab).toHaveBeenNthCalledWith(2, 1)
    expect(workspace.resizeFocusedPane).toHaveBeenNthCalledWith(1, 1)
    expect(workspace.resizeFocusedPane).toHaveBeenNthCalledWith(2, -1)
    await workspaceFiber.dispose()
    await actionFiber.await()
    expect(actions.size).toBe(0)

    await hotkeysFiber.dispose()
    await actionFiber.dispose()
  })

  it('creates an inner tab in the active tabbed pane with the Pane leader chord', async () => {
    const context = new Context()
    let action: HotkeyAction | undefined
    const createInActivePane = vi.fn(() => true)
    const hotkeys = {
      registerAction: (owner: Context, registered: HotkeyAction) => {
        const dispose = owner.effect(() => {
          action = registered
          return () => { action = undefined }
        }, 'test.pane-tab-hotkey')
        return { dispose: async () => dispose() }
      },
    } as unknown as ClientHotkeysService
    const paneTabs = {
      canCreateInActivePane: () => true,
      createInActivePane,
    } as unknown as ClientPaneTabsService
    const hotkeysProvider: Plugin = (ctx) => ctx.provide('clientHotkeys', hotkeys)
    hotkeysProvider.provide = 'clientHotkeys'
    const paneTabsProvider: Plugin = (ctx) => ctx.provide('clientPaneTabs', paneTabs)
    paneTabsProvider.provide = 'clientPaneTabs'

    const actionFiber = context.plugin(hotkeysPaneTabs)
    await actionFiber
    const hotkeysFiber = await context.plugin(hotkeysProvider)
    const paneTabsFiber = await context.plugin(paneTabsProvider)
    await actionFiber.await()

    expect(action).toMatchObject({
      id: 'pane-tabs.create',
      binding: {
        kind: 'leader',
        prefix: [{ key: 'p', label: 'Panes' }],
        key: 't',
      },
    })
    expect(action?.enabled?.()).toBe(true)
    action?.run()
    expect(createInActivePane).toHaveBeenCalledOnce()

    await actionFiber.dispose()
    await paneTabsFiber.dispose()
    await hotkeysFiber.dispose()
  })
})
