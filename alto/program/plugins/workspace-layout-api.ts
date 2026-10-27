import type { ComponentType, Dispatch, KeyboardEvent, MouseEvent, ReactNode, RefObject, SetStateAction } from 'react'
import type { LocalProject, ThreadSummary } from '../../src/shared/protocol.js'
import type { ClientSessionService } from './session-api.js'
import type {
  WorkspaceOpenPaneRequest,
  WorkspaceOpenPaneResult,
} from './workspace-commands-api.js'
import type { WorkspaceLayoutState, WorkspacePaneNode, WorkspaceView, WorkspaceTabNameBinding } from './workspace-layout-state.js'
import type {
  WorkspaceHistoryDirection,
  WorkspaceMoveDirection,
} from './workspace-layout-state.js'

export type WorkspacePanePlacement =
  | 'pane-title'
  | 'after-header'
  | 'conversation-overlay'
  | 'before-composer'

export interface WorkspacePaneAddonProps {
  workspaceId: string
  paneId: string
  focused: boolean
  visible: boolean
  session: ClientSessionService
}

export type WorkspacePaneAddonRenderer = ComponentType<WorkspacePaneAddonProps>

export interface WorkspacePaneAddon {
  id: string
  placement: WorkspacePanePlacement
  order?: number
  renderer: WorkspacePaneAddonRenderer
}

export interface WorkspacePaneAddonRegistration {
  dispose(): Promise<void>
}

export interface WorkspaceTabAddonProps {
  workspaceId: string
  active: boolean
  threadIds: readonly string[]
}

export interface WorkspaceTabAddon {
  id: string
  order?: number
  renderer: ComponentType<WorkspaceTabAddonProps>
}

export interface WorkspaceTabAddonRegistration {
  dispose(): Promise<void>
}

export interface WorkspaceTabPresentation {
  inert?: boolean
  className?: string
  color?: string
  dropIndicator?: 'before' | 'after' | 'inside'
  onContextMenu?(event: MouseEvent<HTMLElement>): void
  onKeyDown?(event: KeyboardEvent<HTMLElement>): void
}

export interface WorkspaceTabStripProps {
  layout: WorkspaceLayoutState
  change: Dispatch<SetStateAction<WorkspaceLayoutState>>
  rootRef: RefObject<HTMLDivElement | null>
  beginDrag(viewId: string | undefined): void
  renderTab(view: WorkspaceView, index: number, presentation?: WorkspaceTabPresentation): ReactNode
  children: ReactNode
  tabActions?: readonly WorkspaceTabAction[]
  overlays?: import('../../src/client/plugin-api.js').ClientOverlays
}

export interface WorkspaceTabStrip {
  id: string
  renderer: ComponentType<WorkspaceTabStripProps>
}

export interface WorkspacePaneTarget {
  workspaceId: string
  paneId: string
  focused: boolean
  session: ClientSessionService
}

export interface WorkspacePaneKindProps {
  workspaceId: string
  pane: WorkspacePaneNode
  focused: boolean
  visible: boolean
  /** Available when the workspace can remove this pane without becoming empty. */
  closePane?: () => void
}

export interface WorkspacePaneKind {
  id: string
  label: string
  description?: string
  /** Makes this pane the landing view for newly created workspace tabs. */
  newTab?: boolean
  /** One-key shortcut used while the pane picker is open. */
  shortcut?: string
  icon?: ComponentType<{ size?: number }>
  renderer: ComponentType<WorkspacePaneKindProps>
}

export interface WorkspacePaneKindRegistration {
  dispose(): Promise<void>
}

export interface WorkspacePage {
  id: string
  label: string
  renderer: ComponentType<{ visible: boolean }>
  /** Remove persisted panes of this kind when upgrading a pane into a page. */
  replacesPaneKind?: string
}

export interface WorkspaceTabNameSource {
  id: string
  name(id: string): string | undefined
  rename(id: string, name: string): Promise<void>
  subscribe(listener: () => void): () => void
  /** Whether a saved binding still belongs to this tab's current contents. */
  valid?(id: string, view: WorkspaceView): boolean
  /** Associates an existing tab when it has no saved binding. */
  match?(view: WorkspaceView): string | undefined
}

export interface WorkspaceTabTarget {
  id: string
  title: string
  nameBinding?: WorkspaceTabNameBinding
  active: boolean
  threadIds: readonly string[]
  threads?: readonly ThreadSummary[]
  paneKinds?: readonly string[]
}

