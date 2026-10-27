import {
  FolderPlus,
  PanelLeft,
  SquarePen,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  clientStyles,
  type BrowserPlugin,
  type ClientSurfaceProps,
} from '../../src/client/plugin-api.js'
import type { ClientSessionService, ClientSessionSnapshot } from './session-api.js'
import {
  HISTORY_ENTRY_DECORATION_COMPONENT,
  type HistoryEntryDecorationProps,
} from './sidebar-decorations-api.js'
import type {
  ClientSidebarAction,
  ClientSidebarMode,
  ClientSidebarService,
  ClientSidebarSnapshot,
} from './sidebar-api.js'
import {
  OptionalThreadStatusService,
  threadWorkStatus,
} from './thread-status-api.js'
import { HistoryPanel } from './ui/history.js'
import type { HistoryState } from './ui/history-model.js'
import { requestWorkspaceNewChat, type WorkspaceTabTarget } from './workspace-layout-api.js'
import { NewWorkspaceDialog } from './ui/project-settings.js'
import { useStoreSelector } from './ui/store-selector.js'
import styles from './sidebar.css'

const SIDEBAR_WIDTH_STORAGE_KEY = 'codex-cordis.sidebar-width'
const SIDEBAR_PIN_STORAGE_KEY = 'codex-cordis.sidebar-pinned'
const LEGACY_SIDEBAR_PIN_STORAGE_KEY = 'codex-cordis.sidebar-pins'
const DEFAULT_SIDEBAR_CLOSE_DELAY = 260
export const DEFAULT_SIDEBAR_WIDTH = 246
export const DEFAULT_SIDEBAR_MIN_WIDTH = 196
export const DEFAULT_SIDEBAR_MAX_WIDTH = 420
export const DEFAULT_CONVERSATION_MIN_WIDTH = 360

export interface SidebarResizeConfig {
  collapsedByDefault?: boolean
  pinnedByDefault?: boolean
  closeDelayMs?: number
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  minConversationWidth?: number
}

export interface SidebarLayoutMeasurement {
  currentWidth: number
  conversationWidth: number
}

export interface SidebarWidthBounds {
  min: number
  max: number
}

export class SidebarController implements ClientSidebarService {
  private readonly listeners = new Set<() => void>()
  private readonly registeredActions = new Map<string, ClientSidebarAction>()
  private state: ClientSidebarSnapshot

