import paneToolbarCss from '../../src/client/pane-toolbar.css'
// Register the shared toolbar CSS from the live plugin so its styles update with Cordis.
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Columns2,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Pencil,
  Plus,
  Rows2,
  X,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  memo,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type {
  ChatAttachment,
  ChatImage,
  JsonValue,
  LocalProject,
  ThreadSummary,
  UiSnapshot,
  UiSurface,
} from '../../src/shared/protocol.js'
import type {
  BrowserPlugin,
  ClientComponentRenderer,
  ClientContributionRenderer,
  ClientHostService,
  ClientSurfaceRenderer,
  ClientUiService,
} from '../../src/client/plugin-api.js'
import type { Context } from 'cordis'
import {
  COMPOSER_COMPONENT,
  CONVERSATION_COMPONENT,
  DEFAULT_COMPOSER_PLACEHOLDER,
  type ComposerComponentProps,
  type ConversationComponentProps,
} from './chat-surfaces-api.js'
import type {
  ClientSessionFactoryService,
  ClientSessionHandle,
  ClientSessionRouterService,
  ClientSessionService,
  ClientSessionSnapshot,
} from './session-api.js'
import {
  WORKSPACE_PANE_HOTKEY_ACTIONS,
  type WorkspacePaneHotkeyActionId,
} from './workspace-hotkey-actions.js'
import type {
  ClientWorkspaceLayoutService,
  WorkspacePaneAddon,
  WorkspacePaneKind,
  WorkspacePage,
  WorkspaceTabNameSource,
  WorkspacePanePlacement,
  WorkspacePaneTarget,
  WorkspaceTabAddon,
  WorkspaceTabAction,
  WorkspaceTabTarget,
  WorkspaceTabStrip,
  WorkspaceTabStripProps,
} from './workspace-layout-api.js'
import { WORKSPACE_NEW_CHAT_EVENT } from './workspace-layout-api.js'
import type {
  WorkspaceOpenPaneRequest,
  WorkspaceOpenPaneResult,
} from './workspace-commands-api.js'
import { useStoreSelector } from './ui/store-selector.js'
import { isAgentChatId } from './agent-chats-api.js'
import { defaultWorkspace } from './session-defaults.js'
import {
  adjacentWorkspacePane,
  canNavigateWorkspacePane,
  mapWorkspacePane,
  navigateWorkspacePane,
  parseWorkspaceLayout,
  recordWorkspacePaneLocation,
  removeWorkspacePane,
  resizeWorkspaceSplit,
  resizeWorkspacePane,
  splitWorkspacePane,
  workspacePane,
  workspacePaneOfKind,
  workspacePaneIds,
  WORKSPACE_LAYOUT_READ_METHOD,
  WORKSPACE_LAYOUT_WRITE_METHOD,
  type WorkspaceHistoryDirection,
  type WorkspaceLayoutNode,
  type WorkspaceLayoutState,
  type WorkspaceMoveDirection,
  type WorkspacePaneNode,
  type WorkspaceSplitDirection,
  type WorkspaceSplitNode,
  type WorkspaceView,
  type WorkspaceTabNameBinding,
} from './workspace-layout-state.js'
import { removeWorkspacePaneKind } from './workspace-pages.js'
import styles from './workspace-layout.css'
import { WorkspaceTabActionMenu } from './workspace-tab-menu.client.js'
import { workspaceViewThreads, workspaceViewPaneKinds } from './workspace-tab-data.js'
import { activateWorkspaceTab, moveWorkspaceTab, normalizeTabGroups, type WorkspaceTabGroup } from './workspace-tab-groups.js'

const STORAGE_KEY = 'codex-cordis.workspace-layout'
const conversationSurface: UiSurface = {
  id: 'workspace-layout-conversation',
  kind: 'conversation',
  emptyState: 'none',
  markdown: true,
}
const workspaceComposerSurface: UiSurface = {
  id: 'workspace-layout-composer',
  kind: 'composer',
  placeholder: DEFAULT_COMPOSER_PLACEHOLDER,
  focusHeight: 156,
  maxHeight: 180,
  capabilities: ['skills', 'markdown', 'images', 'files'],
}
const settingsSurface: UiSurface = {
  id: 'default-settings',
  kind: 'settings',
  label: 'Settings',
  appearance: 'icon',
}
const pluginsSurface: UiSurface = {
  id: 'default-plugins',
  kind: 'plugins',
  label: 'Plugins',
  appearance: 'icon',
}

let serial = 0

export interface WorkspaceNewTabOption {
  id: string
  label: string
  detail: string
  project?: LocalProject
}

export function workspaceNewTabOptions(
  projects: readonly LocalProject[],
): WorkspaceNewTabOption[] {
  return [
    {
      id: 'no-workspace',
      label: 'No workspace',
      detail: 'Start a chat without a folder',
    },
    ...projects.map((project) => ({
      id: `project:${project.id}`,
      label: project.name,
      detail: project.primaryRoot,
      project,
    })),
  ]
}


export interface WorkspacePickerPlacement {
  left: number
  top: number
}

export function workspacePickerPlacement(
  anchor: { right: number; bottom: number },
  container: { left: number; top: number; width: number },
  menuWidth: number,
  gutter = 12,
  gap = 6,
): WorkspacePickerPlacement {
  const availableWidth = Math.max(0, container.width - (gutter * 2))
  const effectiveMenuWidth = Math.min(Math.max(0, menuWidth), availableWidth)
  const minimumLeft = gutter
  const maximumLeft = Math.max(minimumLeft, container.width - effectiveMenuWidth - gutter)
  const preferredLeft = anchor.right - container.left - effectiveMenuWidth

  return {
    left: Math.min(Math.max(preferredLeft, minimumLeft), maximumLeft),
    top: Math.max(gutter, anchor.bottom - container.top + gap),
  }
}

interface PaneDraft {
  message: string
  images: readonly ChatImage[]
  attachments: readonly ChatAttachment[]
}

interface PaneDraftStore {
  read(): Readonly<PaneDraft> | undefined
  write(draft: Readonly<PaneDraft>): void
}

interface ChatRenderers {
  Composer: ClientComponentRenderer<ComposerComponentProps>
  Conversation: ClientComponentRenderer<ConversationComponentProps>
}

interface WorkspaceLayoutController {
  canCloseActiveTab(): boolean
  closeActiveTab(): void
  closeTab?(workspaceId: string): void
  renameActiveTab(): void
  linkTabName?(workspaceId: string, binding: WorkspaceTabNameBinding): void
  canRestoreClosedTab(): boolean
  restoreClosedTab(): void
  canCloseFocusedPane(): boolean
  closeFocusedPane(): void
  cycleTabs(direction: 1 | -1): void
  selectTab(index: number): void
  tabs(): readonly WorkspaceTabTarget[]
  moveActiveTab(direction: 1 | -1): void
  newTab(kind?: string, thread?: ThreadSummary, project?: LocalProject | null): void
  showThreadInPane(workspaceId: string, paneId: string, thread: ThreadSummary): void
  openPane(
    request: Omit<WorkspaceOpenPaneRequest, 'id' | 'action'>,
  ): WorkspaceOpenPaneResult
  splitFocused(direction: WorkspaceSplitDirection, kind?: string): void
  togglePaneKind(kind: string): void
  focusAdjacentPane(direction: WorkspaceMoveDirection, cycleTabAtEdge?: boolean): void
  resizeFocusedPane(direction: 1 | -1): void
  toggleFocusedPaneFullscreen(): void
  canNavigateHistory(direction: WorkspaceHistoryDirection): boolean
  navigateHistory(direction: WorkspaceHistoryDirection): void
  paneTargets(direction?: WorkspaceMoveDirection): readonly WorkspacePaneTarget[]
  hasThread(threadId: string): boolean
  focusThread(threadId: string): boolean
  focusPane(workspaceId: string, paneId: string): boolean
}