export interface WorkspaceTabAction {
  id: string
  label: string
  order?: number
  available(tab: WorkspaceView): boolean
  run(tab: WorkspaceView): void
}

export const WORKSPACE_NEW_CHAT_EVENT = 'alto:workspace-new-chat'

/** Request a tab from the mounted compositor and report whether it handled the click. */
export function requestWorkspaceNewChat(projectId?: string): boolean {
  const event = new CustomEvent<{ projectId?: string }>(WORKSPACE_NEW_CHAT_EVENT, {
    cancelable: true,
    detail: projectId ? { projectId } : {},
  })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

export interface ClientWorkspaceLayoutService {
  subscribe(listener: () => void): () => void
  snapshot(): number
  available(): boolean
  canCloseActiveTab(): boolean
  closeActiveTab(): void
  closeTab(workspaceId: string): void
  renameActiveTab(): void
  linkTabName(workspaceId: string, binding: WorkspaceTabNameBinding): void
  registerTabNameSource(owner: import('cordis').Context, source: WorkspaceTabNameSource): WorkspaceTabAddonRegistration
  canRestoreClosedTab(): boolean
  restoreClosedTab(): void
  canCloseFocusedPane(): boolean
  closeFocusedPane(): void
  cycleTabs(direction: 1 | -1): void
  selectTab(index: number): void
  tabs(): readonly WorkspaceTabTarget[]
  moveActiveTab(direction: 1 | -1): void
  /** Open a full-size tab; omit kind for the normal new-chat behavior. */
  newTab(kind?: string, thread?: ThreadSummary, project?: LocalProject | null): void
  showThreadInPane(workspaceId: string, paneId: string, thread: ThreadSummary): void
  openPane(
    request: Omit<WorkspaceOpenPaneRequest, 'id' | 'action'>,
  ): WorkspaceOpenPaneResult
  splitFocused(direction: 'horizontal' | 'vertical', kind?: string): void
  togglePaneKind(kind: string): void
  focusAdjacentPane(direction: WorkspaceMoveDirection, cycleTabAtEdge?: boolean): void
  resizeFocusedPane(direction: 1 | -1): void
  toggleFocusedPaneFullscreen(): void
  canNavigateHistory(direction: WorkspaceHistoryDirection): boolean
  navigateHistory(direction: WorkspaceHistoryDirection): void
  /** Omit direction for all chats; otherwise return the adjacent chat in the active tab without moving focus. */
  paneTargets(direction?: WorkspaceMoveDirection): readonly WorkspacePaneTarget[]
  hasThread(threadId: string): boolean
  focusThread(threadId: string): boolean
  focusPane(workspaceId: string, paneId: string): boolean
  addons(placement: WorkspacePanePlacement): readonly WorkspacePaneAddon[]
  tabAddons(): readonly WorkspaceTabAddon[]
  paneKinds(): readonly WorkspacePaneKind[]
  tabStrip(): WorkspaceTabStrip | undefined
  pages(): readonly WorkspacePage[]
  activePage(): WorkspacePage | undefined
  /** Omit the ID to return to the selected workspace tab. */
  showPage(id?: string): void
  registerPage(owner: import('cordis').Context, page: WorkspacePage): WorkspacePaneKindRegistration
  tabActions(): readonly WorkspaceTabAction[]
  registerTabAction(owner: import('cordis').Context, action: WorkspaceTabAction): WorkspaceTabAddonRegistration
  /** Replaces only the tab bar contents; pane trees keep their existing owners and keys. */
  registerTabStrip(owner: import('cordis').Context, strip: WorkspaceTabStrip): WorkspaceTabAddonRegistration
  registerPaneAddon(
    owner: import('cordis').Context,
    addon: WorkspacePaneAddon,
  ): WorkspacePaneAddonRegistration
  registerTabAddon(
    owner: import('cordis').Context,
    addon: WorkspaceTabAddon,
  ): WorkspaceTabAddonRegistration
  registerPaneKind(
    owner: import('cordis').Context,
    kind: WorkspacePaneKind,
  ): WorkspacePaneKindRegistration
}

declare module 'cordis' {
  interface Context {
    clientWorkspaceLayout: ClientWorkspaceLayoutService
  }
}
