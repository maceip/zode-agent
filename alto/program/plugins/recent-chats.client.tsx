import {
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { clientStyles, type BrowserPlugin } from '../../src/client/plugin-api.js'
import type { LocalProject, ThreadSummary } from '../../src/shared/protocol.js'
import type {
  ClientRecentChatsService,
  ClientRecentChatsSnapshot,
} from './recent-chats-api.js'
import type {
  ClientConversationService,
  ClientSessionSnapshot,
} from './session-api.js'
import type { ClientThreadStatusService } from './thread-status-api.js'
import type { ClientWorkspaceLayoutService } from './workspace-layout-api.js'
import {
  OptionalThreadStatusService,
  threadWorkStatus,
} from './thread-status-api.js'
import {
  ConversationPaneOverlay,
  conversationPaneBounds,
} from './ui/conversation-overlay.js'
import { useStoreSelector } from './ui/store-selector.js'
import { ThreadStatusIndicator } from './ui/thread-status.js'
import styles from './recent-chats.css'

interface RecentChatsConfig {
  limit?: number
  previewLimit?: number
}

const RECENT_KEY = 'codex-cordis.recent-chats'
const LEGACY_RECENT_KEYS = [
  'codex-cordis.harpoon.recent',
  'codex-cordis.hotkeys.recent',
]
const DEFAULT_RECENT_LIMIT = 30
const DEFAULT_PREVIEW_LIMIT = 10

function safeRead(key: string): unknown {
  try {
    const value = window.localStorage.getItem(key)
    return value === null ? undefined : JSON.parse(value)
  } catch {
    return undefined
  }
}

function safeWrite(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // The switcher remains useful for this session when persistence is unavailable.
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value!)) : fallback
}

function readRecentIds(): string[] {
  const current = safeRead(RECENT_KEY)
  const legacy = current === undefined
    ? LEGACY_RECENT_KEYS.map(safeRead).find((value) => value !== undefined)
    : undefined
  const value = current ?? legacy
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string')
    : []
}

export function orderRecentThreads(
  recentIds: readonly string[],
  threads: readonly ThreadSummary[],
): ThreadSummary[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  const ordered = recentIds.flatMap((id) => byId.get(id) ?? [])
  const seen = new Set(ordered.map((thread) => thread.id))
  for (const thread of threads) {
    if (seen.has(thread.id)) continue
    ordered.push(thread)
    seen.add(thread.id)
  }
  return ordered
}

export function nextRecentThread(
  threads: readonly ThreadSummary[],
  currentId: string | undefined,
  selectedId: string | undefined,
  direction: 1 | -1,
): ThreadSummary | undefined {
  if (!threads.length) return undefined
  const anchor = selectedId ?? currentId
  const current = threads.findIndex((thread) => thread.id === anchor)
  if (current < 0) return threads[direction > 0 ? 0 : threads.length - 1]
  return threads[(current + direction + threads.length) % threads.length]
}

export function recentThreadWorkspace(
  thread: ThreadSummary,
  projects: readonly LocalProject[],
): string {
  const project = thread.projectId
    ? projects.find((candidate) => candidate.id === thread.projectId)
    : undefined
  if (project) return project.name
  const parts = thread.cwd.trim().replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.at(-1) ?? ''
}

export function recentSwitcherPane(
  left: number,
  width: number,
  viewportWidth: number,
): { left: number; width: number } {
  return conversationPaneBounds(left, width, viewportWidth)
}

export function recentChatsShortcutEnabled(
  idle: boolean,
  workspaceLayoutAvailable: boolean,
): boolean {
  return idle && !workspaceLayoutAvailable
}

export function shouldCommitRecentGesture(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'key'>): boolean {
  return event.key === 'Control'
    || event.code === 'ControlLeft'
    || event.code === 'ControlRight'
    || (event.key === 'Tab' && !event.ctrlKey)
}