export class WorkspaceLayoutRegistry implements ClientWorkspaceLayoutService {
  private readonly addonEntries = new Map<string, WorkspacePaneAddon>()
  private readonly tabActionEntries = new Map<string, WorkspaceTabAction>()
  private readonly tabAddonEntries = new Map<string, WorkspaceTabAddon>()
  private readonly paneKindEntries = new Map<string, WorkspacePaneKind>()
  private readonly tabNameSources = new Map<string, WorkspaceTabNameSource>()
  private readonly pageEntries = new Map<string, WorkspacePage>()
  private activePageId: string | undefined
  private tabStripEntry: WorkspaceTabStrip | undefined
  private readonly listeners = new Set<() => void>()
  private controller: WorkspaceLayoutController | undefined
  private tabTargets: readonly WorkspaceTabTarget[] = []
  private paneSelection = '[]'
  private revision = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): number => this.revision

  available(): boolean {
    return this.controller !== undefined
  }

  canCloseActiveTab(): boolean {
    return Boolean(this.activePageId) || (this.controller?.canCloseActiveTab() ?? false)
  }

  closeActiveTab(): void {
    if (this.activePageId) this.showPage()
    else this.controller?.closeActiveTab()
  }

  closeTab(workspaceId: string): void {
    this.controller?.closeTab?.(workspaceId)
  }

  linkTabName(workspaceId: string, binding: WorkspaceTabNameBinding): void {
    this.controller?.linkTabName?.(workspaceId, binding)
  }

  tabNameSource(id: string): WorkspaceTabNameSource | undefined {
    return this.tabNameSources.get(id)
  }

  syncTabNames(layout: WorkspaceLayoutState): WorkspaceLayoutState {
    let changed = false
    const views = layout.views.map((view) => {
      let binding = view.nameBinding
      if (!binding) {
        for (const source of this.tabNameSources.values()) {
          const id = source.match?.(view)
          if (id && source.valid?.(id, view) !== false) { binding = { source: source.id, id }; break }
        }
      }
      if (!binding) return view
      const source = this.tabNameSources.get(binding.source)
      if (!source) return view
      const name = source.name(binding.id)
      if (name === undefined || source.valid?.(binding.id, view) === false) {
        if (!view.nameBinding) return view
        changed = true
        const next = { ...view }
        delete next.nameBinding
        return next
      }
      if (view.name === name && view.nameBinding === binding) return view
      changed = true
      return { ...view, name, nameBinding: binding }
    })
    return changed ? { ...layout, views } : layout
  }

  registerTabNameSource(owner: Context, source: WorkspaceTabNameSource) {
    const dispose = owner.effect(() => {
      if (this.tabNameSources.has(source.id)) throw new Error('Duplicate tab name source: ' + source.id)
      this.tabNameSources.set(source.id, source)
      const unsubscribe = source.subscribe(() => this.emit())
      this.emit()
      return () => { unsubscribe(); this.tabNameSources.delete(source.id); this.emit() }
    }, 'workspace.tab-name.' + source.id)
    return { dispose: async () => dispose() }
  }

  renameActiveTab(): void {
    this.controller?.renameActiveTab()
  }

  canRestoreClosedTab(): boolean {
    return this.controller?.canRestoreClosedTab() ?? false
  }

  restoreClosedTab(): void {
    this.controller?.restoreClosedTab()
  }

  canCloseFocusedPane(): boolean {
    return !this.activePageId && (this.controller?.canCloseFocusedPane() ?? false)
  }

  closeFocusedPane(): void {
    if (!this.activePageId) this.controller?.closeFocusedPane()
  }

  cycleTabs(direction: 1 | -1): void {
    this.controller?.cycleTabs(direction)
  }

  selectTab(index: number): void {
    this.controller?.selectTab(index)
  }

  tabs(): readonly WorkspaceTabTarget[] {
    return this.controller?.tabs() ?? this.tabTargets
  }

  moveActiveTab(direction: 1 | -1): void {
    this.controller?.moveActiveTab(direction)
  }

  newTab(kind?: string, thread?: ThreadSummary, project?: LocalProject | null): void {
    if (project !== undefined) this.controller?.newTab(kind, thread, project)
    else if (thread) this.controller?.newTab(kind, thread)
    else this.controller?.newTab(kind)
  }

  showThreadInPane(workspaceId: string, paneId: string, thread: ThreadSummary): void {
    this.controller?.showThreadInPane(workspaceId, paneId, thread)
  }

  openPane(
    request: Omit<WorkspaceOpenPaneRequest, 'id' | 'action'>,
  ): WorkspaceOpenPaneResult {
    if (!this.controller) throw new Error('workspace layout is not available')
    return this.controller.openPane(request)
  }

  splitFocused(direction: WorkspaceSplitDirection, kind?: string): void {
    this.controller?.splitFocused(direction, kind)
  }

  togglePaneKind(kind: string): void {
    this.controller?.togglePaneKind(kind)
  }

  focusAdjacentPane(direction: WorkspaceMoveDirection, cycleTabAtEdge = false): void {
    this.controller?.focusAdjacentPane(direction, cycleTabAtEdge)
  }

  resizeFocusedPane(direction: 1 | -1): void {
    this.controller?.resizeFocusedPane(direction)
  }

  toggleFocusedPaneFullscreen(): void {
    this.controller?.toggleFocusedPaneFullscreen()
  }

  canNavigateHistory(direction: WorkspaceHistoryDirection): boolean {
    return this.controller?.canNavigateHistory(direction) ?? false
  }

  navigateHistory(direction: WorkspaceHistoryDirection): void {
    this.controller?.navigateHistory(direction)
  }

  paneTargets(direction?: WorkspaceMoveDirection): readonly WorkspacePaneTarget[] {
    return this.controller?.paneTargets(direction) ?? []
  }

  hasThread(threadId: string): boolean {
    return this.controller?.hasThread(threadId) ?? false
  }

  focusThread(threadId: string): boolean {
    return this.controller?.focusThread(threadId) ?? false
  }

  focusPane(workspaceId: string, paneId: string): boolean {
    return this.controller?.focusPane(workspaceId, paneId) ?? false
  }

  bindController(controller: WorkspaceLayoutController): () => void {
    this.controller = controller
    const tabs = controller.tabs()
    const directions: Array<WorkspaceMoveDirection | undefined> = [undefined, 'left', 'right', 'up', 'down']
    const paneSelection = JSON.stringify(directions.flatMap((direction) => (
      controller.paneTargets(direction)
        .filter((pane) => direction !== undefined || pane.focused)
        .map((pane) => [direction ?? 'focused', pane.workspaceId, pane.paneId])
    )))
    // Focus and neighboring chats can change without changing the tab list.
    // Publish those changes immediately, but not every streaming render.
    if (paneSelection !== this.paneSelection || tabs.length !== this.tabTargets.length || tabs.some((tab, index) => {
      const previous = this.tabTargets[index]
      return tab.id !== previous?.id || tab.title !== previous.title || tab.active !== previous.active
        || tab.threadIds.join('\0') !== previous.threadIds.join('\0')
        || tab.nameBinding?.source !== previous.nameBinding?.source || tab.nameBinding?.id !== previous.nameBinding?.id
        || (tab.paneKinds ?? []).join('\0') !== (previous.paneKinds ?? []).join('\0')
    })) {
      this.tabTargets = tabs
      this.paneSelection = paneSelection
      this.emit()
    }
    return () => {
      if (this.controller === controller) this.controller = undefined
    }
  }

  addons(placement: WorkspacePanePlacement): readonly WorkspacePaneAddon[] {
    return [...this.addonEntries.values()]
      .filter((addon) => addon.placement === placement)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  }

  tabAddons(): readonly WorkspaceTabAddon[] {
    return [...this.tabAddonEntries.values()]
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  }

  paneKinds(): readonly WorkspacePaneKind[] {
    return [...this.paneKindEntries.values()]
  }

  tabStrip(): WorkspaceTabStrip | undefined {
    return this.tabStripEntry
  }

  pages(): readonly WorkspacePage[] {
    return [...this.pageEntries.values()]
  }

  activePage(): WorkspacePage | undefined {
    return this.activePageId ? this.pageEntries.get(this.activePageId) : undefined
  }

  showPage(id?: string): void {
    if (id && !this.pageEntries.has(id)) return
    if (id === this.activePageId) return
    this.activePageId = id
    this.emit()
  }

  registerPage(owner: Context, page: WorkspacePage) {
    const dispose = owner.effect(() => {
      if (this.pageEntries.has(page.id)) throw new Error('Duplicate workspace page: ' + page.id)
      this.pageEntries.set(page.id, page)
      this.emit()
      return () => {
        this.pageEntries.delete(page.id)
        if (this.activePageId === page.id) this.activePageId = undefined
        this.emit()
      }
    }, 'workspace.page.' + page.id)
    return { dispose: async () => dispose() }
  }

  tabActions(): readonly WorkspaceTabAction[] {
    return [...this.tabActionEntries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  registerTabAction(owner: Context, action: WorkspaceTabAction) {
    const dispose = owner.effect(() => {
      if (this.tabActionEntries.has(action.id)) throw new Error('Duplicate tab action: ' + action.id)
      this.tabActionEntries.set(action.id, action)
      this.emit()
      return () => { this.tabActionEntries.delete(action.id); this.emit() }
    }, 'workspace.tab-action.' + action.id)
    return { dispose: async () => dispose() }
  }

  registerTabStrip(owner: Context, strip: WorkspaceTabStrip) {
    const dispose = owner.effect(() => {
      if (this.tabStripEntry) throw new Error(`workspace tab strip "${this.tabStripEntry.id}" is already registered`)
      this.tabStripEntry = strip
      this.emit()
      return () => {
        if (this.tabStripEntry === strip) this.tabStripEntry = undefined
        this.emit()
      }
    }, `clientWorkspaceLayout.registerTabStrip(${JSON.stringify(strip.id)})`)
    return { dispose: async () => dispose() }
  }

  registerPaneAddon(owner: Context, addon: WorkspacePaneAddon) {
    const dispose = owner.effect(() => {
      if (this.addonEntries.has(addon.id)) throw new Error(`workspace pane add-on "${addon.id}" is already registered`)
      this.addonEntries.set(addon.id, addon)
      this.emit()
      return () => {
        if (this.addonEntries.get(addon.id) === addon) this.addonEntries.delete(addon.id)
        this.emit()
      }
    }, `clientWorkspaceLayout.registerPaneAddon(${JSON.stringify(addon.id)})`)
    return { dispose: async () => dispose() }
  }

  registerTabAddon(owner: Context, addon: WorkspaceTabAddon) {
    const dispose = owner.effect(() => {
      if (this.tabAddonEntries.has(addon.id)) throw new Error(`workspace tab add-on "${addon.id}" is already registered`)
      this.tabAddonEntries.set(addon.id, addon)
      this.emit()
      return () => {
        if (this.tabAddonEntries.get(addon.id) === addon) this.tabAddonEntries.delete(addon.id)
        this.emit()
      }
    }, `clientWorkspaceLayout.registerTabAddon(${JSON.stringify(addon.id)})`)
    return { dispose: async () => dispose() }
  }

  registerPaneKind(owner: Context, kind: WorkspacePaneKind) {
    const dispose = owner.effect(() => {
      if (kind.id === 'chat') throw new Error('"chat" is reserved for the built-in workspace pane')
      if (this.paneKindEntries.has(kind.id)) throw new Error(`workspace pane kind "${kind.id}" is already registered`)
      const newTabOwner = kind.newTab
        ? [...this.paneKindEntries.values()].find((entry) => entry.newTab)
        : undefined
      if (newTabOwner) {
        throw new Error(`workspace pane kind "${kind.id}" conflicts with new-tab pane "${newTabOwner.id}"`)
      }
      const shortcut = kind.shortcut?.toLowerCase()
      if (shortcut && !/^[a-z0-9]$/.test(shortcut)) {
        throw new Error(`workspace pane kind "${kind.id}" shortcut must be one letter or number`)
      }
      if (shortcut === 'c') throw new Error('workspace pane shortcut "c" is reserved for Chat')
      const shortcutOwner = shortcut
        ? [...this.paneKindEntries.values()].find(
            (entry) => entry.shortcut?.toLowerCase() === shortcut,
          )
        : undefined
      if (shortcutOwner) {
        throw new Error(`workspace pane shortcut "${shortcut}" is already registered by "${shortcutOwner.id}"`)
      }
      this.paneKindEntries.set(kind.id, kind)
      this.emit()
      return () => {
        if (this.paneKindEntries.get(kind.id) === kind) this.paneKindEntries.delete(kind.id)
        this.emit()
      }
    }, `clientWorkspaceLayout.registerPaneKind(${JSON.stringify(kind.id)})`)
    return { dispose: async () => dispose() }
  }

  dispose(): void {
    this.controller = undefined
    this.addonEntries.clear()
    this.tabAddonEntries.clear()
    this.tabActionEntries.clear()
    this.tabNameSources.clear()
    this.tabStripEntry = undefined
    this.paneKindEntries.clear()
    this.pageEntries.clear()
    this.activePageId = undefined
    this.listeners.clear()
  }

  private emit(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}

function nextId(prefix: string): string {
  serial += 1
  return `${prefix}-${Date.now().toString(36)}-${serial.toString(36)}`
}

function currentThread(state: ClientSessionSnapshot): ThreadSummary | undefined {
  if (!state.threadId) return undefined
  return state.threads.find((thread) => thread.id === state.threadId)
    ?? (state.history.tag === 'ready' || state.history.tag === 'loading' || state.history.tag === 'failed'
      ? state.history.entries.find((thread) => thread.id === state.threadId)
      : undefined)
}

function paneFromSession(state: ClientSessionSnapshot, id = nextId('pane')): WorkspacePaneNode {
  const thread = currentThread(state)
  const pane: WorkspacePaneNode = {
    type: 'pane',
    id,
    workspace: thread?.cwd || state.session.workspace,
    ...(state.activeProjectId ? { projectId: state.activeProjectId } : {}),
    ...(state.projectScope === 'unscoped' ? { unscoped: true } : {}),
    ...(thread ? { thread } : {}),
  }
  return recordWorkspacePaneLocation(pane, {
    workspace: pane.workspace,
    ...(pane.projectId ? { projectId: pane.projectId } : {}),
    ...(pane.unscoped ? { unscoped: true } : {}),
    ...(thread ? { thread } : {}),
  })
}

function initialLayout(state: ClientSessionSnapshot): WorkspaceLayoutState {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = parseWorkspaceLayout(JSON.parse(stored))
      if (parsed) return parsed
    }
  } catch {
    // A fresh layout is enough when local storage is unavailable or corrupt.
  }
  const pane = paneFromSession(state)
  const project = state.projects.find((candidate) => candidate.id === state.activeProjectId)
    ?? state.projects.find((candidate) => candidate.primaryRoot === pane.workspace)
  const view: WorkspaceView = {
    id: nextId('workspace'),
    name: project?.name ?? 'Workspace',
    workspace: project?.primaryRoot ?? pane.workspace,
    ...(project ? { projectId: project.id } : {}),
    focusedPaneId: pane.id,
    root: pane,
  }
  return { version: 2, activeViewId: view.id, views: [view] }
}

function paneSnapshotEqual(
  left: ClientSessionSnapshot,
  right: ClientSessionSnapshot,
): boolean {
  return left.connected === right.connected
    && left.harness?.codex.status === right.harness?.codex.status
    && left.threadId === right.threadId
    && left.threads === right.threads
    && left.history === right.history
    && left.projects === right.projects
    && left.activeProjectId === right.activeProjectId
    && left.projectScope === right.projectScope
    && left.session.workspace === right.session.workspace
}

function usePaneSession(session: ClientSessionService): ClientSessionSnapshot {
  return useStoreSelector(session, sessionSnapshot, paneSnapshotEqual)
}

function sessionSnapshot(state: ClientSessionSnapshot): ClientSessionSnapshot {
  return state
}

interface WorkspaceGlobalSnapshot {
  projects: ClientSessionSnapshot['projects']
  ui: UiSnapshot | undefined
}

function workspaceGlobalSnapshot(state: ClientSessionSnapshot): WorkspaceGlobalSnapshot {
  return {
    projects: state.projects,
    ui: state.harness?.ui,
  }
}

function workspaceGlobalSnapshotEqual(
  left: WorkspaceGlobalSnapshot,
  right: WorkspaceGlobalSnapshot,
): boolean {
  return left.projects === right.projects && left.ui === right.ui
}

function threadMatchesPane(thread: ThreadSummary, pane: WorkspacePaneNode): boolean {
  if (pane.unscoped) return thread.projectId === undefined
  if (pane.projectId && thread.projectId) return pane.projectId === thread.projectId
  return !pane.workspace || !thread.cwd || pane.workspace === thread.cwd
}

function paneThreadSummary(state: ClientSessionSnapshot, pane: WorkspacePaneNode): ThreadSummary | undefined {
  return currentThread(state) ?? (state.threadId === pane.thread?.id ? pane.thread : undefined)
}

const PaneComposer = memo(function PaneComposer({
  active,
  session,
  draftStore,
  renderers,
}: {
  active: boolean
  session: ClientSessionService
  draftStore: PaneDraftStore
  renderers: ChatRenderers
}): ReactNode {
  const { Composer } = renderers
  return (
    <div className="workspace-pane-composer">
      <Composer
        surface={workspaceComposerSurface}
        session={session}
        autoFocus={active}
        draftStore={draftStore}
      />
    </div>
  )
})

const PaneConversation = memo(function PaneConversation({
  Conversation,
  session,
  focused,
  visible,
}: {
  Conversation: ClientComponentRenderer<ConversationComponentProps>
  session: ClientSessionService
  focused: boolean
  visible: boolean
}): ReactNode {
  return (
    <Conversation
      surface={conversationSurface}
      session={session}
      showUnscopedRequests={focused}
      visible={visible}
    />
  )
})

function ThreadPicker({
  pane,
  state,
  session,
  close,
  selected,
}: {
  pane: WorkspacePaneNode
  state: ClientSessionSnapshot
  session: ClientSessionService
  close: () => void
  selected: (thread?: ThreadSummary) => void
}): ReactNode {
  const threads = state.threads.filter((thread) => threadMatchesPane(thread, pane)).slice(0, 12)
  const project = state.projects.find((candidate) => candidate.id === pane.projectId)
    ?? state.projects.find((candidate) => candidate.primaryRoot === pane.workspace)
  const newChat = (): void => {
    session.newThread(pane.unscoped ? null : project)
    selected(undefined)
    close()
  }
  return (
    <div className="workspace-thread-picker" role="menu" aria-label="Choose chat">
      <button className="workspace-thread-new" type="button" role="menuitem" onClick={newChat}>
        <MessageSquarePlus size={14} />
        <span>New chat</span>
      </button>
      <div className="workspace-thread-picker-divider" />
      {threads.map((thread) => (
        <button
          className="workspace-thread-option"
          type="button"
          role="menuitemradio"
          aria-checked={thread.id === state.threadId}
          key={thread.id}
          onClick={() => {
            void session.openThread(thread)
            selected(thread)
            close()
          }}
        >
          <span>
            <strong>{thread.title || 'Untitled chat'}</strong>
            {thread.preview && <small>{thread.preview}</small>}
          </span>
          {thread.id === state.threadId && <Check size={14} />}
        </button>
      ))}
      {!threads.length && <div className="workspace-thread-empty">No chats in this workspace yet.</div>}
    </div>
  )
}

interface PendingSplit {
  viewId: string
  paneId: string
  direction: WorkspaceSplitDirection
}

