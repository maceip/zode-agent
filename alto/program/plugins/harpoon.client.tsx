import {
  Anchor,
  ArrowUpRight,
  Check,
  Circle,
  Folder,
  Pin,
  PinOff,
  X,
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  clientStyles,
  type BrowserPlugin,
  type ClientOverlays,
  type ClientUiService,
} from '../../src/client/plugin-api.js'
import { threadRecencyAt, type ThreadSummary } from '../../src/shared/protocol.js'
import type {
  ClientHarpoonService,
  ClientHarpoonSnapshot,
  HarpoonSlot,
} from './harpoon-api.js'
import type { HotkeyAction } from './hotkeys-api.js'
import type {
  ClientSessionService,
  ClientSessionSnapshot,
} from './session-api.js'
import type {
  ClientThreadStatusService,
  ClientThreadStatusSnapshot,
} from './thread-status-api.js'
import {
  OptionalThreadStatusService,
  threadWorkStatus,
} from './thread-status-api.js'
import { ConversationPaneOverlay } from './ui/conversation-overlay.js'
import { useStoreSelector } from './ui/store-selector.js'
import { ThreadStatusIndicator } from './ui/thread-status.js'
import styles from './harpoon.css'

interface HarpoonConfig {
  slotCount?: number
  prefetch?: boolean
}

interface PersistedSlots {
  version: 1
  slots: Array<string | null>
}

const DEFAULT_SLOT_COUNT = 9
const MAX_SLOT_COUNT = 9

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
    // Harpoon remains usable for this session when persistence is unavailable.
  }
}

function normalizedSlotCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SLOT_COUNT
  return Math.min(MAX_SLOT_COUNT, Math.max(1, Math.floor(value!)))
}

export function harpoonScopeKey(
  state: Pick<ClientSessionSnapshot, 'activeProjectId' | 'session'>,
): string {
  return state.activeProjectId
    ? `project:${state.activeProjectId}`
    : `workspace:${state.session.workspace || 'unassigned'}`
}

export function assignHarpoonSlot(
  slots: readonly (string | undefined)[],
  threadId: string,
  slotCount = DEFAULT_SLOT_COUNT,
): Array<string | undefined> {
  const count = normalizedSlotCount(slotCount)
  const next = Array.from({ length: count }, (_, index) => slots[index])
  if (next.includes(threadId)) return next
  const empty = next.findIndex((slot) => !slot)
  next[empty >= 0 ? empty : count - 1] = threadId
  return next
}

export function assignHarpoonSlotAt(
  slots: readonly (string | undefined)[],
  threadId: string,
  index: number,
  slotCount = DEFAULT_SLOT_COUNT,
): Array<string | undefined> {
  const count = normalizedSlotCount(slotCount)
  const next = Array.from({ length: count }, (_, slotIndex) => slots[slotIndex])
  if (index < 0 || index >= count) return next
  for (let slotIndex = 0; slotIndex < next.length; slotIndex += 1) {
    if (next[slotIndex] === threadId) next[slotIndex] = undefined
  }
  next[index] = threadId
  return next
}

export type HarpoonKeyCommand =
  | { kind: 'move'; direction: 1 | -1 }
  | { kind: 'boundary'; boundary: 'first' | 'last' }
  | { kind: 'toggle' }
  | { kind: 'assign'; index: number }
  | { kind: 'open' }
  | { kind: 'close' }

interface HarpoonKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

export function harpoonKeyCommand(event: HarpoonKeyEvent): HarpoonKeyCommand | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined
  if (event.key === 'ArrowDown' || event.key.toLocaleLowerCase() === 'j') {
    return { kind: 'move', direction: 1 }
  }
  if (event.key === 'ArrowUp' || event.key.toLocaleLowerCase() === 'k') {
    return { kind: 'move', direction: -1 }
  }
  if (event.key === 'Home' || event.key === 'g') {
    return { kind: 'boundary', boundary: 'first' }
  }
  if (event.key === 'End' || event.key === 'G') {
    return { kind: 'boundary', boundary: 'last' }
  }
  if (event.key.toLocaleLowerCase() === 'p') return { kind: 'toggle' }
  if (/^[1-9]$/.test(event.key)) return { kind: 'assign', index: Number(event.key) - 1 }
  if (event.key === 'Enter') return { kind: 'open' }
  if (event.key === 'Escape') return { kind: 'close' }
  return undefined
}

function comparablePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLocaleLowerCase() : normalized
}

export function harpoonCandidates(
  state: Pick<
    ClientSessionSnapshot,
    'activeProjectId' | 'projects' | 'session' | 'threadId' | 'threads'
  >,
): ThreadSummary[] {
  const activeProject = state.projects.find((project) => project.id === state.activeProjectId)
  const workspace = comparablePath(state.session.workspace)
  const roots = activeProject?.roots.map(comparablePath) ?? []
  const scoped = state.threads.filter((thread) => {
    if (thread.id === state.threadId) return true
    if (activeProject && thread.projectId === activeProject.id) return true
    const cwd = comparablePath(thread.cwd)
    if (roots.some((root) => cwd === root || cwd.startsWith(`${root}/`))) return true
    return !activeProject && Boolean(workspace) && cwd === workspace
  })
  return scoped.toSorted((left, right) => {
    if (left.id === state.threadId) return -1
    if (right.id === state.threadId) return 1
    return threadRecencyAt(right) - threadRecencyAt(left) || left.title.localeCompare(right.title)
  })
}

function slotStorageKey(scopeKey: string): string {
  return `codex-cordis.harpoon.slots:${scopeKey}`
}

function legacySlotStorageKey(scopeKey: string): string {
  return `codex-cordis.hotkeys.harpoon:${scopeKey}`
}

function readSlots(scopeKey: string, slotCount: number): Array<string | undefined> {
  const current = safeRead(slotStorageKey(scopeKey))
  const legacy = current === undefined ? safeRead(legacySlotStorageKey(scopeKey)) : undefined
  const value = (current ?? legacy) as Partial<PersistedSlots> | undefined
  if (value?.version !== 1 || !Array.isArray(value.slots)) {
    return Array.from({ length: slotCount })
  }
  return Array.from({ length: slotCount }, (_, index) => {
    const slot = value.slots?.[index]
    return typeof slot === 'string' ? slot : undefined
  })
}

