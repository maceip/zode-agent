import { isAgentChatId, type AgentChat } from './agent-chats-api.js'
import type { Plugin } from 'cordis'
import type { ClientHostService } from '../../src/client/plugin-api.js'
import type {
  HarnessEvent,
  RpcNotification,
} from '../../src/shared/protocol.js'
import { isRecord } from '../../src/shared/protocol.js'
import type {
  ClientConversationService,
} from './session-api.js'
import type {
  ClientThreadStatusService,
  ClientThreadStatusSnapshot,
} from './thread-status-api.js'
import styles from './thread-status.css'

interface ThreadStatusConfig {
  finishedRetentionMs?: number
  visibleFinishedMs?: number
}

interface PersistedThreadStatus {
  version: 1
  finished: Array<[string, number]>
}

const STORAGE_KEY = 'codex-cordis.thread-status'
const DEFAULT_FINISHED_RETENTION_MS = 24 * 60 * 60 * 1_000
const DEFAULT_VISIBLE_FINISHED_MS = 5_000

function duration(value: number | undefined, fallback: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value!)) : fallback
}

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function readFinished(storage: Storage | undefined): Map<string, number> {
  if (!storage) return new Map()
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as Partial<PersistedThreadStatus> | null
    if (value?.version !== 1 || !Array.isArray(value.finished)) return new Map()
    return new Map(value.finished.filter((entry): entry is [string, number] => (
      Array.isArray(entry)
      && typeof entry[0] === 'string'
      && typeof entry[1] === 'number'
      && Number.isFinite(entry[1])
    )))
  } catch {
    return new Map()
  }
}

function notificationThreadId(notification: RpcNotification): string | undefined {
  const params = notification.params
  if (typeof params?.threadId === 'string') return params.threadId
  const thread = isRecord(params?.thread) ? params.thread : undefined
  if (typeof thread?.id === 'string') return thread.id
  const turn = isRecord(params?.turn) ? params.turn : undefined
  return typeof turn?.threadId === 'string' ? turn.threadId : undefined
}

function activeThreadIds(event: HarnessEvent): readonly string[] | undefined {
  if (event.type === 'snapshot') return event.payload.codex.activeThreadIds
  if (event.type === 'codex.status') return event.payload.activeThreadIds
  return undefined
}

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

export class ThreadStatusService implements ClientThreadStatusService {
  private readonly listeners = new Set<() => void>()
  private readonly running = new Set<string>()
  private readonly finished: Map<string, number>
  private readonly storage = browserStorage()
  private readonly retentionMs: number
  private readonly visibleFinishedMs: number
  private readonly disposeSession: () => void
  private readonly disposeEvents: () => void
  private expiryTimer?: number
  private visibleFinishedTimer?: number
  private activeThreadId: string | undefined
  private state: ClientThreadStatusSnapshot
  private disposed = false

  private readonly visibilityChanged = (): void => {
    if (visible() && this.activeThreadId) this.acknowledge(this.activeThreadId)
  }