function PaneKindPicker({
  kinds,
  choose,
  close,
}: {
  kinds: readonly WorkspacePaneKind[]
  choose: (kind?: string) => void
  close: () => void
}): ReactNode {
  const firstOption = useRef<HTMLButtonElement>(null)
  const closeRef = useRef(close)
  const chooseRef = useRef(choose)
  const kindsRef = useRef(kinds)
  closeRef.current = close
  chooseRef.current = choose
  kindsRef.current = kinds

  useEffect(() => {
    firstOption.current?.focus()
    const keydown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const shortcut = event.key.toLowerCase()
      const kind = kindsRef.current.find(
        (entry) => entry.shortcut?.toLowerCase() === shortcut,
      )
      if (shortcut !== 'c' && !kind) return
      event.preventDefault()
      event.stopPropagation()
      chooseRef.current(kind?.id)
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])

  return (
    <div
      className="workspace-pane-kind-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="workspace-pane-kind-picker" data-native-overlay="workspace-pane-kind" role="dialog" aria-modal="true" aria-label="Choose a pane type">
        <header className="workspace-pane-kind-header">
          <strong>New pane</strong>
          <small>Pane types</small>
        </header>
        <div className="workspace-pane-kind-options">
          <button ref={firstOption} type="button" onClick={() => choose()}>
            <kbd>C</kbd>
            <span><strong>Chat</strong></span>
            <MessageSquarePlus size={14} />
          </button>
          {kinds.map((kind) => {
            const Icon = kind.icon
            return (
              <button type="button" onClick={() => choose(kind.id)} key={kind.id}>
                {kind.shortcut ? <kbd>{kind.shortcut.toUpperCase()}</kbd> : <span />}
                <span><strong>{kind.label}</strong></span>
                {Icon ? <Icon size={14} /> : <Plus size={14} />}
              </button>
            )
          })}
        </div>
        <footer className="workspace-pane-kind-footer"><kbd>Esc</kbd><span>Cancel</span></footer>
      </div>
    </div>
  )
}

function WorkspacePaneActionButton({
  hotkeyAction,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  hotkeyAction: WorkspacePaneHotkeyActionId | null
}): ReactNode {
  return (
    <button
      {...props}
      type="button"
      {...(hotkeyAction ? { 'data-hotkey-action': hotkeyAction } : {})}
    />
  )
}

function PaneFullscreenButton({
  fullscreen,
  toggle,
}: {
  fullscreen: boolean
  toggle: () => void
}): ReactNode {
  const label = fullscreen ? 'Restore split panes' : 'Full screen pane'
  const Icon = fullscreen ? Minimize2 : Maximize2
  return (
    <WorkspacePaneActionButton
      className={`workspace-pane-fullscreen${fullscreen ? ' is-active' : ''}`}
      hotkeyAction={WORKSPACE_PANE_HOTKEY_ACTIONS.fullscreen}
      title={label}
      aria-label={label}
      aria-pressed={fullscreen}
      onClick={toggle}
    >
      <Icon size={14} />
    </WorkspacePaneActionButton>
  )
}

function WorkspacePaneActions({
  close,
  focused,
  fullscreen,
  onlyPane,
  split,
  toggleFullscreen,
}: {
  close: () => void
  focused: boolean
  fullscreen: boolean
  onlyPane: boolean
  split: (direction: WorkspaceSplitDirection) => void
  toggleFullscreen: () => void
}): ReactNode {
  return (
    <div className="workspace-pane-actions">
      <div className="workspace-pane-action-group">
        <WorkspacePaneActionButton hotkeyAction={WORKSPACE_PANE_HOTKEY_ACTIONS.splitRight} title="Vertical split" aria-label="Split pane vertically" onClick={() => split('horizontal')}>
          <Columns2 size={14} />
        </WorkspacePaneActionButton>
        <WorkspacePaneActionButton hotkeyAction={WORKSPACE_PANE_HOTKEY_ACTIONS.splitDown} title="Horizontal split" aria-label="Split pane horizontally" onClick={() => split('vertical')}>
          <Rows2 size={14} />
        </WorkspacePaneActionButton>
      </div>
      <div className="workspace-pane-action-group">
        <PaneFullscreenButton fullscreen={fullscreen} toggle={toggleFullscreen} />
        {!onlyPane && (
          <WorkspacePaneActionButton hotkeyAction={focused ? WORKSPACE_PANE_HOTKEY_ACTIONS.close : null} title="Close pane" aria-label="Close pane" onClick={close}>
            <X size={14} />
          </WorkspacePaneActionButton>
        )}
      </div>
    </div>
  )
}

function PaneRuntime({
  workspaceId,
  pane,
  active,
  focused,
  visible,
  fullscreen,
  onlyPane,
  session,
  renderers,
  split,
  close,
  focus,
  toggleFullscreen,
  changed,
  selected,
  addons,
  draftStore,
  tabDropEdge,
}: {
  workspaceId: string
  pane: WorkspacePaneNode
  active: boolean
  focused: boolean
  visible: boolean
  fullscreen: boolean
  onlyPane: boolean
  session: ClientSessionService
  renderers: ChatRenderers
  split: (direction: WorkspaceSplitDirection, state: ClientSessionSnapshot) => void
  close: () => void
  focus: () => void
  toggleFullscreen: () => void
  changed: (state: ClientSessionSnapshot) => void
  selected: (thread: ThreadSummary | undefined, state: ClientSessionSnapshot) => void
  addons: readonly WorkspacePaneAddon[]
  draftStore: PaneDraftStore
  tabDropEdge?: WorkspaceTabDropEdge
}): ReactNode {
  const state = usePaneSession(session)
  const { Conversation } = renderers
  const [pickerOpen, setPickerOpen] = useState(false)
  const [renamingThreadId, setRenamingThreadId] = useState<string>()
  const [renamingThreadName, setRenamingThreadName] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState<string>()
  const renameInput = useRef<HTMLInputElement>(null)
  const renameInFlight = useRef(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const thread = paneThreadSummary(state, pane)
  const title = thread?.title || (state.threadId ? pane.thread?.title : undefined) || 'New chat'

  // Renderer hot reloads recreate the parent action callbacks. Keep the latest
  // callback without treating its identity as another pane-location change.
  const changedRef = useRef(changed)
  changedRef.current = changed

  useEffect(() => changedRef.current(state), [
    state.activeProjectId,
    state.history,
    state.projectScope,
    state.session.workspace,
    state.threadId,
    state.threads,
  ])

  useLayoutEffect(() => {
    if (!renamingThreadId) return
    renameInput.current?.focus()
    renameInput.current?.select()
  }, [renamingThreadId])

  useEffect(() => {
    setRenamingThreadId(undefined)
    setRenamingThreadName('')
    setRenameSaving(false)
    setRenameError(undefined)
    renameInFlight.current = false
  }, [state.threadId])

  useEffect(() => {
    if (!pickerOpen) return
    const dismiss = (event: globalThis.PointerEvent): void => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false)
    }
    window.addEventListener('pointerdown', dismiss)
    return () => window.removeEventListener('pointerdown', dismiss)
  }, [pickerOpen])

  const clearRename = (): void => {
    setRenamingThreadId(undefined)
    setRenamingThreadName('')
    setRenameSaving(false)
    setRenameError(undefined)
  }

  const beginRename = (): void => {
    if (!thread || renameInFlight.current) return
    setPickerOpen(false)
    setRenamingThreadId(thread.id)
    setRenamingThreadName(thread.title)
    setRenameError(undefined)
  }

  const finishRename = async (save: boolean): Promise<void> => {
    if (renameInFlight.current) return
    const current = state.threads.find((candidate) => candidate.id === renamingThreadId)
      ?? (thread?.id === renamingThreadId ? thread : undefined)
    const name = renamingThreadName.trim()
    if (!save || !current || !name || name === current.title) {
      clearRename()
      return
    }
    renameInFlight.current = true
    setRenameSaving(true)
    setRenameError(undefined)
    try {
      await session.renameThread(current.id, name)
      clearRename()
    } catch (error) {
      setRenameSaving(false)
      setRenameError(error instanceof Error ? error.message : String(error))
    } finally {
      renameInFlight.current = false
    }
  }

  return (
    <section
      className={`workspace-chat-pane${focused ? ' is-focused' : ''}${fullscreen ? ' is-fullscreen' : ''}${tabDropEdge ? ` is-tab-drop-${tabDropEdge}` : ''}`}
      data-workspace-pane-id={pane.id}
      data-workspace-pane-fullscreen={fullscreen || undefined}
      onPointerDownCapture={focus}
    >
      <header className="workspace-pane-header">
        <div className="workspace-pane-title-control" ref={pickerRef}>
          {renamingThreadId && thread ? (
            <>
              <input
                ref={renameInput}
                className="workspace-pane-title-input"
                value={renamingThreadName}
                aria-label={`Rename ${thread.title}`}
                aria-invalid={renameError ? true : undefined}
                disabled={renameSaving}
                title={renameError}
                onChange={(event) => setRenamingThreadName(event.target.value)}
                onBlur={() => void finishRename(true)}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void finishRename(true)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    void finishRename(false)
                  }
                }}
              />
              {renameError && (
                <span className="workspace-pane-title-error" role="status">{renameError}</span>
              )}
            </>
          ) : (
            <>
              <button
                className="workspace-pane-title"
                type="button"
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                title={title}
                onClick={() => setPickerOpen((open) => !open)}
                onDoubleClick={(event) => {
                  if (!thread) return
                  event.preventDefault()
                  event.stopPropagation()
                  beginRename()
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'F2' || !thread) return
                  event.preventDefault()
                  beginRename()
                }}
              >
                <span className="workspace-pane-title-text">{title}</span>
              </button>
              {thread && (
                <button
                  className="icon-button shell-control workspace-pane-title-rename"
                  type="button"
                  title={`Rename ${title}`}
                  aria-label={`Rename ${title}`}
                  onClick={beginRename}
                >
                  <Pencil size={13} />
                </button>
              )}
            </>
          )}
          {pickerOpen && !renamingThreadId && (
            <ThreadPicker
              pane={pane}
              state={state}
              session={session}
              close={() => setPickerOpen(false)}
              selected={(next) => selected(next, session.snapshot())}
            />
          )}
        </div>
        {addons.filter((addon) => addon.placement === 'pane-title').map((addon) => {
          const Addon = addon.renderer
          return <Addon workspaceId={workspaceId} paneId={pane.id} focused={focused} visible={visible} session={session} key={addon.id} />
        })}
        <WorkspacePaneActions
          close={close}
          focused={focused}
          fullscreen={fullscreen}
          onlyPane={onlyPane}
          split={(direction) => split(direction, state)}
          toggleFullscreen={toggleFullscreen}
        />
      </header>
      {addons.filter((addon) => addon.placement === 'after-header').map((addon) => {
        const Addon = addon.renderer
        return <Addon workspaceId={workspaceId} paneId={pane.id} focused={focused} visible={visible} session={session} key={addon.id} />
      })}
      <div className="workspace-pane-conversation">
        <PaneConversation
          Conversation={Conversation}
          session={session}
          focused={focused}
          visible={visible}
        />
        {addons.filter((addon) => addon.placement === 'conversation-overlay').map((addon) => {
          const Addon = addon.renderer
          return <Addon workspaceId={workspaceId} paneId={pane.id} focused={focused} visible={visible} session={session} key={addon.id} />
        })}
      </div>
      {addons.filter((addon) => addon.placement === 'before-composer').map((addon) => {
        const Addon = addon.renderer
        return <Addon workspaceId={workspaceId} paneId={pane.id} focused={focused} visible={visible} session={session} key={addon.id} />
      })}
      <PaneComposer
        active={active}
        session={session}
        draftStore={draftStore}
        renderers={renderers}
      />
    </section>
  )
}

export function restoreWorkspacePaneSession(
  session: ClientSessionService,
  pane: WorkspacePaneNode,
): () => void {
  let initialized = false
  const initialize = (): void => {
    if (initialized) return
    const state = session.snapshot()
    if (!state.connected) return
    // Opening a saved Codex thread starts its runtime; ACP panes and empty
    // panes only need the Alto connection.
    initialized = true
    if (pane.thread) void session.openThread(pane.thread)
    else if (!pane.unscoped) {
      const project = state.projects.find((candidate) => candidate.id === pane.projectId)
        ?? state.projects.find((candidate) => candidate.primaryRoot === pane.workspace)
      if (project) session.selectProject(project)
    }
  }
  const unsubscribe = session.subscribe(initialize)
  initialize()
  return unsubscribe
}

function WorkspacePane({
  workspaceId,
  pane,
  active,
  focused,
  visible,
  fullscreen,
  onlyPane,
  factory,
  renderers,
  split,
  close,
  focus,
  toggleFullscreen,
  changed,
  selected,
  ready,
  addons,
  draftStore,
  tabDropEdge,
}: {
  workspaceId: string
  pane: WorkspacePaneNode
  active: boolean
  focused: boolean
  visible: boolean
  fullscreen: boolean
  onlyPane: boolean
  factory: ClientSessionFactoryService
  renderers: ChatRenderers
  split: (direction: WorkspaceSplitDirection, state: ClientSessionSnapshot) => void
  close: () => void
  focus: () => void
  toggleFullscreen: () => void
  changed: (state: ClientSessionSnapshot) => void
  selected: (thread: ThreadSummary | undefined, state: ClientSessionSnapshot) => void
  ready: (session: ClientSessionService | undefined) => void
  addons: readonly WorkspacePaneAddon[]
  draftStore: PaneDraftStore
  tabDropEdge?: WorkspaceTabDropEdge
}): ReactNode {
  const initialPane = useRef(pane)
  const readyRef = useRef(ready)
  const [handle, setHandle] = useState<ClientSessionHandle>()

  readyRef.current = ready

  useEffect(() => {
    const initial = initialPane.current
    const next = factory.create({
      // Empty projectless panes should adopt the current default, including
      // panes saved when that default was the Alto checkout.
      ...(!initial.unscoped || initial.thread ? { initialWorkspace: initial.workspace } : {}),
      ...(initial.unscoped
        ? { initialProjectId: null }
        : initial.projectId ? { initialProjectId: initial.projectId } : {}),
    })
    const unsubscribe = restoreWorkspacePaneSession(next.session, initial)
    setHandle(next)
    readyRef.current(next.session)
    return () => {
      readyRef.current(undefined)
      unsubscribe()
      next.dispose()
    }
  }, [factory, pane.id])

  if (!handle) return <section className={`workspace-chat-pane${focused ? ' is-focused' : ''}${tabDropEdge ? ` is-tab-drop-${tabDropEdge}` : ''}`} />
  return (
    <PaneRuntime
      workspaceId={workspaceId}
      pane={pane}
      active={active}
      focused={focused}
      visible={visible}
      fullscreen={fullscreen}
      onlyPane={onlyPane}
      session={handle.session}
      renderers={renderers}
      split={split}
      close={close}
      focus={focus}
      toggleFullscreen={toggleFullscreen}
      changed={changed}
      selected={selected}
      addons={addons}
      draftStore={draftStore}
      {...(tabDropEdge ? { tabDropEdge } : {})}
    />
  )
}