  constructor(initial: boolean | {
    collapsed?: boolean
    pinned?: boolean
    workspaceKey?: string
  } = true) {
    const collapsed = typeof initial === 'boolean' ? initial : (initial.collapsed ?? true)
    const pinned = typeof initial === 'boolean' ? false : (initial.pinned ?? false)
    this.state = {
      revision: 0,
      mode: pinned ? 'pinned' : (collapsed ? 'hidden' : 'floating'),
      collapsed: !pinned && collapsed,
      pinned,
      workspaceKey: typeof initial === 'boolean' ? 'default' : (initial.workspaceKey ?? 'default'),
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientSidebarSnapshot => this.state

  toggle(): void {
    if (this.state.pinned) this.setCollapsed(true)
    else this.setPinned(true)
  }

  setCollapsed(collapsed: boolean): void {
    this.transition(collapsed ? 'hidden' : 'floating')
  }

  setPinned(pinned: boolean): void {
    this.transition(pinned ? 'pinned' : 'floating')
  }

  activateWorkspace(workspaceKey: string): void {
    if (workspaceKey === this.state.workspaceKey) return
    this.transition(this.state.pinned ? 'pinned' : 'hidden', workspaceKey)
  }

  actions(): readonly ClientSidebarAction[] {
    return [...this.registeredActions.values()].toSorted((left, right) => (
      (left.order ?? 0) - (right.order ?? 0)
      || left.id.localeCompare(right.id)
    ))
  }

  registerAction(
    owner: import('cordis').Context,
    action: ClientSidebarAction,
  ): { dispose(): Promise<void> } {
    const id = action.id.trim()
    if (!/^[a-z][a-z0-9._-]*$/iu.test(id)) {
      throw new Error(`invalid sidebar action id: ${action.id}`)
    }
    const registered = { ...action, id }
    const dispose = owner.effect(() => {
      if (this.registeredActions.has(id)) {
        throw new Error(`sidebar action "${id}" is already registered`)
      }
      this.registeredActions.set(id, registered)
      this.bump()
      return () => {
        if (this.registeredActions.get(id) === registered) {
          this.registeredActions.delete(id)
          this.bump()
        }
      }
    }, `clientSidebar.registerAction(${JSON.stringify(id)})`)
    return { dispose: async () => dispose() }
  }

  dispose(): void {
    this.registeredActions.clear()
    this.listeners.clear()
  }

  private transition(mode: ClientSidebarMode, workspaceKey = this.state.workspaceKey): void {
    const collapsed = mode === 'hidden'
    const pinned = mode === 'pinned'
    if (mode === this.state.mode && workspaceKey === this.state.workspaceKey) return
    this.state = {
      revision: this.state.revision + 1,
      mode,
      collapsed,
      pinned,
      workspaceKey,
    }
    this.emit()
  }

  private bump(): void {
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function SidebarActions({ service }: { service: ClientSidebarService }): ReactNode {
  useSyncExternalStore(service.subscribe, service.snapshot)
  return service.actions().map(({ id, renderer: Action }) => <Action key={id} />)
}

function finite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

export function sidebarWidthBounds(
  config: SidebarResizeConfig = {},
  layout?: SidebarLayoutMeasurement,
): SidebarWidthBounds {
  const min = Math.max(160, finite(config.minWidth, DEFAULT_SIDEBAR_MIN_WIDTH))
  const configuredMax = Math.max(min, finite(config.maxWidth, DEFAULT_SIDEBAR_MAX_WIDTH))
  if (!layout) return { min, max: configuredMax }
  const conversationMin = Math.max(
    280,
    finite(config.minConversationWidth, DEFAULT_CONVERSATION_MIN_WIDTH),
  )
  const layoutMax = layout.currentWidth + layout.conversationWidth - conversationMin
  return { min, max: Math.max(min, Math.min(configuredMax, layoutMax)) }
}

export function clampSidebarWidth(width: number, bounds: SidebarWidthBounds): number {
  return Math.max(bounds.min, Math.min(bounds.max, width))
}

function readSidebarWidth(config: SidebarResizeConfig): number {
  const bounds = sidebarWidthBounds(config)
  const fallback = clampSidebarWidth(
    finite(config.defaultWidth, DEFAULT_SIDEBAR_WIDTH),
    bounds,
  )
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0
      ? clampSidebarWidth(stored, bounds)
      : fallback
  } catch {
    return fallback
  }
}

function sidebarWorkspaceKey(state: ClientSessionSnapshot): string {
  return (state.activeProjectId ?? state.session.workspace) || 'default'
}

function sidebarPinned(workspaceKey: string, defaultPinned: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_PIN_STORAGE_KEY)
    if (stored === 'true' || stored === 'false') return stored === 'true'

    const legacy = JSON.parse(
      window.localStorage.getItem(LEGACY_SIDEBAR_PIN_STORAGE_KEY) ?? '{}',
    )
    const migrated = legacy && typeof legacy === 'object' && !Array.isArray(legacy)
      ? (legacy as Record<string, unknown>)[workspaceKey]
      : undefined
    return typeof migrated === 'boolean' ? migrated : defaultPinned
  } catch {
    return defaultPinned
  }
}

function writeSidebarPinned(pinned: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_PIN_STORAGE_KEY, String(pinned))
  } catch {
    // Pin persistence is optional; the current sidebar state remains usable.
  }
}

function measuredBounds(root: HTMLElement, config: SidebarResizeConfig): SidebarWidthBounds {
  const main = root.parentElement?.querySelector<HTMLElement>(':scope > main')
  return sidebarWidthBounds(config, {
    currentWidth: root.getBoundingClientRect().width,
    conversationWidth: main?.getBoundingClientRect().width ?? DEFAULT_CONVERSATION_MIN_WIDTH,
  })
}

function appearance(surface: ClientSurfaceProps['surface']): {
  labeled: boolean
  buttonClass: string
} {
  const value = surface.appearance ?? 'icon'
  const labeled = value !== 'icon'
  return {
    labeled,
    buttonClass: labeled
      ? `${clientStyles.button} ghost small shell-control shell-control-labeled`
      : `${clientStyles.iconButton} shell-control`,
  }
}

