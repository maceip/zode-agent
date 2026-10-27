import { describe, expect, it, vi } from 'vitest'
import type { ClientOverlays } from '../src/client/plugin-api.js'
import type { WorkspaceTabTarget } from '../program/plugins/workspace-layout-api.js'
import { WorkspaceLayoutRegistry } from '../program/plugins/workspace-layout.client.js'
import { TAB_RECENCY_KEY, TAB_SWITCHER_ID, WorkspaceTabSwitcher, releasesTabSwitcher } from '../program/plugins/workspace-tab-switcher.js'

function harness(saved?: string) {
  let tabs: WorkspaceTabTarget[] = ['a', 'b', 'c'].map((id) => ({ id, title: id.toUpperCase(), active: id === 'a', threadIds: [id + '-chat'], threads: [], paneKinds: ['chat'] }))
  const layoutListeners = new Set<() => void>()
  const overlayListeners = new Set<() => void>()
  let overlay: string | undefined
  const overlays = {
    snapshot: () => overlay,
    open: (id: string) => { overlay = id; for (const listener of overlayListeners) listener() },
    close: (id: string) => { if (overlay === id) { overlay = undefined; for (const listener of overlayListeners) listener() } },
    subscribe: (listener: () => void) => { overlayListeners.add(listener); return () => overlayListeners.delete(listener) },
  } as unknown as ClientOverlays
  const storage = { getItem: vi.fn(() => saved ?? null), setItem: vi.fn() }
  const update = (next: WorkspaceTabTarget[]) => { tabs = next; for (const listener of layoutListeners) listener() }
  const layout = {
    tabs: () => tabs,
    subscribe: (listener: () => void) => { layoutListeners.add(listener); return () => layoutListeners.delete(listener) },
    selectTab: vi.fn((index: number) => update(tabs.map((tab, i) => ({ ...tab, active: i === index })))),
  }
  const controller = new WorkspaceTabSwitcher(layout, overlays, storage)
  const dispose = controller.activate()
  return { controller, layout, overlays, storage, update, dispose, layoutListeners, overlayListeners }
}

