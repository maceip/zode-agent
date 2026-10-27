import { Context, type Plugin } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { ClientOverlays } from '../src/client/plugin-api.js'
import { AgentsPanelController, AGENTS_PIN_KEY, AGENTS_TOGGLE_ACTION, agentsPanelTop } from '../program/plugins/orchestrator-panel.js'
import { readFile } from 'node:fs/promises'
import agentsHotkeys from '../program/plugins/orchestrator-hotkeys.client.js'
import type { ClientHotkeysService, HotkeyAction } from '../program/plugins/hotkeys-api.js'
import { matchesGlobalBinding } from '../program/plugins/hotkeys.client.js'

function panel(saved = false) {
  let current: string | undefined
  const callbacks = new Set<() => void>()
  const overlays = {
    snapshot: () => current,
    open: (id: string) => { current = id; for (const callback of callbacks) callback() },
    close: (id: string) => { if (current === id) { current = undefined; for (const callback of callbacks) callback() } },
    subscribe: (callback: () => void) => { callbacks.add(callback); return () => callbacks.delete(callback) },
  } as unknown as ClientOverlays
  const values = new Map([[AGENTS_PIN_KEY, String(saved)]])
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const controller = new AgentsPanelController(overlays, 'agents', storage)
  overlays.subscribe(controller.syncOverlay)
  return { controller, overlays, storage }
}

describe('Agents sidebar behavior', () => {
  it('opens requested native history from a pill without pinning or creating a pane', () => {
    const { controller, storage } = panel()
    const task = { id: 'child', threadId: 'child', parentThreadId: 'parent', parentTitle: 'Parent', title: 'Review', status: 'working' as const, activity: '', result: '', workspace: '/repo', createdAt: 0, updatedAt: 1 }
    controller.inspect(task)
    expect(controller.snapshot()).toMatchObject({ mode: 'floating', pinned: false, focusOnOpen: true, inspect: task })
    expect(storage.getItem(AGENTS_PIN_KEY)).toBe('false')
    controller.hide()
    expect(controller.snapshot().inspect).toBeUndefined()
    controller.setPinned(true)
    controller.inspect(task)
    expect(controller.snapshot().pinned).toBe(true)
    const request = controller.snapshot().inspectRevision
    controller.inspect(task)
    expect(controller.snapshot().inspectRevision).toBe(request! + 1)
    expect(controller.snapshot().pinned).toBe(true)
  })
  it('starts hidden, while the toolbar button toggles pinned and hidden', () => {
    const { controller, overlays } = panel()
    expect(controller.snapshot().mode).toBe('hidden')
    controller.toggle()
    expect(controller.snapshot().mode).toBe('pinned')
    expect(overlays.snapshot()).toBeUndefined()
    controller.toggle()
    expect(controller.snapshot().mode).toBe('hidden')
  })
  it('the shortcut reveals without pinning and requests keyboard focus', () => {
    const { controller, storage } = panel()
    controller.toggleTemporary()
    expect(controller.snapshot()).toMatchObject({ mode: 'floating', pinned: false, focusOnOpen: true })
    expect(storage.getItem(AGENTS_PIN_KEY)).toBe('false')
    controller.toggleTemporary()
    expect(controller.snapshot().open).toBe(false)
  })
  it('pinning persists globally; unpinning returns to floating mode', () => {
    const { controller, storage, overlays } = panel()
    controller.setPinned(true)
    controller.dispose()
    const restored = new AgentsPanelController(overlays, 'agents', storage)
    expect(restored.snapshot().mode).toBe('pinned')
    restored.setPinned(false)
    expect(restored.snapshot().mode).toBe('floating')
    expect(storage.getItem(AGENTS_PIN_KEY)).toBe('false')
  })
  it('other overlays dismiss floating agents but leave pinned agents open', () => {
    const { controller, overlays } = panel()
    controller.toggleTemporary()
    overlays.open('review')
    expect(controller.snapshot().mode).toBe('hidden')
    expect(overlays.snapshot()).toBe('review')
    controller.setPinned(true)
    overlays.open('settings')
    expect(controller.snapshot().mode).toBe('pinned')
  })
  it('works when browser storage is unavailable', () => {
    const { overlays } = panel()
    const controller = new AgentsPanelController(overlays, 'agents', { getItem: () => { throw Error() }, setItem: () => { throw Error() } })
    expect(() => controller.toggle()).not.toThrow()
    expect(controller.snapshot().pinned).toBe(true)
  })
})

describe('Agents placement', () => {
  it('keeps pinning on the top-level toggle without a separate panel pin button', async () => {
    const client = await readFile(new URL('../program/plugins/orchestrator.client.tsx', import.meta.url), 'utf8')
    expect(client).not.toContain('Pin agents')
    expect(client).not.toContain('Unpin agents')
    expect(client).toContain('onClick={() => controller.toggle()}')
    expect(client).toContain('aria-label="Close agents"')
  })
  it('sits below the top row of pane headers, including taller tabbed chrome', () => {
    expect(agentsPanelTop([
      { top: 52, bottom: 87, width: 400, height: 35 },
      { top: 52, bottom: 115, width: 400, height: 63 },
      { top: 500, bottom: 535, width: 400, height: 35 },
      { top: 0, bottom: 0, width: 0, height: 0 },
    ], 52)).toBe(115)
    expect(agentsPanelTop([], 52)).toBe(52)
  })
  it('always overlays the chat and lets content determine its height', async () => {
    const css = await readFile(new URL('../program/plugins/orchestrator.css', import.meta.url), 'utf8')
    expect(css).not.toContain('.workspace-views')
    const panel = css.slice(css.indexOf('.agents-panel {'), css.indexOf('.agents-panel.is-open'))
    expect(panel).not.toMatch(/\bbottom\s*:/)
    expect(panel).not.toMatch(/(?:^|[;\n])\s*height\s*:/)
    expect(panel).toContain('max-height:')
    expect(css).toContain('.agents-scroll { flex: 0 1 auto;')
  })
})

it('registers Command-Shift-A through the shared hotkey service and removes it on unload', async () => {
  const context = new Context()
  const actions = new Map<string, HotkeyAction>()
  const { controller } = panel()
  const providers: Plugin = (ctx) => {
    ctx.provide('clientAgentsPanel', controller)
    ctx.provide('clientHotkeys', {
      registerAction: (owner: Context, action: HotkeyAction) => {
        const dispose = owner.effect(() => { actions.set(action.id, action); return () => actions.delete(action.id) })
        return { dispose: async () => dispose() }
      },
    } as unknown as ClientHotkeysService)
  }
  providers.provide = ['clientAgentsPanel', 'clientHotkeys']
  const provider = await context.plugin(providers)
  const fiber = await context.plugin(agentsHotkeys, {})
  const action = actions.get(AGENTS_TOGGLE_ACTION)!
  expect(matchesGlobalBinding({ key: 'A', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }, action.binding)).toBe(true)
  await action.run()
  expect(controller.snapshot()).toMatchObject({ mode: 'floating', pinned: false })
  await fiber.dispose()
  expect(actions.size).toBe(0)
  await provider.dispose()
})
