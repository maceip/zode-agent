import { firstWorkspacePane, removeWorkspacePane, workspacePane, workspacePaneIds, type WorkspaceLayoutState, type WorkspaceView } from './workspace-layout-state.js'
import { normalizeTabGroups } from './workspace-tab-groups.js'

export function removeWorkspacePaneKind(layout: WorkspaceLayoutState, kind: string): WorkspaceLayoutState {
  let changed = false
  const views: WorkspaceView[] = []
  for (const view of layout.views) {
    let root: WorkspaceView['root'] | undefined = view.root
    for (const id of workspacePaneIds(view.root)) {
      if (root && workspacePane(view.root, id)?.kind === kind) root = removeWorkspacePane(root, id)
    }
    if (root === view.root) { views.push(view); continue }
    changed = true
    if (!root) continue
    const next = { ...view, root }
    if (!workspacePane(root, next.focusedPaneId)) next.focusedPaneId = firstWorkspacePane(root).id
    if (next.maximizedPaneId && !workspacePane(root, next.maximizedPaneId)) delete next.maximizedPaneId
    views.push(next)
  }
  if (!changed) return layout
  // The workspace always needs a normal tab, even when its only saved pane was the old page.
  if (!views.length) {
    const previous = layout.views[0]!
    const pane = { type: 'pane' as const, id: previous.id + '-chat-pane', workspace: previous.workspace, unscoped: true }
    views.push({ id: previous.id + '-chat', name: 'New chat', workspace: previous.workspace, unscoped: true, focusedPaneId: pane.id, root: pane })
  }
  return normalizeTabGroups({ ...layout, views, activeViewId: views.some((view) => view.id === layout.activeViewId) ? layout.activeViewId : views[0]!.id })
}