function WorkspaceTypedPane({
  workspaceId,
  pane,
  focused,
  fullscreen,
  visible,
  onlyPane,
  kind,
  split,
  close,
  focus,
  toggleFullscreen,
  tabDropEdge,
}: {
  workspaceId: string
  pane: WorkspacePaneNode
  focused: boolean
  fullscreen: boolean
  visible: boolean
  onlyPane: boolean
  kind: WorkspacePaneKind | undefined
  split: (direction: WorkspaceSplitDirection) => void
  close: () => void
  focus: () => void
  toggleFullscreen: () => void
  tabDropEdge?: WorkspaceTabDropEdge
}): ReactNode {
  const Renderer = kind?.renderer
  return (
    <section
      className={`workspace-chat-pane workspace-typed-pane${focused ? ' is-focused' : ''}${fullscreen ? ' is-fullscreen' : ''}${tabDropEdge ? ` is-tab-drop-${tabDropEdge}` : ''}`}
      data-workspace-pane-id={pane.id}
      data-workspace-pane-kind={pane.kind}
      data-workspace-pane-fullscreen={fullscreen || undefined}
      onPointerDownCapture={focus}
    >
      <header className="workspace-pane-header">
        <div className="workspace-pane-title workspace-typed-pane-title">
          <strong>{kind?.label ?? pane.kind ?? 'Plugin pane'}</strong>
          <span>{pane.workspace}</span>
        </div>
        <WorkspacePaneActions
          close={close}
          focused={focused}
          fullscreen={fullscreen}
          onlyPane={onlyPane}
          split={split}
          toggleFullscreen={toggleFullscreen}
        />
      </header>
      <div className="workspace-typed-pane-content">
        {Renderer
          ? (
              <Renderer
                workspaceId={workspaceId}
                pane={pane}
                focused={focused}
                visible={visible}
                {...(!onlyPane ? { closePane: close } : {})}
              />
            )
          : <div className="workspace-typed-pane-missing">Enable the {pane.kind} plugin to restore this pane.</div>}
      </div>
    </section>
  )
}

function SplitDivider({
  split,
  resize,
}: {
  split: WorkspaceSplitNode
  resize: (ratio: number) => void
}): ReactNode {
  const divider = useRef<HTMLButtonElement>(null)

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    const container = divider.current?.parentElement
    if (!container) return
    event.preventDefault()
    const move = (pointer: PointerEvent): void => {
      const bounds = container.getBoundingClientRect()
      const ratio = split.direction === 'horizontal'
        ? (pointer.clientX - bounds.left) / bounds.width
        : (pointer.clientY - bounds.top) / bounds.height
      resize(ratio)
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.documentElement.classList.remove('is-resizing-workspace-pane')
    }
    document.documentElement.classList.add('is-resizing-workspace-pane')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const keyResize = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const decrease = split.direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
    const increase = split.direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
    if (event.key !== decrease && event.key !== increase) return
    event.preventDefault()
    resize(split.ratio + (event.key === increase ? 0.04 : -0.04))
  }

  return (
    <button
      ref={divider}
      className="workspace-split-divider"
      type="button"
      role="separator"
      aria-label="Resize panes"
      aria-orientation={split.direction === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(split.ratio * 100)}
      onDoubleClick={() => resize(0.5)}
      onKeyDown={keyResize}
      onPointerDown={startResize}
    />
  )
}

interface TreeActions {
  factory: ClientSessionFactoryService
  renderers: ChatRenderers
  focusedPaneId: string
  maximizedPaneId?: string
  visible: boolean
  paneCount: number
  split(paneId: string, direction: WorkspaceSplitDirection, state?: ClientSessionSnapshot): void
  close(paneId: string): void
  focus(paneId: string): void
  toggleFullscreen(paneId: string): void
  resize(splitId: string, ratio: number): void
  changed(paneId: string, state: ClientSessionSnapshot): void
  selected(paneId: string, thread: ThreadSummary | undefined, state: ClientSessionSnapshot): void
  ready(paneId: string, session: ClientSessionService | undefined): void
  addons: readonly WorkspacePaneAddon[]
  paneKinds: readonly WorkspacePaneKind[]
  draftStore(paneId: string): PaneDraftStore
  tabDropTarget?: WorkspaceTabDropTarget
}

function LayoutTree({ workspaceId, node, actions }: { workspaceId: string; node: WorkspaceLayoutNode; actions: TreeActions }): ReactNode {
  if (node.type === 'pane') {
    const tabDropEdge = actions.tabDropTarget?.paneId === node.id
      ? actions.tabDropTarget.edge
      : undefined
    if (node.kind && node.kind !== 'chat') {
      return (
        <WorkspaceTypedPane
          workspaceId={workspaceId}
          pane={node}
          focused={node.id === actions.focusedPaneId}
          fullscreen={node.id === actions.maximizedPaneId}
          visible={actions.visible && (!actions.maximizedPaneId || node.id === actions.maximizedPaneId)}
          onlyPane={actions.paneCount === 1}
          kind={actions.paneKinds.find((kind) => kind.id === node.kind)}
          split={(direction) => actions.split(node.id, direction)}
          close={() => actions.close(node.id)}
          focus={() => actions.focus(node.id)}
          toggleFullscreen={() => actions.toggleFullscreen(node.id)}
          {...(tabDropEdge ? { tabDropEdge } : {})}
        />
      )
    }
    return (
      <WorkspacePane
        workspaceId={workspaceId}
        pane={node}
        active={actions.visible && node.id === actions.focusedPaneId}
        focused={node.id === actions.focusedPaneId}
        visible={actions.visible && (!actions.maximizedPaneId || node.id === actions.maximizedPaneId)}
        fullscreen={node.id === actions.maximizedPaneId}
        onlyPane={actions.paneCount === 1}
        factory={actions.factory}
        renderers={actions.renderers}
        split={(direction, state) => actions.split(node.id, direction, state)}
        close={() => actions.close(node.id)}
        focus={() => actions.focus(node.id)}
        toggleFullscreen={() => actions.toggleFullscreen(node.id)}
        changed={(state) => actions.changed(node.id, state)}
        selected={(thread, state) => actions.selected(node.id, thread, state)}
        ready={(session) => actions.ready(node.id, session)}
        addons={actions.addons}
        draftStore={actions.draftStore(node.id)}
        {...(tabDropEdge ? { tabDropEdge } : {})}
      />
    )
  }
  const fullscreenBranch = actions.maximizedPaneId
    ? workspacePane(node.first, actions.maximizedPaneId) ? 'first'
      : workspacePane(node.second, actions.maximizedPaneId) ? 'second'
        : undefined
    : undefined
  return (
    <div
      className={`workspace-split workspace-split-${node.direction}${fullscreenBranch ? ` is-fullscreen-${fullscreenBranch}` : ''}`}
      data-workspace-split-id={node.id}
      style={{ '--workspace-split-ratio': node.ratio } as CSSProperties}
    >
      <div className="workspace-split-first"><LayoutTree workspaceId={workspaceId} node={node.first} actions={actions} /></div>
      <SplitDivider split={node} resize={(ratio) => actions.resize(node.id, ratio)} />
      <div className="workspace-split-second"><LayoutTree workspaceId={workspaceId} node={node.second} actions={actions} /></div>
    </div>
  )
}

function WorkspaceLayoutControllerBridge({
  registry,
  canCloseActiveTab,
  closeActiveTab,
  closeTab,
  renameActiveTab,
  linkTabName,
  canRestoreClosedTab,
  restoreClosedTab,
  canCloseFocusedPane,
  closeFocusedPane,
  cycleTabs,
  selectTab,
  tabs,
  moveActiveTab,
  newTab,
  showThreadInPane,
  openPane,
  splitFocused,
  togglePaneKind,
  focusAdjacentPane,
  resizeFocusedPane,
  toggleFocusedPaneFullscreen,
  canNavigateHistory,
  navigateHistory,
  paneTargets,
  hasThread,
  focusThread,
  focusPane,
}: {
  registry: WorkspaceLayoutRegistry
  canCloseActiveTab: () => boolean
  closeActiveTab: () => void
  closeTab: (workspaceId: string) => void
  renameActiveTab: () => void
  linkTabName: (workspaceId: string, binding: WorkspaceTabNameBinding) => void
  canRestoreClosedTab: () => boolean
  restoreClosedTab: () => void
  canCloseFocusedPane: () => boolean
  closeFocusedPane: () => void
  cycleTabs: (direction: 1 | -1) => void
  selectTab: (index: number) => void
  tabs: () => readonly WorkspaceTabTarget[]
  moveActiveTab: (direction: 1 | -1) => void
  newTab: (kind?: string, thread?: ThreadSummary, project?: LocalProject | null) => void
  showThreadInPane: (workspaceId: string, paneId: string, thread: ThreadSummary) => void
  openPane: (
    request: Omit<WorkspaceOpenPaneRequest, 'id' | 'action'>,
  ) => WorkspaceOpenPaneResult
  splitFocused: (direction: WorkspaceSplitDirection, kind?: string) => void
  togglePaneKind: (kind: string) => void
  focusAdjacentPane: (direction: WorkspaceMoveDirection, cycleTabAtEdge?: boolean) => void
  resizeFocusedPane: (direction: 1 | -1) => void
  toggleFocusedPaneFullscreen: () => void
  canNavigateHistory: (direction: WorkspaceHistoryDirection) => boolean
  navigateHistory: (direction: WorkspaceHistoryDirection) => void
  paneTargets: (direction?: WorkspaceMoveDirection) => readonly WorkspacePaneTarget[]
  hasThread: (threadId: string) => boolean
  focusThread: (threadId: string) => boolean
  focusPane: (workspaceId: string, paneId: string) => boolean
}): null {
  useLayoutEffect(
    () => registry.bindController({
      canCloseActiveTab,
      closeActiveTab,
      closeTab,
      renameActiveTab,
      linkTabName,
      canRestoreClosedTab,
      restoreClosedTab,
      canCloseFocusedPane,
      closeFocusedPane,
      cycleTabs,
      selectTab,
      tabs,
      moveActiveTab,
      newTab,
      showThreadInPane,
      openPane,
      splitFocused,
      togglePaneKind,
      focusAdjacentPane,
      resizeFocusedPane,
      toggleFocusedPaneFullscreen,
      canNavigateHistory,
      navigateHistory,
      paneTargets,
      hasThread,
      focusThread,
      focusPane,
    }),
    [
      canCloseActiveTab,
      canRestoreClosedTab,
      canCloseFocusedPane,
      canNavigateHistory,
      closeActiveTab,
      closeTab,
      renameActiveTab,
      linkTabName,
      closeFocusedPane,
      cycleTabs,
      focusAdjacentPane,
      focusPane,
      focusThread,
      hasThread,
      moveActiveTab,
      navigateHistory,
      newTab,
      showThreadInPane,
      openPane,
      paneTargets,
      registry,
      resizeFocusedPane,
      restoreClosedTab,
      selectTab,
      tabs,
      splitFocused,
      togglePaneKind,
      toggleFocusedPaneFullscreen,
    ],
  )
  return null
}

function uniqueViewName(layout: WorkspaceLayoutState, base: string): string {
  if (!layout.views.some((view) => view.name === base)) return base
  let index = 2
  while (layout.views.some((view) => view.name === `${base} ${index}`)) index += 1
  return `${base} ${index}`
}

export interface ClosedWorkspaceTab {
  view: WorkspaceView
  index: number
  group?: WorkspaceTabGroup
}

export function closeWorkspaceTab(
  layout: WorkspaceLayoutState,
  viewId: string,
): { layout: WorkspaceLayoutState; closed?: ClosedWorkspaceTab } {
  if (layout.views.length <= 1) return { layout }
  const index = layout.views.findIndex((view) => view.id === viewId)
  const view = layout.views[index]
  if (!view) return { layout }
  const views = layout.views.filter((candidate) => candidate.id !== viewId)
  const fallback = views[Math.min(index, views.length - 1)] as WorkspaceView
  return {
    layout: normalizeTabGroups({
      ...layout,
      views,
      activeViewId: layout.activeViewId === viewId ? fallback.id : layout.activeViewId,
    }),
    closed: { view, index, ...(layout.groups?.find((group) => group.id === view.groupId)
      ? { group: layout.groups.find((group) => group.id === view.groupId)! } : {}) },
  }
}