  constructor(
    private readonly host: ClientHostService,
    private readonly session: ClientConversationService,
    config: ThreadStatusConfig = {},
  ) {
    this.retentionMs = duration(
      config.finishedRetentionMs,
      DEFAULT_FINISHED_RETENTION_MS,
      60_000,
    )
    this.visibleFinishedMs = duration(
      config.visibleFinishedMs,
      DEFAULT_VISIBLE_FINISHED_MS,
      1_000,
    )
    this.finished = readFinished(this.storage)
    this.activeThreadId = session.snapshot().threadId

    const current = host.snapshot().snapshot?.codex.activeThreadIds ?? []
    for (const threadId of current) this.running.add(threadId)
    for (const event of host.journal()) this.replay(event)
    this.pruneFinished()
    if (this.activeThreadId && visible()) this.finished.delete(this.activeThreadId)
    this.persistFinished()
    this.state = this.buildSnapshot(0)

    this.disposeSession = session.subscribe(() => this.syncSession())
    this.disposeEvents = host.onEvent((event) => this.receive(event))
    window.addEventListener('focus', this.visibilityChanged)
    document.addEventListener('visibilitychange', this.visibilityChanged)
    this.scheduleExpiry()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientThreadStatusSnapshot => this.state

  acknowledge(threadId: string): void {
    if (!this.finished.delete(threadId)) return
    this.persistFinished()
    this.emit()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeSession()
    this.disposeEvents()
    window.removeEventListener('focus', this.visibilityChanged)
    document.removeEventListener('visibilitychange', this.visibilityChanged)
    if (this.expiryTimer !== undefined) window.clearTimeout(this.expiryTimer)
    if (this.visibleFinishedTimer !== undefined) window.clearTimeout(this.visibleFinishedTimer)
    this.listeners.clear()
  }

  private replay(event: HarnessEvent): void {
    const active = activeThreadIds(event)
    if (active) {
      this.running.clear()
      for (const threadId of active) this.running.add(threadId)
      return
    }
    if (event.type !== 'codex.notification') return
    const threadId = notificationThreadId(event.payload)
    if (!threadId) return
    if (event.payload.method === 'turn/started') this.running.add(threadId)
    if (event.payload.method === 'turn/completed') this.running.delete(threadId)
  }

  private receive(event: HarnessEvent): void {
    const active = event.type === 'extensions.updated' ? this.host.snapshot().snapshot?.codex.activeThreadIds ?? [] : activeThreadIds(event)
    if (active) {
      const agentIds = Object.values(this.host.snapshot().snapshot?.extensions ?? {}).flatMap((value) => {
        const chat = value as unknown as AgentChat | undefined
        return chat?.summary && isAgentChatId(chat.summary.id) && chat.turn !== 'idle' ? [chat.summary.id] : []
      })
      const next = new Set([...active, ...agentIds])
      const completed = [...this.running].filter((threadId) => !next.has(threadId))
      if (
        next.size === this.running.size
        && [...next].every((threadId) => this.running.has(threadId))
      ) return
      this.running.clear()
      for (const threadId of completed) this.finished.set(threadId, Date.now())
      for (const threadId of next) {
        this.running.add(threadId)
        this.finished.delete(threadId)
      }
      this.persistFinished()
      this.emit()
      if (completed.length) this.scheduleExpiry()
      for (const threadId of completed) this.scheduleVisibleAcknowledgement(threadId)
      return
    }
    if (event.type !== 'codex.notification') return
    const threadId = notificationThreadId(event.payload)
      ?? this.session.snapshot().threadId
    if (!threadId) return
    if (event.payload.method === 'turn/started') {
      const changed = !this.running.has(threadId) || this.finished.has(threadId)
      this.running.add(threadId)
      this.finished.delete(threadId)
      if (!changed) return
      this.persistFinished()
      this.emit()
      return
    }
    if (event.payload.method !== 'turn/completed') return
    this.running.delete(threadId)
    this.finished.set(threadId, Date.now())
    this.persistFinished()
    this.emit()
    this.scheduleExpiry()
    this.scheduleVisibleAcknowledgement(threadId)
  }

  private scheduleVisibleAcknowledgement(threadId: string): void {
    if (threadId !== this.activeThreadId || !visible()) return
    if (this.visibleFinishedTimer !== undefined) window.clearTimeout(this.visibleFinishedTimer)
    this.visibleFinishedTimer = window.setTimeout(() => {
      delete this.visibleFinishedTimer
      if (threadId === this.activeThreadId && visible()) this.acknowledge(threadId)
    }, this.visibleFinishedMs)
  }

  private syncSession(): void {
    const nextThreadId = this.session.snapshot().threadId
    if (nextThreadId === this.activeThreadId) return
    this.activeThreadId = nextThreadId
    if (nextThreadId && visible()) this.acknowledge(nextThreadId)
  }

  private pruneFinished(): void {
    const cutoff = Date.now() - this.retentionMs
    for (const [threadId, finishedAt] of this.finished) {
      if (finishedAt < cutoff) this.finished.delete(threadId)
    }
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) window.clearTimeout(this.expiryTimer)
    const oldest = Math.min(...this.finished.values())
    if (!Number.isFinite(oldest)) {
      delete this.expiryTimer
      return
    }
    const delay = Math.max(1, Math.min(2_147_483_647, oldest + this.retentionMs - Date.now()))
    this.expiryTimer = window.setTimeout(() => {
      delete this.expiryTimer
      const before = this.finished.size
      this.pruneFinished()
      if (this.finished.size !== before) {
        this.persistFinished()
        this.emit()
      }
      this.scheduleExpiry()
    }, delay)
  }

  private persistFinished(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        finished: [...this.finished],
      } satisfies PersistedThreadStatus))
    } catch {
      // Completion indicators remain available for this session when storage is unavailable.
    }
  }

  private buildSnapshot(revision: number): ClientThreadStatusSnapshot {
    return {
      revision,
      running: [...this.running].sort(),
      finished: [...this.finished].sort(([leftId, leftTime], [rightId, rightTime]) => (
        rightTime - leftTime || leftId.localeCompare(rightId)
      )).map(([id]) => id),
    }
  }

  private emit(): void {
    if (this.disposed) return
    this.state = this.buildSnapshot(this.state.revision + 1)
    for (const listener of this.listeners) listener()
  }
}

const threadStatusClient: Plugin<ThreadStatusConfig> = (ctx, config) => {
  const service = new ThreadStatusService(ctx.clientHost, ctx.clientConversation, config)
  ctx.provide('clientThreadStatus', service)
  ctx.clientUi.registerStyle(ctx, 'thread-status', String(styles))
  return () => service.dispose()
}

threadStatusClient.inject = ['clientHost', 'clientConversation', 'clientUi']
threadStatusClient.provide = 'clientThreadStatus'

export default threadStatusClient