function turnTag(state: ClientSessionSnapshot): ClientSessionSnapshot['turn']['tag'] {
  return state.turn.tag
}

interface SidebarHistoryDataSnapshot {
  history: ClientSessionSnapshot['history']
  projects: ClientSessionSnapshot['projects']
}

/** Keep chats visible while the global history list catches up with a new pane. */
export function historyWithOpenWorkspaceThreads(
  history: HistoryState,
  tabs: readonly WorkspaceTabTarget[],
): HistoryState {
  const entries = new Map(history.entries.map((thread) => [thread.id, thread]))
  let changed = false
  for (const tab of tabs) {
    for (const thread of tab.threads ?? []) {
      const listed = entries.get(thread.id)
      if (!listed) {
        entries.set(thread.id, thread)
        changed = true
      } else if (thread.projectId && !listed.projectId) {
        entries.set(thread.id, { ...listed, projectId: thread.projectId })
        changed = true
      }
    }
  }
  return changed ? { ...history, entries: [...entries.values()] } : history
}

function sidebarHistoryDataSnapshot(state: ClientSessionSnapshot): SidebarHistoryDataSnapshot {
  return { history: state.history, projects: state.projects }
}

function sidebarHistoryDataSnapshotEqual(
  left: SidebarHistoryDataSnapshot,
  right: SidebarHistoryDataSnapshot,
): boolean {
  return left.history === right.history && left.projects === right.projects
}

interface SidebarSelectionSnapshot {
  threadId?: string
  activeProjectId?: string
  turn: ClientSessionSnapshot['turn']['tag']
}

function sidebarSelectionSnapshot(state: ClientSessionSnapshot): SidebarSelectionSnapshot {
  return {
    ...(state.threadId ? { threadId: state.threadId } : {}),
    ...(state.activeProjectId ? { activeProjectId: state.activeProjectId } : {}),
    turn: state.turn.tag,
  }
}

function sidebarSelectionSnapshotEqual(
  left: SidebarSelectionSnapshot,
  right: SidebarSelectionSnapshot,
): boolean {
  return left.threadId === right.threadId
    && left.activeProjectId === right.activeProjectId
    && left.turn === right.turn
}