describe('Option-Tab workspace switcher', () => {
  it('tracks actual visits and freezes MRU order until release', () => {
    const h = harness()
    h.layout.selectTab(1)
    h.layout.selectTab(2)
    expect(h.controller.snapshot().tabs.map((tab) => tab.id)).toEqual(['c', 'b', 'a'])
    h.layout.selectTab.mockClear()
    h.controller.cycle(1)
    expect(h.controller.snapshot().selectedId).toBe('b')
    expect(h.overlays.snapshot()).toBe(TAB_SWITCHER_ID)
    h.controller.cycle(1)
    expect(h.controller.snapshot().selectedId).toBe('a')
    expect(h.controller.snapshot().tabs.map((tab) => tab.id)).toEqual(['c', 'b', 'a'])
    expect(h.layout.selectTab).not.toHaveBeenCalled()
    h.controller.commit()
    expect(h.layout.selectTab).toHaveBeenCalledWith(0)
    expect(h.controller.snapshot().tabs.map((tab) => tab.id)).toEqual(['a', 'c', 'b'])
    expect(h.overlays.snapshot()).toBeUndefined()
    h.controller.cycle(1)
    expect(h.controller.snapshot().selectedId).toBe('c')
    h.dispose()
  })

  it('supports reverse cycling, wraparound, and cancel without navigation', () => {
    const h = harness()
    h.controller.cycle(-1)
    expect(h.controller.snapshot().selectedId).toBe('c')
    h.controller.cycle(1)
    expect(h.controller.snapshot().selectedId).toBe('a')
    h.controller.cancel()
    expect(h.layout.selectTab).not.toHaveBeenCalled()
    expect(h.controller.snapshot().tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c'])
    expect(h.controller.restoreFocus).toBe(true)
    h.dispose()
  })

  it('restores recency and ignores stale IDs and duplicates', () => {
    const h = harness('["closed","c","b","c"]')
    expect(h.controller.snapshot().tabs.map((tab) => tab.id)).toEqual(['a', 'c', 'b'])
    expect(h.storage.setItem).toHaveBeenLastCalledWith(TAB_RECENCY_KEY, '["a","c","b"]')
    h.dispose()
  })

  it('survives malformed storage and metadata refreshes without changing recency', () => {
    const h = harness('{bad json')
    h.layout.selectTab(2)
    h.storage.setItem.mockClear()
    h.update(h.layout.tabs().map((tab) => ({ ...tab, title: tab.title + ' renamed' })))
    expect(h.controller.snapshot().tabs.map((tab) => tab.id)).toEqual(['c', 'a', 'b'])
    expect(h.storage.setItem).not.toHaveBeenCalled()
    h.dispose()
  })

  it('does not erase saved order before the workspace mounts', () => {
    let tabs: WorkspaceTabTarget[] = []
    const storage = { getItem: () => '["c","b","a"]', setItem: vi.fn() }
    const h = harness()
    const controller = new WorkspaceTabSwitcher({ tabs: () => tabs, selectTab: vi.fn(), subscribe: () => () => {} }, h.overlays, storage)
    expect(storage.setItem).not.toHaveBeenCalled()
    tabs = h.layout.tabs().map((tab) => ({ ...tab }))
    controller.cycle(1)
    expect(controller.snapshot().selectedId).toBe('c')
    controller.cancel()
    h.dispose()
  })

  it('resolves reordered tabs by ID and refreshes titles in an open popup', () => {
    const h = harness()
    h.controller.cycle(1)
    h.update([h.layout.tabs()[2]!, h.layout.tabs()[0]!, { ...h.layout.tabs()[1]!, title: 'Renamed' }])
    expect(h.controller.snapshot().tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c'])
    expect(h.controller.snapshot().tabs[1]?.title).toBe('Renamed')
    h.controller.commit()
    expect(h.layout.selectTab).toHaveBeenCalledWith(2)
    h.dispose()
  })

  it('drops closed tabs and safely chooses a remaining candidate', () => {
    const h = harness()
    h.controller.cycle(1)
    h.update(h.layout.tabs().filter((tab) => tab.id !== 'b'))
    expect(h.controller.snapshot().selectedId).toBe('c')
    h.update(h.layout.tabs().filter((tab) => tab.id !== 'c'))
    expect(h.controller.snapshot().selectedId).toBeUndefined()
    expect(h.layout.selectTab).not.toHaveBeenCalled()
    expect(h.controller.canCycle()).toBe(false)
    h.dispose()
  })

  it('cancels if another navigation or overlay takes over', () => {
    const h = harness()
    h.controller.cycle(1)
    h.layout.selectTab(2)
    expect(h.controller.snapshot().selectedId).toBeUndefined()
    h.controller.cycle(1)
    h.overlays.open('settings')
    expect(h.controller.snapshot().selectedId).toBeUndefined()
    expect(h.overlays.snapshot()).toBe('settings')
    expect(h.controller.canCycle()).toBe(false)
    h.dispose()
  })

  it('removes subscriptions and closes the popup on unload', () => {
    const h = harness()
    h.controller.cycle(1)
    h.dispose()
    expect(h.layoutListeners.size).toBe(0)
    expect(h.overlayListeners.size).toBe(0)
    expect(h.overlays.snapshot()).toBeUndefined()
    expect(h.layout.selectTab).not.toHaveBeenCalled()
  })

  it('commits only after Option is released, not on every Tab keyup', () => {
    expect(releasesTabSwitcher({ key: 'Tab', code: 'Tab', altKey: true })).toBe(false)
    expect(releasesTabSwitcher({ key: 'Alt', code: 'AltLeft', altKey: false })).toBe(true)
    expect(releasesTabSwitcher({ key: 'Alt', code: 'AltRight', altKey: false })).toBe(true)
    expect(releasesTabSwitcher({ key: 'Alt', code: 'AltLeft', altKey: true })).toBe(false)
    expect(releasesTabSwitcher({ key: 'Control', code: 'ControlLeft', altKey: false })).toBe(false)
  })
})

describe('workspace tab discovery', () => {
  it('publishes tab changes without publishing every controller render', () => {
    const registry = new WorkspaceLayoutRegistry()
    const changed = vi.fn()
    registry.subscribe(changed)
    const tabs: WorkspaceTabTarget[] = [{ id: 'a', title: 'A', active: true, threadIds: [], threads: [], paneKinds: ['chat'] }]
    const bind = (next: WorkspaceTabTarget[]) => registry.bindController({ tabs: () => next, paneTargets: () => [] } as unknown as Parameters<typeof registry.bindController>[0])
    bind(tabs)()
    expect(registry.tabs()).toEqual(tabs)
    bind(tabs.map((tab) => ({ ...tab })))()
    expect(changed).toHaveBeenCalledTimes(1)
    bind([{ ...tabs[0]!, title: 'Renamed' }])()
    expect(changed).toHaveBeenCalledTimes(2)
    bind([{ ...tabs[0]!, title: 'Renamed', paneKinds: ['todo'] }])()
    expect(changed).toHaveBeenCalledTimes(3)
    registry.dispose()
  })
})