export function restoreWorkspaceTab(
  layout: WorkspaceLayoutState,
  closed: ClosedWorkspaceTab,
): WorkspaceLayoutState {
  if (layout.views.some((view) => view.id === closed.view.id)) return layout
  const views = [...layout.views]
  views.splice(Math.min(Math.max(0, closed.index), views.length), 0, closed.view)
  const groups = closed.group && !layout.groups?.some((group) => group.id === closed.group!.id)
    ? [...(layout.groups ?? []), closed.group]
    : layout.groups
  return activateWorkspaceTab(normalizeTabGroups({ ...layout, views, ...(groups ? { groups } : {}) }), closed.view.id)
}

export interface ClosedWorkspacePane {
  viewId: string
  pane: WorkspacePaneNode
  siblingNodeId: string
  splitId: string
  direction: WorkspaceSplitDirection
  ratio: number
  panePosition: 'first' | 'second'
  wasMaximized: boolean
}

interface ClosedWorkspacePaneBranch extends Omit<ClosedWorkspacePane, 'viewId' | 'wasMaximized'> {
  root: WorkspaceLayoutNode
}

function closeWorkspacePaneBranch(
  node: WorkspaceLayoutNode,
  paneId: string,
): ClosedWorkspacePaneBranch | undefined {
  if (node.type === 'pane') return undefined

  const firstIsPane = node.first.type === 'pane' && node.first.id === paneId
  const secondIsPane = node.second.type === 'pane' && node.second.id === paneId
  if (firstIsPane || secondIsPane) {
    const pane = (firstIsPane ? node.first : node.second) as WorkspacePaneNode
    const sibling = firstIsPane ? node.second : node.first
    return {
      root: sibling,
      pane,
      siblingNodeId: sibling.id,
      splitId: node.id,
      direction: node.direction,
      ratio: node.ratio,
      panePosition: firstIsPane ? 'first' : 'second',
    }
  }

  const first = closeWorkspacePaneBranch(node.first, paneId)
  if (first) {
    return {
      ...first,
      root: { ...node, first: first.root },
    }
  }
  const second = closeWorkspacePaneBranch(node.second, paneId)
  return second
    ? {
        ...second,
        root: { ...node, second: second.root },
      }
    : undefined
}

export function closeWorkspacePane(
  view: WorkspaceView,
  paneId: string,
): { view: WorkspaceView; closed?: ClosedWorkspacePane } {
  if (workspacePaneIds(view.root).length <= 1) return { view }
  const result = closeWorkspacePaneBranch(view.root, paneId)
  if (!result) return { view }

  const panes = workspacePaneIds(result.root)
  const next: WorkspaceView = {
    ...view,
    root: result.root,
    focusedPaneId: view.focusedPaneId === paneId
      ? panes[0] as string
      : view.focusedPaneId,
  }
  if (view.maximizedPaneId === paneId) delete next.maximizedPaneId

  const { root: _root, ...closed } = result
  return {
    view: next,
    closed: {
      viewId: view.id,
      ...closed,
      wasMaximized: view.maximizedPaneId === paneId,
    },
  }
}

function restoreWorkspacePaneBranch(
  node: WorkspaceLayoutNode,
  targetNodeId: string,
  closed: ClosedWorkspacePane,
): { root: WorkspaceLayoutNode; restored: boolean } {
  if (node.id === targetNodeId) {
    const restored: WorkspaceSplitNode = {
      type: 'split',
      id: closed.splitId,
      direction: closed.direction,
      ratio: closed.ratio,
      first: closed.panePosition === 'first' ? closed.pane : node,
      second: closed.panePosition === 'second' ? closed.pane : node,
    }
    return { root: restored, restored: true }
  }
  if (node.type === 'pane') return { root: node, restored: false }

  const first = restoreWorkspacePaneBranch(node.first, targetNodeId, closed)
  if (first.restored) {
    return { root: { ...node, first: first.root }, restored: true }
  }
  const second = restoreWorkspacePaneBranch(node.second, targetNodeId, closed)
  return second.restored
    ? { root: { ...node, second: second.root }, restored: true }
    : { root: node, restored: false }
}

export function restoreWorkspacePane(
  layout: WorkspaceLayoutState,
  closed: ClosedWorkspacePane,
): WorkspaceLayoutState {
  const view = layout.views.find((candidate) => candidate.id === closed.viewId)
  if (!view || workspacePane(view.root, closed.pane.id)) return layout

  let restored = restoreWorkspacePaneBranch(view.root, closed.siblingNodeId, closed)
  if (!restored.restored) {
    restored = restoreWorkspacePaneBranch(view.root, view.focusedPaneId, closed)
  }
  if (!restored.restored) return layout

  const nextView: WorkspaceView = {
    ...view,
    root: restored.root,
    focusedPaneId: closed.pane.id,
  }
  if (closed.wasMaximized) nextView.maximizedPaneId = closed.pane.id
  else delete nextView.maximizedPaneId

  return {
    ...layout,
    activeViewId: view.id,
    views: layout.views.map((candidate) => candidate.id === view.id ? nextView : candidate),
  }
}

export { workspaceViewThreads, workspaceViewPaneKinds } from './workspace-tab-data.js'

export function workspaceViewThreadIds(view: WorkspaceView): readonly string[] {
  return [...new Set(workspacePaneIds(view.root).flatMap((paneId) => {
    const threadId = workspacePane(view.root, paneId)?.thread?.id
    return threadId ? [threadId] : []
  }))]
}

export interface WorkspaceThreadPane {
  workspaceId: string
  paneId: string
}

export function workspacePaneTargets(
  layout: WorkspaceLayoutState,
  sessions: ReadonlyMap<string, ClientSessionService>,
  direction?: WorkspaceMoveDirection,
): readonly WorkspacePaneTarget[] {
  return layout.views.flatMap((view) => {
    if (direction && view.id !== layout.activeViewId) return []
    const adjacent = direction ? adjacentWorkspacePane(view.root, view.focusedPaneId, direction) : undefined
    const paneIds = direction ? (adjacent ? [adjacent] : []) : workspacePaneIds(view.root)
    return paneIds.flatMap((paneId) => {
      const session = sessions.get(paneId)
      return session ? [{
        workspaceId: view.id,
        paneId,
        focused: view.id === layout.activeViewId && paneId === view.focusedPaneId,
        session,
      }] : []
    })
  })
}

export function workspaceThreadPane(
  views: readonly WorkspaceView[],
  sessions: ReadonlyMap<string, ClientSessionService>,
  threadId: string,
): WorkspaceThreadPane | undefined {
  for (const view of views) {
    for (const paneId of workspacePaneIds(view.root)) {
      if (sessions.get(paneId)?.snapshot().threadId === threadId) {
        return { workspaceId: view.id, paneId }
      }
    }
  }
  for (const view of views) {
    for (const paneId of workspacePaneIds(view.root)) {
      if (workspacePane(view.root, paneId)?.thread?.id === threadId) {
        return { workspaceId: view.id, paneId }
      }
    }
  }
  return undefined
}

export type WorkspaceTabDropEdge = 'left' | 'right' | 'top' | 'bottom'

interface WorkspaceTabDropTarget {
  paneId: string
  edge: WorkspaceTabDropEdge
}

export function workspaceTabDropEdge(
  bounds: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>,
  clientX: number,
  clientY: number,
): WorkspaceTabDropEdge {
  const horizontalDistance = Math.min(
    Math.abs(clientX - bounds.left),
    Math.abs(bounds.right - clientX),
  )
  const verticalDistance = Math.min(
    Math.abs(clientY - bounds.top),
    Math.abs(bounds.bottom - clientY),
  )
  if (horizontalDistance <= verticalDistance) {
    return clientX < bounds.left + bounds.width / 2 ? 'left' : 'right'
  }
  return clientY < bounds.top + bounds.height / 2 ? 'top' : 'bottom'
}

function splitWorkspaceTree(
  node: WorkspaceLayoutNode,
  paneId: string,
  direction: WorkspaceSplitDirection,
  sibling: WorkspaceLayoutNode,
  siblingFirst: boolean,
  splitId: string,
): WorkspaceLayoutNode {
  if (node.type === 'pane') {
    if (node.id !== paneId) return node
    return {
      type: 'split',
      id: splitId,
      direction,
      ratio: 0.5,
      first: siblingFirst ? sibling : node,
      second: siblingFirst ? node : sibling,
    }
  }
  const first = splitWorkspaceTree(
    node.first,
    paneId,
    direction,
    sibling,
    siblingFirst,
    splitId,
  )
  if (first !== node.first) return { ...node, first }
  const second = splitWorkspaceTree(
    node.second,
    paneId,
    direction,
    sibling,
    siblingFirst,
    splitId,
  )
  return second === node.second ? node : { ...node, second }
}

export function dockWorkspaceTab(
  layout: WorkspaceLayoutState,
  sourceViewId: string,
  targetViewId: string,
  targetPaneId: string,
  edge: WorkspaceTabDropEdge,
  splitId: string,
): WorkspaceLayoutState {
  if (sourceViewId === targetViewId) return layout
  const source = layout.views.find((view) => view.id === sourceViewId)
  const target = layout.views.find((view) => view.id === targetViewId)
  if (!source || !target || !workspacePane(target.root, targetPaneId)) return layout
  const focusedPane = workspacePane(source.root, source.focusedPaneId)
  if (!focusedPane) return layout
  const direction: WorkspaceSplitDirection = edge === 'left' || edge === 'right'
    ? 'horizontal'
    : 'vertical'
  const siblingFirst = edge === 'left' || edge === 'top'
  const docked: WorkspaceView = {
    ...target,
    workspace: focusedPane.workspace,
    focusedPaneId: source.focusedPaneId,
    root: splitWorkspaceTree(
      target.root,
      targetPaneId,
      direction,
      source.root,
      siblingFirst,
      splitId,
    ),
  }
  if (focusedPane.projectId) docked.projectId = focusedPane.projectId
  else delete docked.projectId
  if (focusedPane.unscoped) docked.unscoped = true
  else delete docked.unscoped
  delete docked.maximizedPaneId
  return normalizeTabGroups({
    ...layout,
    activeViewId: target.id,
    views: layout.views
      .filter((view) => view.id !== source.id)
      .map((view) => view.id === target.id ? docked : view),
  })
}

