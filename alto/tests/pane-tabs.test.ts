import { describe, expect, it } from 'vitest'
import { movePaneTabs } from '../program/plugins/pane-tabs-api.js'
import paneTabs, { PaneTabsRegistry } from '../program/plugins/pane-tabs.client.js'

describe('pane tabs', () => {
  it('waits for the workspace layout that hosts pane tabs', () => {
    expect(paneTabs.inject).toContain('clientWorkspaceLayout')
  })

  it('moves a tab to either side of another tab', () => {
    const tabs = [{ id: 'one' }, { id: 'two' }, { id: 'three' }]

    expect(movePaneTabs(tabs, 'three', 'one', 'before').map((tab) => tab.id))
      .toEqual(['three', 'one', 'two'])
    expect(movePaneTabs(tabs, 'one', 'two', 'after').map((tab) => tab.id))
      .toEqual(['two', 'one', 'three'])
    expect(movePaneTabs(tabs, 'one', 'one', 'before')).toBe(tabs)
  })

  it('creates a tab only in the active registered pane', () => {
    const registry = new PaneTabsRegistry()
    let firstActive = false
    let firstCreated = 0
    let secondCreated = 0
    const first = registry.registerHost({
      active: () => firstActive,
      create: () => { firstCreated += 1 },
    })
    const second = registry.registerHost({
      active: () => true,
      create: () => { secondCreated += 1 },
    })

    expect(registry.canCreateInActivePane()).toBe(true)
    expect(registry.createInActivePane()).toBe(true)
    expect([firstCreated, secondCreated]).toEqual([0, 1])

    firstActive = true
    expect(registry.createInActivePane()).toBe(true)
    expect([firstCreated, secondCreated]).toEqual([1, 1])

    first.dispose()
    second.dispose()
    expect(registry.canCreateInActivePane()).toBe(false)
    expect(registry.createInActivePane()).toBe(false)
  })
})