export class HarpoonService implements ClientHarpoonService {
  private readonly listeners = new Set<() => void>()
  private readonly disposeSession: () => void
  private readonly slotCount: number
  private readonly prefetchEnabled: boolean
  private readonly prefetched = new Map<string, number>()
  private sessionState: ClientSessionSnapshot
  private scopeKey: string
  private slots: Array<string | undefined>
  private selectedThreadId: string | undefined
  private state: ClientHarpoonSnapshot
  private prefetchQueue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(
    private readonly session: ClientSessionService,
    private readonly ui: ClientUiService,
    config: HarpoonConfig,
  ) {
    this.slotCount = normalizedSlotCount(config.slotCount)
    this.prefetchEnabled = config.prefetch ?? true
    this.sessionState = session.snapshot()
    this.scopeKey = harpoonScopeKey(this.sessionState)
    this.slots = readSlots(this.scopeKey, this.slotCount)
    this.selectedThreadId = this.defaultSelection(this.sessionState)
    this.state = this.buildSnapshot(0)
    this.disposeSession = session.subscribe(() => this.syncSession())
    this.prefetchSlots()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientHarpoonSnapshot => this.state

  open(): void {
    this.selectedThreadId = this.defaultSelection(this.sessionState)
    this.emit()
    this.ui.overlays.open('harpoon')
  }

  toggleCurrentTag(): void {
    if (this.sessionState.threadId) this.toggleTag(this.sessionState.threadId)
  }

  toggleTag(threadId: string): void {
    const existing = this.slots.indexOf(threadId)
    if (existing >= 0) {
      this.slots[existing] = undefined
      this.prefetched.delete(threadId)
    }
    else {
      this.slots = assignHarpoonSlot(this.slots, threadId, this.slotCount)
      this.prefetchThread(threadId)
    }
    this.persistSlots()
    this.emit()
  }

  removeSlot(index: number): void {
    if (index < 0 || index >= this.slotCount || !this.slots[index]) return
    this.prefetched.delete(this.slots[index]!)
    this.slots[index] = undefined
    this.persistSlots()
    this.emit()
  }

  openSlot(index: number): void {
    const threadId = this.slots[index]
    if (threadId) this.openThread(threadId)
  }

  selectThread(threadId: string): void {
    if (
      threadId === this.selectedThreadId
      || !harpoonCandidates(this.sessionState).some((thread) => thread.id === threadId)
    ) return
    this.selectedThreadId = threadId
    this.emit()
  }

  moveSelection(direction: 1 | -1): void {
    const candidates = harpoonCandidates(this.sessionState)
    if (!candidates.length) return
    const current = candidates.findIndex((thread) => thread.id === this.selectedThreadId)
    const index = current < 0
      ? (direction > 0 ? 0 : candidates.length - 1)
      : Math.max(0, Math.min(candidates.length - 1, current + direction))
    this.selectThread(candidates[index]!.id)
  }

  selectBoundary(boundary: 'first' | 'last'): void {
    const candidates = harpoonCandidates(this.sessionState)
    const thread = candidates[boundary === 'first' ? 0 : candidates.length - 1]
    if (thread) this.selectThread(thread.id)
  }

  toggleSelected(): void {
    if (this.selectedThreadId) this.toggleTag(this.selectedThreadId)
  }

  assignSelectedSlot(index: number): void {
    const threadId = this.selectedThreadId
    if (!threadId || index < 0 || index >= this.slotCount) return
    this.slots = assignHarpoonSlotAt(this.slots, threadId, index, this.slotCount)
    this.persistSlots()
    this.prefetchThread(threadId)
    this.emit()
  }

  openSelected(): void {
    if (this.selectedThreadId) this.openThread(this.selectedThreadId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeSession()
    this.listeners.clear()
  }

  private syncSession(): void {
    const next = this.session.snapshot()
    if (sameHarpoonSession(this.sessionState, next)) return
    const nextScope = harpoonScopeKey(next)
    this.sessionState = next
    if (nextScope !== this.scopeKey) {
      this.scopeKey = nextScope
      this.slots = readSlots(nextScope, this.slotCount)
    }
    if (!harpoonCandidates(next).some((thread) => thread.id === this.selectedThreadId)) {
      this.selectedThreadId = this.defaultSelection(next)
    }
    this.prefetchSlots()
    this.emit()
  }

  private prefetchSlots(): void {
    for (const threadId of this.slots) {
      if (threadId) this.prefetchThread(threadId)
    }
  }

  private prefetchThread(threadId: string): void {
    if (!this.prefetchEnabled) return
    const thread = this.sessionState.threads.find((candidate) => candidate.id === threadId)
    if (!thread || this.prefetched.get(thread.id) === thread.updatedAt) return
    this.prefetched.set(thread.id, thread.updatedAt)
    this.prefetchQueue = this.prefetchQueue.then(async () => {
      if (this.disposed) return
      try {
        await this.session.prefetchThread(thread)
      } catch {
        if (this.prefetched.get(thread.id) === thread.updatedAt) {
          this.prefetched.delete(thread.id)
        }
      }
    })
  }

  private defaultSelection(state: ClientSessionSnapshot): string | undefined {
    const candidates = harpoonCandidates(state)
    return candidates.find((thread) => thread.id === state.threadId)?.id ?? candidates[0]?.id
  }

  private openThread(threadId: string): void {
    const thread = this.sessionState.threads.find((candidate) => candidate.id === threadId)
    if (!thread || this.sessionState.turn.tag !== 'idle') return
    this.ui.overlays.closeAll()
    if (thread.id === this.sessionState.threadId) return
    void this.session.openThread(thread).catch((error: unknown) => console.error(error))
  }

  private buildSnapshot(revision: number): ClientHarpoonSnapshot {
    const threads = new Map(this.sessionState.threads.map((thread) => [thread.id, thread]))
    const slots: HarpoonSlot[] = Array.from({ length: this.slotCount }, (_, index) => {
      const threadId = this.slots[index]
      const thread = threadId ? threads.get(threadId) : undefined
      return {
        index,
        ...(threadId ? { threadId } : {}),
        ...(thread ? { thread } : {}),
        active: Boolean(threadId && threadId === this.sessionState.threadId),
      }
    })
    return {
      revision,
      slots,
      candidates: harpoonCandidates(this.sessionState),
      ...(this.selectedThreadId ? { selectedThreadId: this.selectedThreadId } : {}),
      ...(this.sessionState.threadId ? { activeThreadId: this.sessionState.threadId } : {}),
    }
  }

  private emit(): void {
    if (this.disposed) return
    this.state = this.buildSnapshot(this.state.revision + 1)
    for (const listener of this.listeners) listener()
  }

  private persistSlots(): void {
    safeWrite(slotStorageKey(this.scopeKey), {
      version: 1,
      slots: this.slots.map((slot) => slot ?? null),
    } satisfies PersistedSlots)
  }
}

function sameHarpoonSession(
  left: ClientSessionSnapshot,
  right: ClientSessionSnapshot,
): boolean {
  return left.threadId === right.threadId
    && left.activeProjectId === right.activeProjectId
    && left.session.workspace === right.session.workspace
    && left.turn.tag === right.turn.tag
    && left.projects === right.projects
    && left.threads === right.threads
}

function workspaceName(
  thread: ThreadSummary,
  projects: ClientSessionSnapshot['projects'],
): string {
  const project = thread.projectId
    ? projects.find((candidate) => candidate.id === thread.projectId)
    : undefined
  if (project) return project.name
  const parts = thread.cwd.trim().replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.at(-1) ?? thread.cwd
}

function updatedLabel(updatedAt: number): string {
  if (!updatedAt) return ''
  return new Date(updatedAt * 1_000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function HarpoonSlotCard({
  slot,
  service,
  statusState,
}: {
  slot: HarpoonSlot
  service: ClientHarpoonService
  statusState: ClientThreadStatusSnapshot
}): ReactNode {
  const status = slot.threadId ? threadWorkStatus(statusState, slot.threadId) : undefined
  return (
    <div className={`harpoon-slot-card ${slot.active ? 'active' : ''} ${slot.thread ? '' : 'empty'}`}>
      <button
        type="button"
        data-hotkey-action={`harpoon.slot.${slot.index + 1}`}
        disabled={!slot.thread}
        onClick={() => service.openSlot(slot.index)}
        title={slot.thread?.title}
      >
        <kbd>{slot.index + 1}</kbd>
        <span className="harpoon-slot-title">{slot.thread?.title ?? (slot.threadId ? 'Unavailable' : 'Empty')}</span>
        <ThreadStatusIndicator status={status} />
      </button>
      {slot.threadId && (
        <button className="harpoon-remove" type="button" aria-label={`Remove slot ${slot.index + 1}`} onClick={() => service.removeSlot(slot.index)}>
          <PinOff size={14} />
        </button>
      )}
    </div>
  )
}

function HarpoonCandidateList({
  state,
  projects,
  service,
  statusState,
}: {
  state: ClientHarpoonSnapshot
  projects: ClientSessionSnapshot['projects']
  service: ClientHarpoonService
  statusState: ClientThreadStatusSnapshot
}): ReactNode {
  const selectedRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [state.selectedThreadId])
  const pinned = new Map(state.slots.flatMap((slot) => (
    slot.threadId ? [[slot.threadId, slot.index + 1] as const] : []
  )))
  return (
    <section className="harpoon-browser">
      <header>
        <h2>Chats</h2>
        <span>{state.candidates.length}</span>
      </header>
      <div
        className="harpoon-candidates"
        role="listbox"
        aria-label="Workspace chats"
        aria-activedescendant={state.selectedThreadId ? `harpoon-candidate-${state.selectedThreadId}` : undefined}
      >
        {state.candidates.map((thread) => {
          const selected = thread.id === state.selectedThreadId
          const slot = pinned.get(thread.id)
          return (
            <button
              id={`harpoon-candidate-${thread.id}`}
              className={selected ? 'selected' : ''}
              type="button"
              role="option"
              aria-selected={selected}
              ref={selected ? selectedRef : undefined}
              key={thread.id}
              onClick={() => service.selectThread(thread.id)}
              onDoubleClick={() => service.openSelected()}
            >
              <span className={`harpoon-candidate-mark ${slot ? 'pinned' : ''}`}>
                {slot ?? <Circle size={8} />}
              </span>
              <span className="harpoon-candidate-copy">
                <strong>{thread.title}</strong>
                <small>{workspaceName(thread, projects)}</small>
              </span>
              <span className="harpoon-candidate-status">
                <ThreadStatusIndicator status={threadWorkStatus(statusState, thread.id)} />
                {thread.id === state.activeThreadId && <Check className="harpoon-current-mark" size={13} />}
              </span>
            </button>
          )
        })}
        {!state.candidates.length && <p className="harpoon-empty">No chats in this workspace.</p>}
      </div>
    </section>
  )
}

function HarpoonPreview({
  state,
  projects,
  service,
  statusState,
}: {
  state: ClientHarpoonSnapshot
  projects: ClientSessionSnapshot['projects']
  service: ClientHarpoonService
  statusState: ClientThreadStatusSnapshot
}): ReactNode {
  const thread = state.candidates.find((candidate) => candidate.id === state.selectedThreadId)
  const pinned = state.slots.find((slot) => slot.threadId === thread?.id)
  if (!thread) {
    return <section className="harpoon-preview harpoon-preview-empty">Select a chat to preview it.</section>
  }
  return (
    <section className="harpoon-preview">
      <header className="harpoon-preview-header">
        <div>
          <span className="harpoon-preview-location"><Folder size={12} />{workspaceName(thread, projects)}</span>
          <h2>
            <span>{thread.title}</span>
            <ThreadStatusIndicator status={threadWorkStatus(statusState, thread.id)} />
          </h2>
          <time>{updatedLabel(threadRecencyAt(thread))}</time>
        </div>
        {pinned && <span className="harpoon-pinned-badge"><Pin size={11} /> Slot {pinned.index + 1}</span>}
      </header>
      <div className="harpoon-preview-copy">
        {thread.preview || 'This chat does not have a text preview yet.'}
      </div>
      <div className="harpoon-preview-actions">
        <button type="button" onClick={() => service.toggleSelected()}>
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          {pinned ? 'Unpin' : 'Pin'}
          <kbd>P</kbd>
        </button>
        <button className="primary" type="button" onClick={() => service.openSelected()}>
          Open
          <ArrowUpRight size={14} />
        </button>
      </div>
      <div className="harpoon-slots-heading">
        <h3>Pinned slots</h3>
        <span>Press a number to assign this chat</span>
      </div>
      <div className="harpoon-slots">
        {state.slots.map((slot) => (
          <HarpoonSlotCard
            slot={slot}
            service={service}
            statusState={statusState}
            key={slot.index}
          />
        ))}
      </div>
    </section>
  )
}

function HarpoonPanel({
  state,
  projects,
  service,
  statusState,
}: {
  state: ClientHarpoonSnapshot
  projects: ClientSessionSnapshot['projects']
  service: ClientHarpoonService
  statusState: ClientThreadStatusSnapshot
}): ReactNode {
  return (
    <div className="harpoon-panel-body">
      <HarpoonCandidateList state={state} projects={projects} service={service} statusState={statusState} />
      <HarpoonPreview state={state} projects={projects} service={service} statusState={statusState} />
    </div>
  )
}

function sessionProjects(state: ClientSessionSnapshot): ClientSessionSnapshot['projects'] {
  return state.projects
}

function HarpoonDialog({
  service,
  session,
  threadStatus,
  overlays,
}: {
  service: ClientHarpoonService
  session: ClientSessionService
  threadStatus: ClientThreadStatusService
  overlays: ClientOverlays
}): ReactNode {
  const state = useSyncExternalStore(service.subscribe, service.snapshot)
  const projects = useStoreSelector(session, sessionProjects)
  const statusState = useSyncExternalStore(threadStatus.subscribe, threadStatus.snapshot)
  const close = () => overlays.close('harpoon')
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true })
    const handleKey = (event: globalThis.KeyboardEvent): void => {
      const command = harpoonKeyCommand(event)
      if (!command) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat && !['move', 'boundary'].includes(command.kind)) return
      if (command.kind === 'move') service.moveSelection(command.direction)
      else if (command.kind === 'boundary') service.selectBoundary(command.boundary)
      else if (command.kind === 'toggle') service.toggleSelected()
      else if (command.kind === 'assign') service.assignSelectedSlot(command.index)
      else if (command.kind === 'open') service.openSelected()
      else close()
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [service, overlays])