const sidebarClient: BrowserPlugin<SidebarResizeConfig> = (ctx, config) => {
  const session = ctx.clientSession
  const historySession = ctx.clientSessionRouter.globalSession()
  const overlays = ctx.clientUi.overlays
  const threadStatus = new OptionalThreadStatusService(ctx)
  const initialWorkspaceKey = sidebarWorkspaceKey(session.snapshot())
  const defaultPinned = config?.pinnedByDefault ?? true
  const initiallyPinned = sidebarPinned(initialWorkspaceKey, defaultPinned)
  const controller = new SidebarController({
    collapsed: initiallyPinned ? false : (config?.collapsedByDefault ?? true),
    pinned: initiallyPinned,
    workspaceKey: initialWorkspaceKey,
  })
  ctx.provide('clientSidebar', controller)

  function SidebarChrome(): ReactNode {
    const sidebar = useSyncExternalStore(controller.subscribe, controller.snapshot)
    const workspaceKey = useStoreSelector(session, sidebarWorkspaceKey)
    const turn = useStoreSelector(session, turnTag)
    const activeOverlay = useSyncExternalStore(overlays.subscribe, overlays.snapshot)
    const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    const [topbarControls, setTopbarControls] = useState<HTMLElement | null>(null)
    const newWorkspaceOpen = activeOverlay === 'new-workspace'

    useLayoutEffect(() => {
      setTopbarControls(document.querySelector<HTMLElement>('.workspace-history-controls'))
    }, [])

    useLayoutEffect(() => {
      controller.activateWorkspace(workspaceKey)
    }, [workspaceKey])

    useEffect(() => {
      writeSidebarPinned(sidebar.pinned)
    }, [sidebar.pinned])

    useLayoutEffect(() => {
      const root = document.documentElement
      const panel = document.querySelector<HTMLElement>('[data-shell-node="conversation-history"]')
      root.dataset.sidebarMode = sidebar.mode
      root.dataset.sidebarCollapsed = String(sidebar.collapsed)
      if (panel) {
        panel.id = 'conversation-history'
        panel.inert = sidebar.collapsed
        panel.setAttribute('aria-hidden', String(sidebar.collapsed))
      }
      return () => {
        if (root.dataset.sidebarMode === sidebar.mode) delete root.dataset.sidebarMode
        if (root.dataset.sidebarCollapsed === String(sidebar.collapsed)) {
          delete root.dataset.sidebarCollapsed
        }
      }
    }, [sidebar.collapsed, sidebar.mode])

    useEffect(() => {
      const panel = document.querySelector<HTMLElement>('[data-shell-node="conversation-history"]')
      const edge = document.querySelector<HTMLElement>('.sidebar-edge-zone')
      if (!panel || !edge) return
      const clearClose = (): void => {
        if (closeTimer.current === undefined) return
        clearTimeout(closeTimer.current)
        closeTimer.current = undefined
      }
      const revealFromEdge = (): void => {
        clearClose()
        if (controller.snapshot().mode === 'hidden') controller.setCollapsed(false)
      }
      const hasProtectedInteraction = (): boolean => (
        panel.matches(':hover')
        || panel.querySelector(':focus-visible, input:focus, textarea:focus, select:focus, [contenteditable="true"]:focus') !== null
        || activeOverlay !== undefined
        || document.documentElement.classList.contains('is-resizing-sidebar')
        || document.querySelector('.history-entry-menu') !== null
      )
      const closeFloating = (): void => {
        if (controller.snapshot().mode !== 'floating' || hasProtectedInteraction()) return
        controller.setCollapsed(true)
      }
      const scheduleClose = (): void => {
        clearClose()
        closeTimer.current = setTimeout(() => {
          closeTimer.current = undefined
          closeFloating()
        }, Math.max(0, finite(config?.closeDelayMs, DEFAULT_SIDEBAR_CLOSE_DELAY)))
      }
      const closeFromOutside = (event: PointerEvent): void => {
        if (controller.snapshot().mode !== 'floating') return
        const target = event.target
        if (!(target instanceof Node) || panel.contains(target) || edge.contains(target)) return
        if (
          target instanceof Element
          && target.closest('.history-entry-menu, .workspace-creator, .workspace-creator-backdrop')
        ) return
        clearClose()
        controller.setCollapsed(true)
      }
      const closeWithEscape = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || controller.snapshot().mode !== 'floating') return
        clearClose()
        controller.setCollapsed(true)
      }
      edge.addEventListener('pointerenter', revealFromEdge)
      edge.addEventListener('pointerdown', revealFromEdge)
      edge.addEventListener('pointerleave', scheduleClose)
      panel.addEventListener('pointerenter', clearClose)
      panel.addEventListener('pointerleave', scheduleClose)
      panel.addEventListener('focusin', clearClose)
      panel.addEventListener('focusout', scheduleClose)
      document.addEventListener('pointerdown', closeFromOutside)
      document.addEventListener('keydown', closeWithEscape)
      return () => {
        clearClose()
        edge.removeEventListener('pointerenter', revealFromEdge)
        edge.removeEventListener('pointerdown', revealFromEdge)
        edge.removeEventListener('pointerleave', scheduleClose)
        panel.removeEventListener('pointerenter', clearClose)
        panel.removeEventListener('pointerleave', scheduleClose)
        panel.removeEventListener('focusin', clearClose)
        panel.removeEventListener('focusout', scheduleClose)
        document.removeEventListener('pointerdown', closeFromOutside)
        document.removeEventListener('keydown', closeWithEscape)
      }
    }, [activeOverlay, config?.closeDelayMs])

    return (
      <>
        {topbarControls && createPortal(
          <button
            className="icon-button shell-control sidebar-topbar-toggle"
            type="button"
            title={sidebar.pinned ? 'Hide sidebar' : 'Show sidebar'}
            aria-label={sidebar.pinned ? 'Hide sidebar' : 'Show sidebar'}
            aria-controls="conversation-history"
            aria-expanded={!sidebar.collapsed}
            onClick={() => controller.toggle()}
          >
            <PanelLeft size={15} />
          </button>,
          topbarControls,
        )}
        <div className="sidebar-edge-zone" aria-hidden="true" />
        {newWorkspaceOpen && (
          <NewWorkspaceDialog
            disabled={turn !== 'idle'}
            onClose={() => overlays.close('new-workspace')}
            onCreate={(project) => session.createWorkspace(project)}
          />
        )}
      </>
    )
  }

  function NewThreadSurface({ surface }: ClientSurfaceProps): ReactNode {
    const { labeled, buttonClass } = appearance(surface)
    const label = surface.label ?? 'New chat'
    return (
      <>
        <button
          className={`${buttonClass} shell-sidebar-action`}
          type="button"
          data-hotkey-action="chat.new"
          title={label}
          aria-label={label}
          onClick={() => {
            overlays.closeAll()
            if (requestWorkspaceNewChat() && controller.snapshot().mode === 'floating') controller.setCollapsed(true)
          }}
        >
          <SquarePen size={16} strokeWidth={1.5} />
          {labeled && <span>{label}</span>}
        </button>
        <SidebarActions service={controller} />
      </>
    )
  }

  function NewWorkspaceSurface({ surface }: ClientSurfaceProps): ReactNode {
    const turn = useStoreSelector(session, turnTag)
    const activeOverlay = useSyncExternalStore(overlays.subscribe, overlays.snapshot)
    const { labeled, buttonClass } = appearance(surface)
    const label = surface.label ?? 'New workspace'
    return (
      <button
        className={`${buttonClass} shell-sidebar-action`}
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={activeOverlay === 'new-workspace'}
        disabled={turn !== 'idle'}
        onClick={() => overlays.open('new-workspace')}
      >
        <FolderPlus size={16} strokeWidth={1.5} />
        {labeled && <span>{label}</span>}
      </button>
    )
  }

  function HistorySurface({ surface }: ClientSurfaceProps): ReactNode {
    const [newThreadProblem, setNewThreadProblem] = useState('')
    const historyState = useStoreSelector(
      historySession,
      sidebarHistoryDataSnapshot,
      sidebarHistoryDataSnapshotEqual,
    )
    const selection = useStoreSelector(
      session,
      sidebarSelectionSnapshot,
      sidebarSelectionSnapshotEqual,
    )
    useSyncExternalStore(ctx.clientWorkspaceLayout.subscribe, ctx.clientWorkspaceLayout.snapshot)
    const statusState = useSyncExternalStore(threadStatus.subscribe, threadStatus.snapshot)
    useSyncExternalStore(ctx.clientUi.subscribe, ctx.clientUi.snapshot)
    const EntryDecoration = ctx.clientUi.component<HistoryEntryDecorationProps>(
      HISTORY_ENTRY_DECORATION_COMPONENT,
    )
    return (
      <HistoryPanel
        label={surface.label ?? ''}
        state={historyWithOpenWorkspaceThreads(historyState.history, ctx.clientWorkspaceLayout.tabs())}
        {...(selection.threadId ? { activeThreadId: selection.threadId } : {})}
        {...(selection.activeProjectId ? { activeProjectId: selection.activeProjectId } : {})}
        projects={historyState.projects}
        disabled={selection.turn !== 'idle'}
        newThreadDisabled={false}
        newThreadProblem={newThreadProblem}
        showAge={surface.showAge ?? true}
        emptyText={surface.emptyText ?? 'No conversations yet'}
        statusFor={(threadId) => threadWorkStatus(statusState, threadId)}
        {...(EntryDecoration ? { EntryDecoration } : {})}
        onNewWorkspace={() => overlays.open('new-workspace')}
        onClose={() => controller.setCollapsed(true)}
        onNewThread={(project) => {
          if (!requestWorkspaceNewChat(project.id)) {
            setNewThreadProblem('Workspace tabs are not ready. Try again in a moment.')
            return
          }
          setNewThreadProblem('')
          overlays.closeAll()
          if (controller.snapshot().mode === 'floating') controller.setCollapsed(true)
        }}
        onOpen={(thread) => {
          void session.openThread(thread)
        }}
        onRename={(thread, name) => session.renameThread(thread.id, name)}
        onRetry={() => void historySession.refreshHistory(surface.limit ?? 200)}
      />
    )
  }

  function ResizeSurface(): ReactNode {
    const handleRef = useRef<HTMLButtonElement>(null)
    const activeResize = useRef<(() => void) | undefined>(undefined)
    const [width, setWidth] = useState(() => readSidebarWidth(config))
    const bounds = sidebarWidthBounds(config)

    useLayoutEffect(() => {
      const root = document.documentElement
      const panel = handleRef.current?.closest<HTMLElement>('[data-shell-node="conversation-history"]')
      const value = `${width}px`
      root.style.setProperty('--sidebar-pane-width', value)
      panel?.style.setProperty('--sidebar-pane-width', value)
      return () => {
        if (root.style.getPropertyValue('--sidebar-pane-width') === value) {
          root.style.removeProperty('--sidebar-pane-width')
        }
      }
    }, [width])

    useEffect(() => {
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
      } catch {
        // Persistence is optional; resizing still works when browser storage is unavailable.
      }
    }, [width])

    useEffect(() => {
      const root = handleRef.current?.closest<HTMLElement>('[data-shell-node="conversation-history"]')
      const main = root?.parentElement?.querySelector<HTMLElement>(':scope > main')
      if (!root || !main) return
      const fitToLayout = (): void => {
        setWidth((current) => clampSidebarWidth(current, measuredBounds(root, config)))
      }
      fitToLayout()
      const observer = new ResizeObserver(fitToLayout)
      observer.observe(main)
      return () => observer.disconnect()
    }, [config])

    useEffect(() => () => activeResize.current?.(), [])

    const startResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      const root = handleRef.current?.closest<HTMLElement>('[data-shell-node="conversation-history"]')
      if (!root) return
      activeResize.current?.()
      controller.setPinned(true)
      const measured = measuredBounds(root, config)
      const origin = { x: event.clientX, width: root.getBoundingClientRect().width }
      const move = (pointer: PointerEvent): void => {
        setWidth(clampSidebarWidth(origin.width + pointer.clientX - origin.x, measured))
      }
      const stop = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        document.documentElement.classList.remove('is-resizing-sidebar')
        if (activeResize.current === stop) activeResize.current = undefined
      }
      activeResize.current = stop
      document.documentElement.classList.add('is-resizing-sidebar')
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
    }

    const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const root = handleRef.current?.closest<HTMLElement>('[data-shell-node="conversation-history"]')
      if (!root) return
      event.preventDefault()
      controller.setPinned(true)
      const measured = measuredBounds(root, config)
      const current = root.getBoundingClientRect().width
      const step = event.shiftKey ? 64 : 16
      const next = event.key === 'Home'
        ? measured.min
        : event.key === 'End'
          ? measured.max
          : current + (event.key === 'ArrowRight' ? step : -step)
      setWidth(clampSidebarWidth(next, measured))
    }

    const resetWidth = (): void => {
      const root = handleRef.current?.closest<HTMLElement>('[data-shell-node="conversation-history"]')
      if (!root) return
      controller.setPinned(true)
      setWidth(clampSidebarWidth(
        finite(config.defaultWidth, DEFAULT_SIDEBAR_WIDTH),
        measuredBounds(root, config),
      ))
    }

    return (
      <button
        className="sidebar-resize-handle"
        type="button"
        role="separator"
        aria-label="Resize conversation history"
        aria-orientation="vertical"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={Math.round(width)}
        title="Drag to resize. Double-click to reset."
        ref={handleRef}
        onDoubleClick={resetWidth}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
      />
    )
  }

  ctx.clientUi.registerSurface(ctx, 'default-new-thread', NewThreadSurface)
  ctx.clientUi.registerSurface(ctx, 'default-new-workspace', NewWorkspaceSurface)
  ctx.clientUi.registerSurface(ctx, 'default-history', HistorySurface)
  ctx.clientUi.registerSurface(ctx, 'default-sidebar-resize', ResizeSurface)
  ctx.clientUi.registerStyle(ctx, 'conversation-sidebar-structure', String(styles))
  ctx.clientUi.registerRoot(ctx, 'default-sidebar-visibility', SidebarChrome)
  return () => {
    threadStatus.dispose()
    controller.dispose()
  }
}

sidebarClient.inject = ['clientUi', 'clientSession', 'clientSessionRouter', 'clientWorkspaceLayout']
sidebarClient.provide = 'clientSidebar'
sidebarClient.resources = {
  provides: {
    surfaces: [
      'default-new-thread',
      'default-new-workspace',
      'default-history',
      'default-sidebar-resize',
    ],
    roots: ['default-sidebar-visibility'],
  },
}

export default sidebarClient
