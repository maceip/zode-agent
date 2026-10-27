import type { ThreadSummary } from '../../src/shared/protocol.js'
import { workspacePane, workspacePaneIds, type WorkspaceView } from './workspace-layout-state.js'

export function workspaceViewThreads(view: WorkspaceView): ThreadSummary[] {
  const threads = workspacePaneIds(view.root).flatMap((id) => {
    const pane = workspacePane(view.root, id)
    return pane?.thread && (!pane.kind || pane.kind === 'chat') ? [pane.thread] : []
  })
  return [...new Map(threads.map((thread) => [thread.id, thread])).values()]
}
export function workspaceViewPaneKinds(view: WorkspaceView): string[] {
  return workspacePaneIds(view.root).map((id) => workspacePane(view.root, id)?.kind ?? 'chat')
}