  return (
    <ConversationPaneOverlay className={`${clientStyles.overlayLayer} harpoon-backdrop`} onMouseDown={close}>
      <section ref={dialogRef} className={`${clientStyles.floatingPanel} harpoon-dialog`} role="dialog" aria-modal="true" aria-label="Harpoon" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header className="harpoon-dialog-header">
          <span className="harpoon-dialog-title">
            <Anchor size={16} />
            <span><strong>Harpoon</strong><small>Workspace chat pins</small></span>
          </span>
          <button className={`${clientStyles.iconButton} harpoon-close`} type="button" aria-label="Close Harpoon" onClick={close}><X size={15} /></button>
        </header>
        <HarpoonPanel state={state} projects={projects} service={service} statusState={statusState} />
        <footer className="harpoon-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd><kbd>J</kbd><kbd>K</kbd> Move</span>
          <span><kbd>P</kbd> Pin</span>
          <span><kbd>1–9</kbd> Assign</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
        </footer>
      </section>
    </ConversationPaneOverlay>
  )
}

function HarpoonRoot({
  service,
  session,
  threadStatus,
  overlays,
}: {
  service: ClientHarpoonService
  session: ClientSessionService
  threadStatus: ClientThreadStatusService
  overlays: ClientOverlays
}): ReactNode {
  const activeOverlay = useSyncExternalStore(overlays.subscribe, overlays.snapshot)
  if (activeOverlay !== 'harpoon') return null
  return (
    <HarpoonDialog
      service={service}
      session={session}
      threadStatus={threadStatus}
      overlays={overlays}
    />
  )
}

