import type { ThreadSessionSettings, ThreadSummary } from '../../src/shared/protocol.js'
import type { ActivityItem } from './ui/activity.js'

export interface CachedThreadActivities {
  summary: ThreadSummary
  activities: ActivityItem[]
  olderCursor?: string
  session?: ThreadSessionSettings
  resumed: boolean
}

export function cachedThreadIsFresh(
  cached: CachedThreadActivities,
  thread: ThreadSummary,
): boolean {
  return cached.summary.updatedAt >= thread.updatedAt
}

export class ThreadActivityCache {
  private readonly entries = new Map<string, CachedThreadActivities>()
  readonly limit: number

  constructor(limit = 12) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  get(threadId: string): CachedThreadActivities | undefined {
    const entry = this.entries.get(threadId)
    if (!entry) return undefined
    this.entries.delete(threadId)
    this.entries.set(threadId, entry)
    return entry
  }

  put(entry: CachedThreadActivities): void {
    this.entries.delete(entry.summary.id)
    this.entries.set(entry.summary.id, entry)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest !== 'string') break
      this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}
