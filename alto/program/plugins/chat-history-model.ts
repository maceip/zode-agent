import { errorMessage, threadRecencyAt, type ThreadSummary } from '../../src/shared/protocol.js'
import type { ChatHistoryPage } from './chat-history-api.js'

export function mergeChatHistory(current: readonly ThreadSummary[], incoming: readonly ThreadSummary[]): ThreadSummary[] {
  const threads = new Map(current.map((thread) => [thread.id, thread]))
  for (const thread of incoming) {
    const previous = threads.get(thread.id)
    if (!previous || threadRecencyAt(thread) >= threadRecencyAt(previous)) threads.set(thread.id, thread)
  }
  return [...threads.values()].sort((a, b) => threadRecencyAt(b) - threadRecencyAt(a) || a.id.localeCompare(b.id))
}

export interface ChatHistoryDay {
  key: string
  label: string
  threads: ThreadSummary[]
}

export function groupChatHistory(threads: readonly ThreadSummary[], now = new Date()): ChatHistoryDay[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const groups = new Map<string, ChatHistoryDay>()
  for (const thread of threads) {
    const timestamp = threadRecencyAt(thread)
    const date = new Date(timestamp * 1000)
    const valid = timestamp > 0 && Number.isFinite(date.getTime())
    const day = valid ? new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() : 0
    const key = valid ? String(day) : 'unknown'
    const label = !valid ? 'Earlier'
      : day === today.getTime() ? 'Today'
      : day === yesterday.getTime() ? 'Yesterday'
      : date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}) })
    let group = groups.get(key)
    if (!group) { group = { key, label, threads: [] }; groups.set(key, group) }
    group.threads.push(thread)
  }
  return [...groups.values()]
}

export interface ChatHistorySnapshot {
  threads: ThreadSummary[]
  loaded: boolean
  loading: boolean
  nextCursor: string | null
  error: string
  warnings: string[]
}

/** Cached for the lifetime of the plugin, not the pane. Reopening keeps the loaded pages. */
export class ChatHistoryStore {
  private state: ChatHistorySnapshot = { threads: [], loaded: false, loading: false, nextCursor: null, error: '', warnings: [] }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private disposed = false
  private retryRefresh = false
  private readonly cursors = new Set<string>()

  constructor(private readonly read: (cursor?: string) => Promise<ChatHistoryPage>) {}
  snapshot = (): ChatHistorySnapshot => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private update(patch: Partial<ChatHistorySnapshot>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  load = async (refresh = false): Promise<void> => {
    if (this.disposed || (!refresh && (this.state.loading || (this.state.loaded && !this.state.nextCursor)))) return
    this.retryRefresh = refresh
    const generation = ++this.generation
    const cursor = refresh ? undefined : this.state.nextCursor ?? undefined
    this.update({ loading: true, error: '' })
    try {
      const page = await this.read(cursor)
      if (this.disposed || generation !== this.generation) return
      if (page.nextCursor && (page.nextCursor === cursor || (!refresh && this.cursors.has(page.nextCursor)))) {
        throw new Error('The chat service repeated a history page. Try Refresh.')
      }
      if (refresh) this.cursors.clear()
      if (cursor) this.cursors.add(cursor)
      this.update({
        threads: mergeChatHistory(refresh ? [] : this.state.threads, page.threads),
        nextCursor: page.nextCursor,
        warnings: page.warnings ?? (refresh ? [] : this.state.warnings),
        loaded: true,
        loading: false,
      })
    } catch (failure) {
      if (!this.disposed && generation === this.generation) this.update({ loading: false, error: errorMessage(failure) })
    }
  }
  retry = (): Promise<void> => this.load(this.retryRefresh)
  dispose(): void {
    this.disposed = true
    this.generation++
    this.listeners.clear()
  }
}