function leaderAction(
  id: string,
  key: string,
  label: string,
  run: HotkeyAction['run'],
  detail?: string,
  enabled?: HotkeyAction['enabled'],
): HotkeyAction {
  return {
    id,
    label,
    category: 'Harpoon',
    binding: { kind: 'leader', key },
    run,
    ...(detail ? { detail } : {}),
    ...(enabled ? { enabled } : {}),
  }
}

const harpoonClient: BrowserPlugin<HarpoonConfig> = (ctx, config) => {
  const session = ctx.clientSession
  const ui = ctx.clientUi
  const hotkeys = ctx.clientHotkeys
  const threadStatus = new OptionalThreadStatusService(ctx)
  const service = new HarpoonService(session, ui, config)
  ctx.provide('clientHarpoon', service)

  const idle = () => session.snapshot().turn.tag === 'idle'
  hotkeys.registerAction(ctx, leaderAction(
    'harpoon.tag', 'a', 'Tag current chat',
    () => service.toggleCurrentTag(),
    'Add or remove the active chat from this workspace’s slots.',
    () => idle() && Boolean(session.snapshot().threadId),
  ))
  hotkeys.registerAction(ctx, leaderAction(
    'harpoon.open', 'h', 'Open Harpoon',
    () => service.open(),
    'Browse workspace-scoped pinned chats.',
  ))
  for (let index = 0; index < service.snapshot().slots.length; index += 1) {
    const key = String(index + 1)
    hotkeys.registerAction(ctx, {
      id: `harpoon.slot.${key}`,
      label: `Open Harpoon slot ${key}`,
      category: 'Harpoon',
      binding: { kind: 'leader', key },
      run: () => service.openSlot(index),
      enabled: () => idle() && Boolean(service.snapshot().slots[index]?.thread),
    })
  }

  const BoundRoot = () => (
    <HarpoonRoot
      service={service}
      session={session}
      threadStatus={threadStatus}
      overlays={ui.overlays}
    />
  )
  ui.registerRoot(ctx, 'harpoon', BoundRoot)
  ui.registerStyle(ctx, 'harpoon', String(styles))
  return () => {
    threadStatus.dispose()
    service.dispose()
  }
}

harpoonClient.inject = ['clientUi', 'clientSession', 'clientHotkeys']
harpoonClient.provide = 'clientHarpoon'
harpoonClient.resources = { provides: { roots: ['harpoon'] } }

export default harpoonClient