function DefaultWorkspaceTabStrip({ layout, change, renderTab, beginDrag, children, tabActions = [], overlays, rootRef }: WorkspaceTabStripProps): ReactNode {
  const [menu, setMenu] = useState<{ view: WorkspaceView; x: number; y: number; trigger: HTMLElement }>()
  return <div className="workspace-tabs" role="tablist" aria-label="Workspaces"
    onDragOver={(event) => {
      if (!event.dataTransfer.types.includes('application/x-alto-workspace-tab')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
    }}
    onDrop={(event) => {
      const sourceId = event.dataTransfer.getData('application/x-alto-workspace-tab')
      if (!sourceId) return
      event.preventDefault()
      const target = (event.target as Element).closest<HTMLElement>('[data-workspace-tab]')
      const bounds = target?.getBoundingClientRect()
      const after = bounds && event.clientX >= bounds.left + bounds.width / 2
      change((current) => {
        const source = current.views.find((view) => view.id === sourceId)
        if (!source || source.id === target?.dataset.workspaceTab) return current
        const views = current.views.filter((view) => view !== source)
        const targetIndex = views.findIndex((view) => view.id === target?.dataset.workspaceTab)
        views.splice(targetIndex < 0 ? views.length : targetIndex + (after ? 1 : 0), 0, source)
        return { ...current, views }
      })
      beginDrag(undefined)
    }}>
    {layout.views.map((view, index) => renderTab(view, index, {
      onContextMenu: (event) => {
        if (!tabActions.some((action) => action.available(view))) return
        event.preventDefault()
        setMenu({ view, x: event.clientX, y: event.clientY, trigger: event.currentTarget })
      },
      onKeyDown: (event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        if (!tabActions.some((action) => action.available(view))) return
        event.preventDefault()
        const bounds = event.currentTarget.getBoundingClientRect()
        setMenu({ view, x: bounds.left, y: bounds.bottom, trigger: event.currentTarget })
      },
    }))}
    {menu && <WorkspaceTabActionMenu {...menu} actions={tabActions} overlays={overlays} rootRef={rootRef} close={() => setMenu(undefined)} />}
    {children}
  </div>
}

function WorkspaceLayout({
  host,
  globalSession,
  sessionRouter,
  factory,
  renderers,
  settings,
  plugins,
  contributionRenderer,
  registry,
  ui,
}: {
  host: ClientHostService
  globalSession: ClientSessionService
  sessionRouter: ClientSessionRouterService
  factory: ClientSessionFactoryService
  renderers: ChatRenderers
  settings: ClientSurfaceRenderer | undefined
  plugins: ClientSurfaceRenderer | undefined
  contributionRenderer: ClientContributionRenderer | undefined
  registry: WorkspaceLayoutRegistry
  ui: ClientUiService
}): ReactNode {
  const globalState = useStoreSelector(
    globalSession,
    workspaceGlobalSnapshot,
    workspaceGlobalSnapshotEqual,
  )
  const addonRevision = useSyncExternalStore(registry.subscribe, registry.snapshot)
  const hostConnectionEpoch = useSyncExternalStore(
    host.subscribe,
    () => host.snapshot().connectionEpoch,
  )
  const [layout, setLayout] = useState(() => initialLayout(globalSession.snapshot()))
  const initialLayoutRef = useRef(layout)
  const layoutRef = useRef(layout)
  const layoutPersistenceReady = useRef(false)
  const layoutChangedBeforeRestore = useRef(false)
  layoutRef.current = layout
  const sessions = useRef(new Map<string, ClientSessionService>())
  const drafts = useRef(new Map<string, PaneDraft>())
  const draftStores = useRef(new Map<string, PaneDraftStore>())
  const recentlyClosed = useRef<Array<
    | {
        kind: 'tab'
        tab: ClosedWorkspaceTab
        drafts: ReadonlyArray<readonly [string, PaneDraft]>
      }
    | {
        kind: 'pane'
        pane: ClosedWorkspacePane
        draft?: PaneDraft
      }
  >>([])
  const draggingViewId = useRef<string | undefined>(undefined)
  const tabDropTargetRef = useRef<WorkspaceTabDropTarget | undefined>(undefined)
  const renameInput = useRef<HTMLInputElement>(null)
  const workspaceRootRef = useRef<HTMLDivElement>(null)
  const workspacePickerRef = useRef<HTMLDivElement>(null)
  const workspacePickerMenuRef = useRef<HTMLDivElement>(null)
  const [renamingViewId, setRenamingViewId] = useState<string>()
  const [renamingViewName, setRenamingViewName] = useState('')
  const [renameError, setRenameError] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const renameInFlight = useRef(false)
  const renameGeneration = useRef(0)
  useEffect(() => () => { renameGeneration.current += 1 }, [])
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [pendingSplit, setPendingSplit] = useState<PendingSplit>()
  const [tabDropTarget, setTabDropTarget] = useState<WorkspaceTabDropTarget>()
  const [layoutPersistenceRetry, setLayoutPersistenceRetry] = useState(0)
  const activeView = layout.views.find((view) => view.id === layout.activeViewId) ?? layout.views[0]
  const newTabOptions = useMemo(
    () => workspaceNewTabOptions(globalState.projects),
    [globalState.projects],
  )
  void addonRevision
  const paneAddons = (
    ['pane-title', 'after-header', 'conversation-overlay', 'before-composer'] as const
  ).flatMap((placement) => registry.addons(placement))
  const pages = registry.pages()
  const activePage = registry.activePage()
  const migratePages = (current: WorkspaceLayoutState): WorkspaceLayoutState => {
    for (const page of registry.pages()) {
      if (!page.replacesPaneKind) continue
      const active = current.views.find((view) => view.id === current.activeViewId)
      if (active && workspacePane(active.root, active.focusedPaneId)?.kind === page.replacesPaneKind) registry.showPage(page.id)
      current = removeWorkspacePaneKind(current, page.replacesPaneKind)
    }
    return registry.syncTabNames(current)
  }
  useLayoutEffect(() => {
    if (!layoutPersistenceReady.current) return
    const migrated = migratePages(layout)
    if (migrated !== layout) setLayout(migrated)
  }, [layout, addonRevision])
  const paneKinds = registry.paneKinds()
  const tabAddons = registry.tabAddons()
  const TabStrip = registry.tabStrip()?.renderer ?? DefaultWorkspaceTabStrip

  useLayoutEffect(() => {
    if (!renamingViewId) return
    renameInput.current?.focus()
    renameInput.current?.select()
  }, [renamingViewId])

  useLayoutEffect(() => {
    if (!workspacePickerOpen) return

    const positionPicker = (): void => {
      const root = workspaceRootRef.current
      const anchor = workspacePickerRef.current
      const menu = workspacePickerMenuRef.current
      if (!root || !anchor || !menu) return

      const placement = workspacePickerPlacement(
        anchor.getBoundingClientRect(),
        root.getBoundingClientRect(),
        menu.getBoundingClientRect().width,
      )
      menu.style.left = placement.left + 'px'
      menu.style.top = placement.top + 'px'
    }

    positionPicker()
    const tabScroller = workspacePickerRef.current?.parentElement
    window.addEventListener('resize', positionPicker)
    tabScroller?.addEventListener('scroll', positionPicker, { passive: true })
    const resizeObserver = new ResizeObserver(positionPicker)
    if (workspaceRootRef.current) resizeObserver.observe(workspaceRootRef.current)
    if (workspacePickerMenuRef.current) resizeObserver.observe(workspacePickerMenuRef.current)

    return () => {
      window.removeEventListener('resize', positionPicker)
      tabScroller?.removeEventListener('scroll', positionPicker)
      resizeObserver.disconnect()
    }
  }, [workspacePickerOpen])

  useEffect(() => {
    if (!workspacePickerOpen) return
    const dismiss = (event: globalThis.PointerEvent): void => {
      const target = event.target as Node
      if (
        !workspacePickerRef.current?.contains(target)
        && !workspacePickerMenuRef.current?.contains(target)
      ) setWorkspacePickerOpen(false)
    }
    window.addEventListener('pointerdown', dismiss)
    return () => window.removeEventListener('pointerdown', dismiss)
  }, [workspacePickerOpen])

  useEffect(() => {
    if (!pendingSplit) return
    ui.overlays.open('workspace-pane-kind')
    return () => ui.overlays.close('workspace-pane-kind')
  }, [pendingSplit, ui])

  useEffect(() => {
    if (layoutPersistenceReady.current) return
    let disposed = false
    let retry: number | undefined
    void host.call(WORKSPACE_LAYOUT_READ_METHOD).then((value) => {
      if (disposed) return
      const stored = parseWorkspaceLayout(value)
      const changed = layoutChangedBeforeRestore.current
      layoutPersistenceReady.current = true
      if (stored && !changed) {
        const migrated = migratePages(stored)
        layoutRef.current = migrated
        setLayout(migrated)
        return
      }
      const migrated = migratePages(layoutRef.current)
      layoutRef.current = migrated
      setLayout(migrated)
      void host.call(
        WORKSPACE_LAYOUT_WRITE_METHOD,
        migrated as unknown as JsonValue,
      ).catch(() => undefined)
    }).catch(() => {
      if (disposed) return
      // Plugin components can mount just before the host marks the matching
      // program revision active. Keep the origin-local copy and retry once
      // that revision gate has had time to advance.
      const delay = Math.min(2_000, 100 * (2 ** Math.min(layoutPersistenceRetry, 4)))
      retry = window.setTimeout(() => {
        setLayoutPersistenceRetry((current) => current + 1)
      }, delay)
    })
    return () => {
      disposed = true
      if (retry !== undefined) window.clearTimeout(retry)
    }
  }, [host, hostConnectionEpoch, layoutPersistenceRetry])

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
    } catch {
      // The live layout remains usable when persistence is unavailable.
    }
    if (!layoutPersistenceReady.current) {
      if (layout !== initialLayoutRef.current) layoutChangedBeforeRestore.current = true
      return
    }
    void host.call(
      WORKSPACE_LAYOUT_WRITE_METHOD,
      layout as unknown as JsonValue,
    ).catch(() => undefined)
  }, [host, layout])

  const updateView = (viewId: string, update: (view: WorkspaceView) => WorkspaceView): void => {
    setLayout((current) => {
      let changed = false
      const views = current.views.map((view) => {
        if (view.id !== viewId) return view
        const next = update(view)
        if (next !== view) changed = true
        return next
      })
      return changed ? { ...current, views } : current
    })
  }

  const draftStoreFor = (paneId: string): PaneDraftStore => {
    const existing = draftStores.current.get(paneId)
    if (existing) return existing
    const store: PaneDraftStore = {
      read: () => drafts.current.get(paneId),
      write: (draft) => {
        if (!draft.message && !draft.images.length && !draft.attachments.length) {
          drafts.current.delete(paneId)
        } else {
          drafts.current.set(paneId, {
            message: draft.message,
            images: [...draft.images],
            attachments: [...draft.attachments],
          })
        }
      },
    }
    draftStores.current.set(paneId, store)
    return store
  }

  useEffect(() => () => sessionRouter.clearActive(), [sessionRouter])

  useEffect(() => {
    if (!activeView) return
    const session = sessions.current.get(activeView.focusedPaneId)
    if (!session) return
    sessionRouter.setActive(`${activeView.id}:${activeView.focusedPaneId}`, session)
  }, [activeView?.focusedPaneId, activeView?.id, sessionRouter])

  if (!activeView) return null

  const splitPane = (
    view: WorkspaceView,
    paneId: string,
    direction: WorkspaceSplitDirection,
    state: ClientSessionSnapshot | undefined,
    kind?: string,
    initial?: Pick<WorkspaceOpenPaneRequest, 'thread' | 'workspace' | 'projectId' | 'resource'>,
    activateView = false,
  ): WorkspaceOpenPaneResult => {
    const source = workspacePane(view.root, paneId)
    const nextPane = paneFromSession({
      ...(state ?? globalSession.snapshot()),
      threadId: undefined,
      activities: [],
    }, nextId('pane'))
    nextPane.workspace = view.workspace || source?.workspace || nextPane.workspace
    if (view.projectId) nextPane.projectId = view.projectId
    else delete nextPane.projectId
    if (view.unscoped) nextPane.unscoped = true
    else delete nextPane.unscoped
    if (kind) nextPane.kind = kind
    if (initial?.workspace) nextPane.workspace = initial.workspace
    if (initial?.projectId) nextPane.projectId = initial.projectId
    if (initial?.thread) nextPane.thread = initial.thread
    else delete nextPane.thread
    if (initial?.resource) nextPane.resource = initial.resource
    else delete nextPane.resource
    const splitId = nextId('split')
    setLayout((current) => ({
      ...current,
      ...(activateView ? { activeViewId: view.id } : {}),
      views: current.views.map((candidate) => {
        if (candidate.id !== view.id) return candidate
        const next: WorkspaceView = {
          ...candidate,
          focusedPaneId: nextPane.id,
          root: splitWorkspacePane(candidate.root, paneId, direction, nextPane, splitId),
        }
        // A new split should be visible immediately instead of becoming a
        // hidden focused pane behind the current full-screen pane.
        delete next.maximizedPaneId
        return next
      }),
    }))
    return {
      workspaceId: view.id,
      paneId: nextPane.id,
      ...(nextPane.thread ? { threadId: nextPane.thread.id } : {}),
    }
  }

  const requestSplit = (
    view: WorkspaceView,
    paneId: string,
    direction: WorkspaceSplitDirection,
  ): void => {
    setPendingSplit({ viewId: view.id, paneId, direction })
  }

  const chooseSplitKind = (kind?: string): void => {
    if (!pendingSplit) return
    const view = layout.views.find((candidate) => candidate.id === pendingSplit.viewId)
    if (view && workspacePane(view.root, pendingSplit.paneId)) {
      const session = sessions.current.get(pendingSplit.paneId)
      splitPane(view, pendingSplit.paneId, pendingSplit.direction, session?.snapshot(), kind)
    }
    setPendingSplit(undefined)
  }

  const focusViewPane = (view: WorkspaceView, paneId: string): boolean => {
    if (!workspacePaneIds(view.root).includes(paneId)) return false
    registry.showPage()
    setLayout((current) => activateWorkspaceTab(current, view.id))
    const focusChanged = view.id !== layout.activeViewId || view.focusedPaneId !== paneId
    if (focusChanged) {
      setLayout((current) => ({
        ...current,
        activeViewId: view.id,
        views: current.views.map((candidate) => {
          if (candidate.id !== view.id) return candidate
          return {
            ...candidate,
            focusedPaneId: paneId,
            ...(candidate.maximizedPaneId ? { maximizedPaneId: paneId } : {}),
          }
        }),
      }))
    }
    const session = sessions.current.get(paneId)
    if (session) sessionRouter.setActive(`${view.id}:${paneId}`, session)
    return true
  }

  const closePane = (viewId: string, paneId: string): void => {
    const current = layoutRef.current
    const view = current.views.find((candidate) => candidate.id === viewId)
    if (!view) return
    const result = closeWorkspacePane(view, paneId)
    if (!result.closed) return

    const draft = drafts.current.get(paneId)
    recentlyClosed.current = [
      ...recentlyClosed.current,
      {
        kind: 'pane' as const,
        pane: result.closed,
        ...(draft
          ? {
              draft: {
                message: draft.message,
                images: [...draft.images],
                attachments: [...draft.attachments],
              },
            }
          : {}),
      },
    ].slice(-20)
    drafts.current.delete(paneId)
    draftStores.current.delete(paneId)

    const next = {
      ...current,
      views: current.views.map((candidate) => (
        candidate.id === viewId ? result.view : candidate
      )),
    }
    layoutRef.current = next
    setLayout(next)
  }

  const showTabDropTarget = (target: WorkspaceTabDropTarget | undefined): void => {
    const current = tabDropTargetRef.current
    if (current?.paneId === target?.paneId && current?.edge === target?.edge) return
    tabDropTargetRef.current = target
    setTabDropTarget(target)
  }

  const tabDropTargetAt = (
    clientX: number,
    clientY: number,
    owner: HTMLElement,
  ): WorkspaceTabDropTarget | undefined => {
    const element = document.elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('[data-workspace-pane-id]')
    const paneId = element?.dataset.workspacePaneId
    if (!element || !paneId || !owner.contains(element) || !workspacePane(activeView.root, paneId)) {
      return undefined
    }
    return {
      paneId,
      edge: workspaceTabDropEdge(element.getBoundingClientRect(), clientX, clientY),
    }
  }

  const actionsFor = (view: WorkspaceView): TreeActions => ({
    factory,
    renderers,
    focusedPaneId: view.focusedPaneId,
    ...(view.maximizedPaneId ? { maximizedPaneId: view.maximizedPaneId } : {}),
    visible: !activePage && view.id === layout.activeViewId,
    paneCount: workspacePaneIds(view.root).length,
    split: (paneId, direction) => requestSplit(view, paneId, direction),
    close: (paneId) => closePane(view.id, paneId),
    focus: (paneId) => { focusViewPane(view, paneId) },
    toggleFullscreen: (paneId) => updateView(view.id, (current) => {
      const next: WorkspaceView = { ...current, focusedPaneId: paneId }
      if (current.maximizedPaneId === paneId) delete next.maximizedPaneId
      else next.maximizedPaneId = paneId
      return next
    }),
    resize: (splitId, ratio) => updateView(view.id, (current) => ({
      ...current,
      root: resizeWorkspaceSplit(current.root, splitId, ratio),
    })),
    changed: (paneId, state) => updateView(view.id, (current) => {
      const existing = workspacePane(current.root, paneId)
      if (!existing) return current
      const thread = paneThreadSummary(state, existing)
      const workspace = thread?.cwd || state.session.workspace
      const projectId = state.activeProjectId
      const unscoped = state.projectScope === 'unscoped'
      const nextPane = recordWorkspacePaneLocation(existing, {
        workspace,
        ...(projectId ? { projectId } : {}),
        ...(unscoped ? { unscoped: true } : {}),
        ...(thread ? { thread } : {}),
      })
      if (nextPane === existing) return current
      const nextView: WorkspaceView = {
        ...current,
        root: mapWorkspacePane(current.root, paneId, () => nextPane),
      }
      if (current.focusedPaneId === paneId) {
        nextView.workspace = workspace
        if (projectId) nextView.projectId = projectId
        else delete nextView.projectId
        if (unscoped) nextView.unscoped = true
        else delete nextView.unscoped
      }
      return nextView
    }),
    selected: () => undefined,
    ready: (paneId, session) => {
      const key = `${view.id}:${paneId}`
      if (session) {
        sessions.current.set(paneId, session)
        if (view.id === layout.activeViewId && paneId === view.focusedPaneId) {
          sessionRouter.setActive(key, session)
        }
      } else {
        sessions.current.delete(paneId)
        sessionRouter.clearActive(key)
      }
    },
    addons: paneAddons,
    paneKinds,
    draftStore: draftStoreFor,
    ...(view.id === layout.activeViewId && tabDropTarget ? { tabDropTarget } : {}),
  })

  const beginRename = (view: WorkspaceView): void => {
    registry.showPage()
    if (renamingViewId === view.id || renameInFlight.current) return
    setRenameError('')
    setLayout((current) => activateWorkspaceTab(current, view.id))
    setRenamingViewId(view.id)
    setRenamingViewName(view.name)
  }

  const finishRename = async (save: boolean): Promise<void> => {
    if (renameInFlight.current) return
    const viewId = renamingViewId
    const requestedName = renamingViewName.trim()
    const view = registry.syncTabNames(layoutRef.current).views.find((candidate) => candidate.id === viewId)
    if (!save || !view || !requestedName || requestedName === view.name) {
      setRenamingViewId(undefined); setRenamingViewName(''); setRenameError('')
      return
    }
    const generation = renameGeneration.current
    renameInFlight.current = true
    setRenameSaving(true)
    setRenameError('')
    try {
      if (view.nameBinding) {
        const source = registry.tabNameSource(view.nameBinding.source)
        if (!source) throw new Error('The linked name is currently unavailable')
        await source.rename(view.nameBinding.id, requestedName)
      }
      if (generation !== renameGeneration.current) return
      setLayout((current) => {
        const synced = registry.syncTabNames(current)
        if (view.nameBinding) return synced
        const otherViews = synced.views.filter((candidate) => candidate.id !== viewId)
        const name = uniqueViewName({ ...synced, views: otherViews }, requestedName)
        return { ...synced, views: synced.views.map((candidate) => candidate.id === viewId ? { ...candidate, name } : candidate) }
      })
      setRenamingViewId(undefined)
      setRenamingViewName('')
    } catch (error) {
      if (generation === renameGeneration.current) setRenameError(error instanceof Error ? error.message : String(error))
    } finally {
      renameInFlight.current = false
      if (generation === renameGeneration.current) setRenameSaving(false)
    }
  }

  const addView = (requestedProject?: LocalProject | null, requestedKind?: string, thread?: ThreadSummary): void => {
    registry.showPage()
    const kind = requestedKind ? paneKinds.find((candidate) => candidate.id === requestedKind) : undefined
    if (requestedKind && !kind) throw new Error('Workspace pane kind is not installed: ' + requestedKind)
    const focusedSession = sessions.current.get(activeView.focusedPaneId)
    const state = focusedSession?.snapshot() ?? globalSession.snapshot()
    const project = requestedProject ?? undefined
    const workspace = project?.primaryRoot ?? defaultWorkspace(state.harness)
    const pane = paneFromSession({
      ...state,
      threadId: undefined,
      activities: [],
      session: { ...state.session, workspace },
      activeProjectId: project?.id,
      projectScope: project ? 'workspace' : 'unscoped',
    })
    delete pane.thread
    if (project) {
      delete pane.unscoped
      const landingKind = paneKinds.find((candidate) => candidate.newTab)
      if (landingKind) pane.kind = landingKind.id
    } else {
      pane.unscoped = true
    }
    if (kind) pane.kind = kind.id
    if (thread) {
      delete pane.kind
      delete pane.unscoped
      pane.workspace = thread.cwd
      pane.thread = thread
      if (thread.projectId) pane.projectId = thread.projectId
      delete pane.navigation
    }
    const base = thread?.title || kind?.label || project?.name || 'New chat'
    const view: WorkspaceView = {
      id: nextId('workspace'),
      name: uniqueViewName(layout, base),
      workspace: thread?.cwd ?? workspace,
      ...(project ? { projectId: project.id } : {}),
      ...(!project ? { unscoped: true } : {}),
      focusedPaneId: pane.id,
      root: pane,
    }
    setLayout((current) => ({
      ...current,
      activeViewId: view.id,
      views: [...current.views, view],
    }))
  }

  useEffect(() => {
    const newChat = (event: Event): void => {
      const request = event as CustomEvent<{ projectId?: string }>
      const projectId = request.detail?.projectId
      const project = projectId
        ? globalSession.snapshot().projects.find((candidate) => candidate.id === projectId)
        : undefined
      if (projectId && !project) return
      addView(project)
      request.preventDefault()
    }
    window.addEventListener(WORKSPACE_NEW_CHAT_EVENT, newChat)
    return () => window.removeEventListener(WORKSPACE_NEW_CHAT_EVENT, newChat)
  }, [addView, globalSession])

  const splitFocused = (direction: WorkspaceSplitDirection, kind?: string): void => {
    registry.showPage()
    const paneId = activeView.focusedPaneId
    if (!kind) {
      requestSplit(activeView, paneId, direction)
      return
    }
    const session = sessions.current.get(paneId)
    splitPane(activeView, paneId, direction, session?.snapshot(), kind)
  }

  const openPane = (
    request: Omit<WorkspaceOpenPaneRequest, 'id' | 'action'>,
  ): WorkspaceOpenPaneResult => {
    registry.showPage()
    let view = activeView
    let paneId = activeView.focusedPaneId
    if (request.anchor) {
      const candidate = layout.views.find((view) => view.id === request.anchor!.workspaceId)
      if (!candidate || !workspacePane(candidate.root, request.anchor.paneId)) {
        throw new Error('The pane which requested this split is no longer open.')
      }
      view = candidate
      paneId = request.anchor.paneId
    } else if (request.anchorThreadId) {
      for (const candidate of layout.views) {
        const anchor = workspacePaneIds(candidate.root).find((candidatePaneId) => (
          sessions.current.get(candidatePaneId)?.snapshot().threadId === request.anchorThreadId
          || workspacePane(candidate.root, candidatePaneId)?.thread?.id === request.anchorThreadId
        ))
        if (!anchor) continue
        view = candidate
        paneId = anchor
        break
      }
    }
    if (request.kind !== 'chat' && !paneKinds.some((kind) => kind.id === request.kind)) {
      throw new Error(`workspace pane kind ${JSON.stringify(request.kind)} is not installed`)
    }
    const session = sessions.current.get(paneId)
    return splitPane(
      view,
      paneId,
      request.direction,
      session?.snapshot(),
      request.kind === 'chat' ? undefined : request.kind,
      request,
      true,
    )
  }

  const showThreadInPane = (
    workspaceId: string,
    paneId: string,
    thread: ThreadSummary,
  ): void => {
    registry.showPage()
    updateView(workspaceId, (current) => {
      const existing = workspacePane(current.root, paneId)
      if (!existing) return current
      const workspace = thread.cwd || existing.workspace
      const location = {
        workspace,
        ...(thread.projectId ? { projectId: thread.projectId } : {}),
        ...(!thread.projectId ? { unscoped: true } : {}),
        thread,
      }
      const nextPane = { ...recordWorkspacePaneLocation(existing, location) }
      delete nextPane.kind
      delete nextPane.resource
      const next: WorkspaceView = {
        ...current,
        workspace,
        focusedPaneId: paneId,
        root: mapWorkspacePane(current.root, paneId, () => nextPane),
      }
      if (thread.projectId) {
        next.projectId = thread.projectId
        delete next.unscoped
      } else {
        delete next.projectId
        next.unscoped = true
      }
      return next
    })
  }

  const togglePaneKind = (kind: string): void => {
    registry.showPage()
    const existing = workspacePaneOfKind(activeView.root, kind)
    if (!existing) {
      splitFocused('horizontal', kind)
      return
    }
    if (existing.id !== activeView.focusedPaneId) {
      focusViewPane(activeView, existing.id)
      return
    }
    if (workspacePaneIds(activeView.root).length <= 1) return
    closePane(activeView.id, existing.id)
  }

  const closeView = (viewId: string): void => {
    const result = closeWorkspaceTab(layoutRef.current, viewId)
    if (!result.closed) return
    const paneIds = workspacePaneIds(result.closed.view.root)
    const closedDrafts = paneIds.flatMap((paneId) => {
      const draft = drafts.current.get(paneId)
      return draft ? [[paneId, {
        message: draft.message,
        images: [...draft.images],
        attachments: [...draft.attachments],
      }] as const] : []
    })
    recentlyClosed.current = [
      ...recentlyClosed.current,
      { kind: 'tab' as const, tab: result.closed, drafts: closedDrafts },
    ].slice(-20)
    for (const paneId of paneIds) {
      drafts.current.delete(paneId)
      draftStores.current.delete(paneId)
    }
    layoutRef.current = result.layout
    setLayout(result.layout)
  }

  const canRestoreClosedTab = (): boolean => recentlyClosed.current.length > 0

  const restoreClosedTab = (): void => {
    registry.showPage()
    const closed = recentlyClosed.current.pop()
    if (!closed) return

    const restored = closed.kind === 'tab'
      ? restoreWorkspaceTab(layoutRef.current, closed.tab)
      : restoreWorkspacePane(layoutRef.current, closed.pane)
    if (restored === layoutRef.current) return

    if (closed.kind === 'tab') {
      for (const [paneId, draft] of closed.drafts) drafts.current.set(paneId, draft)
    } else if (closed.draft) {
      drafts.current.set(closed.pane.pane.id, closed.draft)
    }
    layoutRef.current = restored
    setLayout(restored)
  }

  const cycleTabs = (direction: 1 | -1): void => {
    registry.showPage()
    const currentIndex = layout.views.findIndex((view) => view.id === activeView.id)
    if (currentIndex < 0 || layout.views.length < 2) return
    const nextView = layout.views[
      (currentIndex + direction + layout.views.length) % layout.views.length
    ]
    if (!nextView) return
    setLayout((current) => activateWorkspaceTab(current, nextView.id))
  }

  const selectTab = (index: number): void => {
    registry.showPage()
    const view = layout.views[index]
    if (view) setLayout((current) => activateWorkspaceTab(current, view.id))
  }

  const moveActiveTab = (direction: 1 | -1): void => {
    setLayout((current) => {
      const source = current.views.findIndex((view) => view.id === current.activeViewId)
      const target = source + direction
      if (source < 0 || target < 0 || target >= current.views.length) return current
      return moveWorkspaceTab(current, current.activeViewId, current.views[target]!.id)
    })
  }

  const focusAdjacentPane = (
    direction: WorkspaceMoveDirection,
    cycleTabAtEdge = false,
  ): void => {
    const paneId = adjacentWorkspacePane(activeView.root, activeView.focusedPaneId, direction)
    if (paneId) {
      focusViewPane(activeView, paneId)
      return
    }
    if (!cycleTabAtEdge) return
    if (direction === 'left') cycleTabs(-1)
    else if (direction === 'right') cycleTabs(1)
  }

  const resizeFocusedPane = (direction: 1 | -1): void => {
    updateView(activeView.id, (current) => ({
      ...current,
      root: resizeWorkspacePane(current.root, current.focusedPaneId, direction * 0.04),
    }))
  }

  const toggleFocusedPaneFullscreen = (): void => {
    updateView(activeView.id, (current) => {
      const next: WorkspaceView = { ...current }
      if (current.maximizedPaneId === current.focusedPaneId) delete next.maximizedPaneId
      else next.maximizedPaneId = current.focusedPaneId
      return next
    })
  }

  const canNavigateHistory = (direction: WorkspaceHistoryDirection): boolean => (
    canNavigateWorkspacePane(
      workspacePane(activeView.root, activeView.focusedPaneId),
      direction,
    )
  )

  const navigateHistory = (direction: WorkspaceHistoryDirection): void => {
    registry.showPage()
    const paneId = activeView.focusedPaneId
    const pane = workspacePane(activeView.root, paneId)
    const session = sessions.current.get(paneId)
    if (!pane || !session) return
    const target = navigateWorkspacePane(pane, direction)
    if (!target) return

    updateView(activeView.id, (current) => ({
      ...current,
      root: mapWorkspacePane(current.root, paneId, () => target.pane),
    }))

    if (target.location.thread) {
      void session.openThread(target.location.thread)
      return
    }
    const state = session.snapshot()
    const project = state.projects.find((candidate) => candidate.id === target.location.projectId)
      ?? state.projects.find((candidate) => candidate.primaryRoot === target.location.workspace)
    session.newThread(target.location.unscoped ? null : project)
  }

  const canCloseActiveTab = (): boolean => layout.views.length > 1

  const closeActiveTab = (): void => {
    if (canCloseActiveTab()) closeView(activeView.id)
  }

  const canCloseFocusedPane = (): boolean => workspacePaneIds(activeView.root).length > 1

  const closeFocusedPane = (): void => {
    if (canCloseFocusedPane()) closePane(activeView.id, activeView.focusedPaneId)
  }

  const dragWorkspaceTabOverPane = (event: ReactDragEvent<HTMLDivElement>): void => {
    const sourceId = draggingViewId.current
    if (!sourceId || sourceId === activeView.id) {
      showTabDropTarget(undefined)
      return
    }
    const target = tabDropTargetAt(
      event.clientX,
      event.clientY,
      event.currentTarget,
    )
    if (!target) {
      showTabDropTarget(undefined)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    showTabDropTarget(target)
  }

  const dropWorkspaceTabIntoPane = (event: ReactDragEvent<HTMLDivElement>): void => {
    const sourceId = draggingViewId.current
    const target = sourceId && sourceId !== activeView.id
      ? tabDropTargetAt(event.clientX, event.clientY, event.currentTarget)
      : undefined
    showTabDropTarget(undefined)
    if (!sourceId || !target) return
    event.preventDefault()
    const splitId = nextId('split')
    setLayout((current) => {
      const next = dockWorkspaceTab(
        current,
        sourceId,
        activeView.id,
        target.paneId,
        target.edge,
        splitId,
      )
      layoutRef.current = next
      return next
    })
    draggingViewId.current = undefined
  }

  const Settings = settings
  const Plugins = plugins
  const ContributionRenderer = contributionRenderer
  const contributions = globalState.ui?.contributions ?? []
  const renderContributions = (slot: string): ReactNode => ContributionRenderer
    ? contributions
        .filter((contribution) => (contribution.slot ?? 'main') === slot)
        .map((contribution) => (
          <div className="workspace-shell-contribution" key={contribution.id}>
            <ContributionRenderer contribution={contribution} />
          </div>
        ))
    : null
  const historyMouseButton = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const direction = event.button === 3 ? -1 : event.button === 4 ? 1 : undefined
    if (!direction) return
    event.preventDefault()
    event.stopPropagation()
    navigateHistory(direction)
  }
  return (
    <div
      ref={workspaceRootRef}
      className="workspace-layout-root"
      onMouseDownCapture={historyMouseButton}
    >
      <WorkspaceLayoutControllerBridge
        registry={registry}
        canCloseActiveTab={canCloseActiveTab}
        closeActiveTab={closeActiveTab}
        closeTab={closeView}
        renameActiveTab={() => beginRename(activeView)}
        linkTabName={(workspaceId, nameBinding) => updateView(workspaceId, (view) => ({ ...view, nameBinding }))}
        canRestoreClosedTab={canRestoreClosedTab}
        restoreClosedTab={restoreClosedTab}
        canCloseFocusedPane={canCloseFocusedPane}
        closeFocusedPane={closeFocusedPane}
        cycleTabs={cycleTabs}
        selectTab={selectTab}
        tabs={() => layout.views.map((view) => ({
          id: view.id,
          title: view.name,
          ...(view.nameBinding ? { nameBinding: view.nameBinding } : {}),
          active: !activePage && view.id === layout.activeViewId,
          threadIds: workspaceViewThreadIds(view),
          threads: workspaceViewThreads(view),
          paneKinds: workspaceViewPaneKinds(view),
        }))}
        moveActiveTab={moveActiveTab}
        newTab={(kind, thread, project) => addView(project, kind, thread)}
        showThreadInPane={showThreadInPane}
        openPane={openPane}
        splitFocused={splitFocused}
        togglePaneKind={togglePaneKind}
        focusAdjacentPane={focusAdjacentPane}
        resizeFocusedPane={resizeFocusedPane}
        toggleFocusedPaneFullscreen={toggleFocusedPaneFullscreen}
        canNavigateHistory={canNavigateHistory}
        navigateHistory={navigateHistory}
        paneTargets={(direction) => workspacePaneTargets(layout, sessions.current, direction)}
        hasThread={(threadId) => (
          workspaceThreadPane(layout.views, sessions.current, threadId) !== undefined
        )}
        focusThread={(threadId) => {
          const target = workspaceThreadPane(layout.views, sessions.current, threadId)
          if (!target) return false
          const view = layout.views.find((candidate) => candidate.id === target.workspaceId)
          return view ? focusViewPane(view, target.paneId) : false
        }}
        focusPane={(workspaceId, paneId) => {
          const view = layout.views.find((candidate) => candidate.id === workspaceId)
          return view ? focusViewPane(view, paneId) : false
        }}
      />
      <header className="workspace-tabbar">
        <div className="workspace-tabbar-leading">
          <nav className="workspace-history-controls" aria-label="Chat navigation">
            <button
              type="button"
              title="Back"
              aria-label="Go back to the previous chat"
              disabled={!canNavigateHistory(-1)}
              onClick={() => navigateHistory(-1)}
            >
              <ArrowLeft size={14} strokeWidth={1.7} />
            </button>
            <button
              type="button"
              title="Forward"
              aria-label="Go forward to the next chat"
              disabled={!canNavigateHistory(1)}
              onClick={() => navigateHistory(1)}
            >
              <ArrowRight size={14} strokeWidth={1.7} />
            </button>
          </nav>
          {renderContributions('header-left')}
          <TabStrip layout={layout} change={setLayout} rootRef={workspaceRootRef} tabActions={registry.tabActions()} overlays={ui.overlays}
            beginDrag={(id) => { draggingViewId.current = id; showTabDropTarget(undefined) }}
            renderTab={(view, index, presentation = {}) => {
            const renaming = renamingViewId === view.id
            const active = !activePage && view.id === layout.activeViewId
            const threadIds = workspaceViewThreadIds(view)
            return (
              <div
                className={`workspace-tab${active ? ' is-active' : ''}${renaming ? ' is-renaming' : ''}${presentation.className ? ' ' + presentation.className : ''}`}
                role="tab"
                data-workspace-tab={view.id}
                inert={presentation.inert}
                data-group-color={presentation.color}
                data-tab-drop={presentation.dropIndicator}
                onContextMenu={presentation.onContextMenu}
                data-hotkey-action={index < 9 ? `workspace.tab.select.${index + 1}` : undefined}
                tabIndex={view.id === layout.activeViewId ? 0 : -1}
                aria-label={view.name}
                aria-selected={active}
                draggable={!renaming}
                key={view.id}
                onAuxClick={(event) => {
                  if (event.button === 1) closeView(view.id)
                }}
                onClick={() => {
                  if (renaming) return
                  registry.showPage()
                  setLayout((current) => activateWorkspaceTab(current, view.id))
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  beginRename(view)
                }}
                onKeyDown={(event) => {
                  presentation.onKeyDown?.(event)
                  if (event.defaultPrevented) return
                  if (event.key === 'F2') {
                    event.preventDefault()
                    beginRename(view)
                    return
                  }
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  registry.showPage()
                  setLayout((current) => activateWorkspaceTab(current, view.id))
                }}
                onDragStart={(event) => {
                  draggingViewId.current = view.id
                  showTabDropTarget(undefined)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('application/x-alto-workspace-tab', view.id)
                  event.dataTransfer.setData('text/plain', view.id)
                }}
                onDragEnd={() => {
                  draggingViewId.current = undefined
                  showTabDropTarget(undefined)
                }}
              >
                {renaming ? (
                  <>
                  <input
                    ref={renameInput}
                    className="workspace-tab-name-input"
                    value={renamingViewName}
                    readOnly={renameSaving}
                    aria-busy={renameSaving}
                    aria-invalid={Boolean(renameError)}
                    title={renameError || undefined}
                    aria-label={`Rename ${view.name}`}
                    onChange={(event) => setRenamingViewName(event.target.value)}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onBlur={() => void finishRename(true)}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void finishRename(true)
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        void finishRename(false)
                      }
                    }}
                  />
                  {renameError && <span className="workspace-tab-rename-error" role="alert" aria-label={renameError} title={renameError}>!</span>}
                  </>
                ) : (
                  <span title="Double-click to rename">{view.name}</span>
                )}
                {!renaming && tabAddons.map((addon) => {
                  const Addon = addon.renderer
                  return (
                    <Addon
                      workspaceId={view.id}
                      active={active}
                      threadIds={threadIds}
                      key={addon.id}
                    />
                  )
                })}
                {layout.views.length > 1 && (
                  <button
                    className="workspace-tab-close"
                    type="button"
                    data-hotkey-action="workspace.tab.close"
                    aria-label={`Close ${view.name}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeView(view.id)
                    }}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            )
          }}>
            <div className="workspace-tab-add-control" ref={workspacePickerRef}>
              <button
                className="workspace-tab-add"
                type="button"
                data-hotkey-action="workspace.tab.new"
                title="New chat"
                aria-label="New chat with no workspace"
                aria-haspopup="menu"
                aria-expanded={workspacePickerOpen}
                onClick={() => addView()}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setWorkspacePickerOpen(true)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowDown') return
                  event.preventDefault()
                  setWorkspacePickerOpen(true)
                }}
              >
                <Plus size={14} />
              </button>
            </div>
          </TabStrip>
        </div>
        <div className="workspace-tabbar-tools">
          {renderContributions('header-right')}
          {Plugins && <Plugins surface={pluginsSurface} />}
          {Settings && <Settings surface={settingsSurface} />}
          <div className="workspace-tabbar-tools" data-ui-slot="header-end">
            {(globalState.ui?.surfaces ?? [])
              .filter((surface) => surface.data?.slot === 'header-end')
              .sort((a, b) => Number(a.data?.order ?? 0) - Number(b.data?.order ?? 0))
              .map((surface) => {
                const Renderer = ui.renderer(surface)
                return Renderer ? <Renderer key={surface.id} surface={surface} /> : null
              })}
          </div>
        </div>
      </header>
      {workspacePickerOpen && (
        <div ref={workspacePickerMenuRef} className="workspace-project-picker" role="menu" aria-label="Choose tab workspace">
          {newTabOptions.map((option) => (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                addView(option.project ?? null)
                setWorkspacePickerOpen(false)
              }}
              key={option.id}
            >
              <strong>{option.label}</strong>
              <span>{option.detail}</span>
            </button>
          ))}
        </div>
      )}
      {pendingSplit && (
        <PaneKindPicker
          kinds={paneKinds}
          choose={chooseSplitKind}
          close={() => setPendingSplit(undefined)}
        />
      )}
      {renderContributions('main')}
      <div
        className="workspace-views"
        onDragOver={dragWorkspaceTabOverPane}
        onDragLeave={(event) => {
          const next = event.relatedTarget
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
            showTabDropTarget(undefined)
          }
        }}
        onDrop={dropWorkspaceTabIntoPane}
      >
        {pages.map((page) => {
          const Page = page.renderer
          const visible = page.id === activePage?.id
          return <div className="workspace-view" role="region" aria-label={page.label} hidden={!visible} key={'page:' + page.id}><Page visible={visible} /></div>
        })}
        {/* Hidden workspaces stay mounted: their chat sessions and native panes own live state. */}
        {layout.views.map((view) => {
          const visible = !activePage && view.id === layout.activeViewId
          return (
            <div
              className="workspace-view"
              role="tabpanel"
              aria-hidden={!visible}
              hidden={!visible}
              key={view.id}
            >
              <LayoutTree workspaceId={view.id} node={view.root} actions={actionsFor(view)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WorkspaceLayoutSurface({
  host,
  globalSession,
  sessionRouter,
  factory,
  ui,
  registry,
}: {
  host: ClientHostService
  globalSession: ClientSessionService
  sessionRouter: ClientSessionRouterService
  factory: ClientSessionFactoryService
  ui: ClientUiService
  registry: WorkspaceLayoutRegistry
}): ReactNode {
  const uiRevision = useSyncExternalStore(ui.subscribe, ui.snapshot)
  void uiRevision

  const Composer = ui.component<ComposerComponentProps>(COMPOSER_COMPONENT)
  const Conversation = ui.component<ConversationComponentProps>(CONVERSATION_COMPONENT)
  if (!Composer || !Conversation) {
    return (
      <div className="workspace-layout-missing" role="alert">
        Workspace Layout needs the active conversation and composer components.
      </div>
    )
  }

  return (
    <WorkspaceLayout
      host={host}
      globalSession={globalSession}
      sessionRouter={sessionRouter}
      factory={factory}
      renderers={{ Composer, Conversation }}
      settings={ui.renderer(settingsSurface)}
      plugins={ui.renderer(pluginsSurface)}
      contributionRenderer={ui.contributionRenderer()}
      registry={registry}
      ui={ui}
    />
  )
}

const workspaceLayout: BrowserPlugin = (ctx) => {
  const registry = new WorkspaceLayoutRegistry()
  ctx.provide('clientWorkspaceLayout', registry)
  const Surface: ClientSurfaceRenderer = () => (
    <WorkspaceLayoutSurface
      host={ctx.clientHost}
      globalSession={ctx.clientSession}
      sessionRouter={ctx.clientSessionRouter}
      factory={ctx.clientSessionFactory}
      ui={ctx.clientUi}
      registry={registry}
    />
  )
  ctx.clientUi.registerStyle(ctx, 'workspace-layout', `${String(paneToolbarCss)}\n${String(styles)}`)
  ctx.clientUi.registerSurface(ctx, 'workspace-layout', Surface)
  return () => registry.dispose()
}

workspaceLayout.inject = [
  'clientHost',
  'clientUi',
  'clientSession',
  'clientSessionRouter',
  'clientSessionFactory',
]
workspaceLayout.provide = 'clientWorkspaceLayout'
workspaceLayout.resources = {
  provides: { surfaces: ['workspace-layout'] },
  requires: {
    components: [COMPOSER_COMPONENT, CONVERSATION_COMPONENT],
    extensions: [WORKSPACE_LAYOUT_READ_METHOD, WORKSPACE_LAYOUT_WRITE_METHOD],
  },
}

export default workspaceLayout