export class RecentChatsService implements ClientRecentChatsService {
  private readonly listeners = new Set<() => void>()
  private readonly disposeSession: () => void
  private readonly recentLimit: number
  private readonly previewLimit: number
  private readonly keyup = (event: KeyboardEvent) => {
    if (shouldCommitRecentGesture(event)) this.commit()
  }
  private readonly keydown = (event: KeyboardEvent) => {
    if (!this.selectedThreadId || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    this.cancel()
  }
  private readonly blur = () => this.cancel()
  private sessionState: ClientSessionSnapshot
  private recentIds: string[]
  private cycleCandidates?: ThreadSummary[]
  private selectedThreadId?: string
  private navigationThreadId?: string
  private state: ClientRecentChatsSnapshot
  private disposed = false

  constructor(
    private readonly session: ClientConversationService,
    config: RecentChatsConfig,
  ) {
    this.recentLimit = positiveInteger(config.limit, DEFAULT_RECENT_LIMIT)
    this.previewLimit = Math.min(
      this.recentLimit,
      positiveInteger(config.previewLimit, DEFAULT_PREVIEW_LIMIT),
    )
    this.sessionState = session.snapshot()
    this.recentIds = readRecentIds()
    this.recordRecent(this.sessionState.threadId)
    this.state = this.buildSnapshot(0)
    this.disposeSession = session.subscribe(() => this.syncSession())
    window.addEventListener('keyup', this.keyup, true)
    window.addEventListener('keydown', this.keydown, true)
    window.addEventListener('blur', this.blur)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientRecentChatsSnapshot => this.state

  cycle(direction: 1 | -1): void {
    if (this.sessionState.turn.tag !== 'idle') return
    const recent = this.cycleCandidates ?? this.orderedVisibleThreads()
    if (recent.length < 2) return
    this.cycleCandidates ??= recent
    const thread = nextRecentThread(
      recent,
      this.sessionState.threadId,
      this.selectedThreadId ?? this.navigationThreadId,
      direction,
    )
    if (!thread) return
    this.selectedThreadId = thread.id
    this.emit()
  }

  select(threadId: string): void {
    if (!this.visibleThreads().some((thread) => thread.id === threadId)) return
    this.selectedThreadId = threadId
    this.emit()
  }

  commit(): void {
    const threadId = this.selectedThreadId
    if (!threadId) return
    delete this.selectedThreadId
    delete this.cycleCandidates
    this.emit()
    this.openThread(threadId)
  }

  cancel(): void {
    if (!this.selectedThreadId) return
    delete this.selectedThreadId
    delete this.cycleCandidates
    this.emit()
  }

  openThread(threadId: string): void {
    const live = this.session.snapshot()
    const thread = live.threads.find((candidate) => candidate.id === threadId)
    if (!thread || live.turn.tag !== 'idle') return
    if (this.selectedThreadId || this.cycleCandidates) {
      delete this.selectedThreadId
      delete this.cycleCandidates
      this.emit()
    }
    if (thread.id === live.threadId || thread.id === this.navigationThreadId) return

    this.navigationThreadId = thread.id
    void this.session.openThread(thread).then(() => {
      if (
        this.navigationThreadId === thread.id
        && this.session.snapshot().threadId !== thread.id
      ) {
        delete this.navigationThreadId
      }
    }).catch((error: unknown) => {
      if (this.navigationThreadId === thread.id) delete this.navigationThreadId
      console.error(error)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeSession()
    window.removeEventListener('keyup', this.keyup, true)
    window.removeEventListener('keydown', this.keydown, true)
    window.removeEventListener('blur', this.blur)
    this.listeners.clear()
  }

  private syncSession(): void {
    const next = this.session.snapshot()
    if (sameRecentChatsSession(this.sessionState, next)) return
    const threadChanged = next.threadId !== this.sessionState.threadId
    this.sessionState = next
    if (threadChanged) {
      delete this.navigationThreadId
      this.recordRecent(next.threadId)
    }
    if (next.turn.tag !== 'idle' && this.selectedThreadId) {
      delete this.selectedThreadId
      delete this.cycleCandidates
    }
    this.emit()
  }

  private recordRecent(threadId: string | undefined): void {
    if (!threadId) return
    this.recentIds = [threadId, ...this.recentIds.filter((id) => id !== threadId)]
      .slice(0, this.recentLimit)
    safeWrite(RECENT_KEY, this.recentIds)
  }

  private orderedVisibleThreads(): ThreadSummary[] {
    return orderRecentThreads(this.recentIds, this.sessionState.threads)
      .slice(0, this.previewLimit)
  }

  private visibleThreads(): ThreadSummary[] {
    return this.cycleCandidates ?? this.orderedVisibleThreads()
  }

  private buildSnapshot(revision: number): ClientRecentChatsSnapshot {
    return {
      revision,
      recent: this.visibleThreads(),
      ...(this.selectedThreadId ? { selectedThreadId: this.selectedThreadId } : {}),
    }
  }

  private emit(): void {
    if (this.disposed) return
    this.state = this.buildSnapshot(this.state.revision + 1)
    for (const listener of this.listeners) listener()
  }
}

function sameRecentChatsSession(
  left: ClientSessionSnapshot,
  right: ClientSessionSnapshot,
): boolean {
  return left.threadId === right.threadId
    && left.turn.tag === right.turn.tag
    && left.projects === right.projects
    && left.threads === right.threads
}

function sessionProjects(state: ClientSessionSnapshot): ClientSessionSnapshot['projects'] {
  return state.projects
}

function RecentChatsDialog({
  state,
  service,
  session,
  threadStatus,
}: {
  state: ClientRecentChatsSnapshot
  service: ClientRecentChatsService
  session: ClientConversationService
  threadStatus: ClientThreadStatusService
}): ReactNode {
  const projects = useStoreSelector(session, sessionProjects)
  const statusState = useSyncExternalStore(threadStatus.subscribe, threadStatus.snapshot)
  return (
    <ConversationPaneOverlay className={`${clientStyles.overlayLayer} recent-chat-switcher-layer`} onMouseDown={() => service.cancel()}>
      <section
        className={`${clientStyles.floatingPanel} recent-chat-switcher`}
        role="dialog"
        aria-label="Recently viewed chats"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>Recently viewed</header>
        <div className="recent-chat-switcher-list" role="listbox" aria-label="Recently viewed chats">
          {state.recent.map((thread) => {
            const selected = thread.id === state.selectedThreadId
            const status = threadWorkStatus(statusState, thread.id)
            return (
              <button
                className={[
                  selected && 'selected',
                  status && 'has-status',
                ].filter(Boolean).join(' ')}
                type="button"
                role="option"
                aria-selected={selected}
                key={thread.id}
                onMouseEnter={() => service.select(thread.id)}
                onClick={() => service.openThread(thread.id)}
              >
                {status && (
                  <span className="recent-chat-leading">
                    <ThreadStatusIndicator status={status} />
                  </span>
                )}
                <span className="recent-chat-title">{thread.title}</span>
                <small>{recentThreadWorkspace(thread, projects)}</small>
              </button>
            )
          })}
        </div>
      </section>
    </ConversationPaneOverlay>
  )
}

function RecentChatsRoot({
  service,
  session,
  threadStatus,
}: {
  service: ClientRecentChatsService
  session: ClientConversationService
  threadStatus: ClientThreadStatusService
}): ReactNode {
  const state = useSyncExternalStore(service.subscribe, service.snapshot)
  if (!state.selectedThreadId) return null
  return (
    <RecentChatsDialog
      state={state}
      service={service}
      session={session}
      threadStatus={threadStatus}
    />
  )
}

const recentChatsClient: BrowserPlugin<RecentChatsConfig> = (ctx, config) => {
  const session = ctx.clientConversation
  const threadStatus = new OptionalThreadStatusService(ctx)
  const hotkeys = ctx.clientHotkeys
  const ui = ctx.clientUi
  const service = new RecentChatsService(session, config)
  ctx.provide('clientRecentChats', service)

  const workspaceLayoutAvailable = (): boolean => (
    (ctx.get('clientWorkspaceLayout', false) as ClientWorkspaceLayoutService | undefined)
      ?.available() ?? false
  )
  const enabled = () => recentChatsShortcutEnabled(
    session.snapshot().turn.tag === 'idle',
    workspaceLayoutAvailable(),
  )
  hotkeys.registerAction(ctx, {
    id: 'recent-chats.next',
    label: 'Next recent chat',
    detail: 'Preview recently viewed chats and open the highlighted one on release.',
    category: 'Recent chats',
    binding: { kind: 'global', key: 'Tab', ctrl: true },
    enabled,
    run: () => service.cycle(1),
  })
  hotkeys.registerAction(ctx, {
    id: 'recent-chats.previous',
    label: 'Previous recent chat',
    category: 'Recent chats',
    binding: { kind: 'global', key: 'Tab', ctrl: true, shift: true },
    enabled,
    run: () => service.cycle(-1),
  })

  const BoundRoot = () => (
    <RecentChatsRoot service={service} session={session} threadStatus={threadStatus} />
  )
  ui.registerRoot(ctx, 'recent-chats', BoundRoot)
  ui.registerStyle(ctx, 'recent-chats', String(styles))
  return () => {
    threadStatus.dispose()
    service.dispose()
  }
}

recentChatsClient.inject = ['clientUi', 'clientConversation', 'clientHotkeys']
recentChatsClient.provide = 'clientRecentChats'
recentChatsClient.resources = { provides: { roots: ['recent-chats'] } }

export default recentChatsClient
