import { describe, expect, it } from 'vitest'
import { parseWorkspaceLayout, type WorkspaceLayoutState } from '../program/plugins/workspace-layout-state.js'
import { closeWorkspaceTab, dockWorkspaceTab, restoreWorkspaceTab } from '../program/plugins/workspace-layout.client.js'
import {
  activateWorkspaceTab, assignTabToGroup, createTabGroup, dropWorkspaceTabs, moveWorkspaceTab,
  moveWorkspaceTabGroup, normalizeTabGroups, ungroupTabs, updateTabGroup,
} from '../program/plugins/workspace-tab-groups.js'

function layout(): WorkspaceLayoutState {
  return { version: 2, activeViewId: 'b', views: ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    id, name: id.toUpperCase(), workspace: '/repo', focusedPaneId: 'pane-' + id,
    root: { type: 'pane', id: 'pane-' + id, workspace: '/repo' },
  })) }
}

function grouped(): WorkspaceLayoutState {
  return assignTabToGroup(createTabGroup(layout(), 'b', 'group'), 'd', 'group')
}

describe('workspace tab groups', () => {
  it('commits a tab drop at a precise position inside a group', () => {
    const original = grouped()
    const result = dropWorkspaceTabs(original, { kind: 'tab', id: 'e' }, { beforeId: 'd', groupId: 'group' })
    expect(result.views.map((view) => view.id)).toEqual(['a', 'b', 'e', 'd', 'c'])
    expect(result.views.find((view) => view.id === 'e')!.groupId).toBe('group')
    expect(result.activeViewId).toBe(original.activeViewId)
    for (const view of result.views) expect(view.root).toBe(original.views.find((candidate) => candidate.id === view.id)!.root)
  })

  it('allows a tab to leave a group at either boundary even when every tab is grouped', () => {
    let original = createTabGroup(layout(), 'a', 'group')
    for (const id of ['b', 'c', 'd', 'e']) original = assignTabToGroup(original, id, 'group')
    const before = dropWorkspaceTabs(original, { kind: 'tab', id: 'd' }, { beforeId: 'a' })
    expect(before.views.map((view) => view.id)).toEqual(['d', 'a', 'b', 'c', 'e'])
    expect(before.views[0]!.groupId).toBeUndefined()
    const after = dropWorkspaceTabs(original, { kind: 'tab', id: 'a' }, {})
    expect(after.views.map((view) => view.id)).toEqual(['b', 'c', 'd', 'e', 'a'])
    expect(after.views.at(-1)!.groupId).toBeUndefined()
  })

  it('moves between groups and preserves the destination collapsed state', () => {
    const original = updateTabGroup(createTabGroup(grouped(), 'c', 'second'), 'second', { collapsed: true })
    const result = dropWorkspaceTabs(original, { kind: 'tab', id: 'b' }, { beforeId: 'e', groupId: 'second' })
    expect(result.views.map((view) => view.id)).toEqual(['a', 'd', 'c', 'b', 'e'])
    expect(result.views.find((view) => view.id === 'b')!.groupId).toBe('second')
    expect(result.groups!.find((group) => group.id === 'second')!.collapsed).toBe(true)
    expect(parseWorkspaceLayout(JSON.parse(JSON.stringify(result)))).toEqual(result)
  })

  it('drops whole groups as a block and ignores invalid or cancelled destinations', () => {
    const original = grouped()
    const result = dropWorkspaceTabs(original, { kind: 'group', id: 'group' }, {})
    expect(result.views.map((view) => view.id)).toEqual(['a', 'c', 'e', 'b', 'd'])
    expect(dropWorkspaceTabs(original, { kind: 'group', id: 'group' }, { beforeId: 'b' })).toBe(original)
    expect(dropWorkspaceTabs(original, { kind: 'tab', id: 'b' }, { beforeId: 'missing' })).toBe(original)
    expect(dropWorkspaceTabs(original, { kind: 'tab', id: 'b' }, { groupId: 'missing' })).toBe(original)
  })

  it('keeps group members together without replacing their pane trees or changing the active chat', () => {
    const original = layout()
    const result = assignTabToGroup(createTabGroup(original, 'b', 'group'), 'd', 'group')
    expect(result.views.map((view) => view.id)).toEqual(['a', 'b', 'd', 'c', 'e'])
    expect(result.activeViewId).toBe('b')
    for (const view of result.views) expect(view.root).toBe(original.views.find((candidate) => candidate.id === view.id)!.root)
    expect(result.groups).toEqual([{ id: 'group', name: 'Group', color: 'purple', collapsed: false }])
    expect(assignTabToGroup(result, 'd', 'group')).toBe(result)
    expect(assignTabToGroup(result, 'd', 'missing')).toBe(result)
  })

  it('moves a tab out beside the group and removes the last empty group', () => {
    const result = assignTabToGroup(grouped(), 'b')
    expect(result.views.map((view) => view.id)).toEqual(['a', 'd', 'b', 'c', 'e'])
    expect(result.views.find((view) => view.id === 'b')!.groupId).toBeUndefined()
    expect(assignTabToGroup(result, 'd').groups).toBeUndefined()
  })

  it('persists names, colors, collapsed state, and membership through the layout parser', () => {
    const result = updateTabGroup(grouped(), 'group', { name: '  Review  ', color: 'green', collapsed: true })
    expect(parseWorkspaceLayout(JSON.parse(JSON.stringify(result)))).toEqual(result)
    expect(result.groups![0]!.name).toBe('Review')
    expect(result.activeViewId).toBe('b')
    const selected = activateWorkspaceTab(result, 'd')
    expect(selected.activeViewId).toBe('d')
    expect(selected.groups![0]!.collapsed).toBe(false)
    expect(selected.views).toBe(result.views)
    expect(activateWorkspaceTab(selected, 'missing')).toBe(selected)
  })

  it('repairs malformed group metadata without losing valid tabs or panes', () => {
    const original = grouped()
    const result = parseWorkspaceLayout({ ...original, groups: [null, { id: 'group', name: '', color: 'invalid' }, { id: 'group', name: 'duplicate' }, { id: 'empty' }] })!
    expect(result.views).toEqual(original.views)
    expect(result.groups).toEqual([{ id: 'group', name: 'Group', color: 'purple', collapsed: false }])
    const missing = parseWorkspaceLayout({ ...original, groups: [] })!
    expect(missing.views).toHaveLength(5)
    expect(missing.views.every((view) => !view.groupId)).toBe(true)
    expect(parseWorkspaceLayout(layout())).toEqual(layout())
  })

  it('moves tabs into and out of groups when reordered across a group boundary', () => {
    let result = moveWorkspaceTab(grouped(), 'e', 'b')
    expect(result.views.map((view) => view.id)).toEqual(['a', 'e', 'b', 'd', 'c'])
    expect(result.views.find((view) => view.id === 'e')!.groupId).toBe('group')
    result = moveWorkspaceTab(result, 'b', 'c')
    expect(result.views.map((view) => view.id)).toEqual(['a', 'e', 'd', 'c', 'b'])
    expect(result.views.at(-1)!.groupId).toBeUndefined()
    expect(normalizeTabGroups(result)).toBe(result)
  })

  it('moves a whole group past another group without splitting either', () => {
    const original = assignTabToGroup(createTabGroup(grouped(), 'c', 'second'), 'e', 'second')
    const moved = moveWorkspaceTabGroup(original, 'group', 'c')
    expect(moved.views.map((view) => view.id)).toEqual(['a', 'c', 'e', 'b', 'd'])
    expect(moveWorkspaceTabGroup(moved, 'group', 'e').views.map((view) => view.id)).toEqual(['a', 'b', 'd', 'c', 'e'])
    expect(moveWorkspaceTabGroup(moved, 'group', 'd')).toBe(moved)
  })

  it('ungroups without closing chats and restores group metadata when reopening its last tab', () => {
    const original = grouped()
    const ungrouped = ungroupTabs(original, 'group')
    expect(ungrouped.views.map((view) => view.id)).toEqual(original.views.map((view) => view.id))
    expect(ungrouped.groups).toBeUndefined()
    const closedFirst = closeWorkspaceTab(original, 'b')
    const closedLast = closeWorkspaceTab(closedFirst.layout, 'd')
    expect(closedLast.layout.groups).toBeUndefined()
    const restored = restoreWorkspaceTab(closedLast.layout, closedLast.closed!)
    expect(restored.groups).toEqual(original.groups)
    expect(restored.views.find((view) => view.id === 'd')!.groupId).toBe('group')
    expect(restored.activeViewId).toBe('d')
  })

  it('removes an empty group when docking its only tab into another pane', () => {
    const original = createTabGroup(layout(), 'b', 'group')
    const docked = dockWorkspaceTab(original, 'b', 'a', 'pane-a', 'right', 'split')
    expect(docked.groups).toBeUndefined()
    expect(docked.views).toHaveLength(4)
    expect(docked.activeViewId).toBe('a')
    expect(docked.views[0]!.root).toMatchObject({ type: 'split', second: original.views[1]!.root })
  })
})
