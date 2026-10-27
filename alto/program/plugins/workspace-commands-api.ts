import type { Context } from 'cordis'
import type { ThreadSummary } from '../../src/shared/protocol.js'

export const WORKSPACE_COMMAND_STATE = 'workspace-layout.commands'
export const WORKSPACE_COMMAND_CLAIM_METHOD = 'workspace-layout.command-claim'
export const WORKSPACE_COMMAND_RESULT_METHOD = 'workspace-layout.command-result'

export type WorkspacePaneDirection = 'horizontal' | 'vertical'

export interface WorkspaceOpenPaneRequest {
  id: string
  action: 'open-pane'
  anchorThreadId?: string
  /** Exact pane anchor, including chats which do not have a thread yet. */
  anchor?: { workspaceId: string; paneId: string }
  direction: WorkspacePaneDirection
  kind: string
  thread?: ThreadSummary
  workspace?: string
  projectId?: string
  /** Opaque, persisted resource identifier interpreted by the pane-kind plugin. */
  resource?: string
}

export interface WorkspaceOpenPaneResult {
  workspaceId: string
  paneId: string
  threadId?: string
}

export interface WorkspaceCommandSnapshot {
  version: 1
  revision: number
  requests: WorkspaceOpenPaneRequest[]
}

export interface WorkspaceCommandService {
  openPane(
    request: Omit<WorkspaceOpenPaneRequest, 'id' | 'action'>,
  ): Promise<WorkspaceOpenPaneResult>
}

declare module 'cordis' {
  interface Context {
    workspaceCommands: WorkspaceCommandService
  }
}
