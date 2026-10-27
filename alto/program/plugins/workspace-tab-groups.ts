import type { WorkspaceLayoutState, WorkspaceView } from './workspace-layout-state.js'

export const TAB_GROUP_COLORS = ['purple', 'green', 'amber', 'red', 'gray'] as const
export type TabGroupColor = typeof TAB_GROUP_COLORS[number]

export interface WorkspaceTabGroup {
  id: string
  name: string
  color: TabGroupColor
  collapsed: boolean
}

export function parseTabGroups(value: unknown): WorkspaceTabGroup[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.flatMap((group): WorkspaceTabGroup[] => {
    if (!group || typeof group !== 'object' || typeof group.id !== 'string' || !group.id || ids.has(group.id)) return []
    ids.add(group.id)
    return [{
      id: group.id,
      name: typeof group.name === 'string' && group.name.trim() ? group.name.trim().slice(0, 60) : 'Group',
      color: TAB_GROUP_COLORS.includes(group.color) ? group.color : 'purple',
      collapsed: group.collapsed === true,
    }]
  })
}

function withGroup(view: WorkspaceView, groupId: string | undefined): WorkspaceView {
  if (view.groupId === groupId) return view
  const next = { ...view }
  if (groupId) next.groupId = groupId
  else delete next.groupId
  return next
}

// Keep each group together in the ordinary tab order. This also repairs older
// snapshots with missing group metadata without dropping any chats or panes.
export function normalizeTabGroups(layout: WorkspaceLayoutState): WorkspaceLayoutState {
  const known = new Set(layout.groups?.map((group) => group.id))
  const views = layout.views.map((view) => view.groupId && !known.has(view.groupId) ? withGroup(view, undefined) : view)
  const emitted = new Set<string>()
  const ordered = views.flatMap((view) => {
    if (!view.groupId) return [view]
    if (emitted.has(view.groupId)) return []
    emitted.add(view.groupId)
    return views.filter((candidate) => candidate.groupId === view.groupId)
  })
  const groups = layout.groups?.filter((group) => emitted.has(group.id)) ?? []
  if (ordered.every((view, index) => view === layout.views[index]) && groups.length === (layout.groups?.length ?? 0)) return layout
  const next = { ...layout, views: ordered }
  if (groups.length) next.groups = groups
  else delete next.groups
  return next
}

export function assignTabToGroup(layout: WorkspaceLayoutState, viewId: string, groupId?: string): WorkspaceLayoutState {
  const source = layout.views.find((view) => view.id === viewId)
  if (!source || source.groupId === groupId || (groupId && !layout.groups?.some((group) => group.id === groupId))) return layout
  const views = layout.views.filter((view) => view.id !== viewId)
  const siblings = views.filter((view) => view.groupId === (groupId ?? source.groupId))
  const index = siblings.length
    ? views.indexOf(siblings.at(-1)!) + 1
    : Math.min(layout.views.indexOf(source), views.length)
  views.splice(index, 0, withGroup(source, groupId))
  return normalizeTabGroups({ ...layout, views })
}

export function createTabGroup(layout: WorkspaceLayoutState, viewId: string, id: string): WorkspaceLayoutState {
  if (!layout.views.some((view) => view.id === viewId) || layout.groups?.some((group) => group.id === id)) return layout
  const groups = [...(layout.groups ?? []), {
    id, name: 'Group', color: TAB_GROUP_COLORS[(layout.groups?.length ?? 0) % TAB_GROUP_COLORS.length]!, collapsed: false,
  }]
  return assignTabToGroup({ ...layout, groups }, viewId, id)
}

export function updateTabGroup(layout: WorkspaceLayoutState, id: string, patch: Partial<Omit<WorkspaceTabGroup, 'id'>>): WorkspaceLayoutState {
  const group = layout.groups?.find((candidate) => candidate.id === id)
  if (!group) return layout
  const next = { ...group, ...patch, name: patch.name?.trim().slice(0, 60) || group.name }
  if (next.name === group.name && next.color === group.color && next.collapsed === group.collapsed) return layout
  return { ...layout, groups: layout.groups!.map((candidate) => candidate.id === id ? next : candidate) }
}

export function ungroupTabs(layout: WorkspaceLayoutState, id: string): WorkspaceLayoutState {
  return normalizeTabGroups({ ...layout, views: layout.views.map((view) => view.groupId === id ? withGroup(view, undefined) : view) })
}

export function activateWorkspaceTab(layout: WorkspaceLayoutState, id: string): WorkspaceLayoutState {
  const view = layout.views.find((candidate) => candidate.id === id)
  if (!view) return layout
  const expanded = view.groupId ? updateTabGroup(layout, view.groupId, { collapsed: false }) : layout
  return expanded.activeViewId === id ? expanded : { ...expanded, activeViewId: id }
}

export function moveWorkspaceTab(layout: WorkspaceLayoutState, sourceId: string, targetId: string): WorkspaceLayoutState {
  if (sourceId === targetId) return layout
  const source = layout.views.findIndex((view) => view.id === sourceId)
  const target = layout.views.findIndex((view) => view.id === targetId)
  if (source < 0 || target < 0) return layout
  const views = [...layout.views]
  const [moved] = views.splice(source, 1)
  views.splice(target, 0, withGroup(moved!, layout.views[target]!.groupId))
  return normalizeTabGroups({ ...layout, views })
}

export function moveWorkspaceTabGroup(layout: WorkspaceLayoutState, id: string, targetId: string): WorkspaceLayoutState {
  const members = layout.views.filter((view) => view.groupId === id)
  const target = layout.views.find((view) => view.id === targetId)
  if (!members.length || !target || target.groupId === id) return layout
  const forward = layout.views.indexOf(members[0]!) < layout.views.indexOf(target)
  const views = layout.views.filter((view) => view.groupId !== id)
  const targets = target.groupId ? views.filter((view) => view.groupId === target.groupId) : [target]
  const index = views.indexOf(forward ? targets.at(-1)! : targets[0]!) + (forward ? 1 : 0)
  views.splice(index, 0, ...members)
  return { ...layout, views }
}

export interface WorkspaceTabDrag {
  kind: 'tab' | 'group'
  id: string
}

export interface WorkspaceTabDestination {
  beforeId?: string
  groupId?: string
}

// Hovering only previews a destination. Commit both the order and membership
// here on drop, so cancelling a drag leaves the saved layout unchanged.
export function dropWorkspaceTabs(layout: WorkspaceLayoutState, source: WorkspaceTabDrag, destination: WorkspaceTabDestination): WorkspaceLayoutState {
  const members = layout.views.filter((view) => source.kind === 'group' ? view.groupId === source.id : view.id === source.id)
  if (!members.length || (destination.beforeId && !layout.views.some((view) => view.id === destination.beforeId))) return layout
  if (destination.groupId && !layout.groups?.some((group) => group.id === destination.groupId)) return layout
  if (source.kind === 'group' && members.some((view) => view.id === destination.beforeId)) return layout
  const views = layout.views.filter((view) => !members.includes(view))
  const index = destination.beforeId
    ? destination.beforeId === source.id
      ? Math.min(layout.views.indexOf(members[0]!), views.length)
      : views.findIndex((view) => view.id === destination.beforeId)
    : views.length
  if (index < 0) return layout
  views.splice(index, 0, ...members.map((view) => source.kind === 'tab' ? withGroup(view, destination.groupId) : view))
  if (views.every((view, i) => view === layout.views[i])) return layout
  return normalizeTabGroups({ ...layout, views })
}
