import type { ThreadHistoryPage } from '../../src/shared/protocol.js'

// A short-lived, bounded read cache. Conversation history remains owned by
// Codex; this cache neither writes rollouts nor creates a second task database.
export class AgentHistoryCache {
  private pages = new Map<string, { expires: number; value: Promise<ThreadHistoryPage> }>()
  constructor(private now = Date.now) {}
  get(threadId: string, cursor: string | undefined, read: () => Promise<ThreadHistoryPage>): Promise<ThreadHistoryPage> {
    const key = JSON.stringify([threadId, cursor ?? ''])
    const previous = this.pages.get(key)
    if (previous && previous.expires > this.now()) return previous.value
    const value = read().catch((error) => {
      if (this.pages.get(key)?.value === value) this.pages.delete(key)
      throw error
    })
    this.pages.delete(key)
    this.pages.set(key, { expires: this.now() + 3000, value })
    while (this.pages.size > 32) this.pages.delete(this.pages.keys().next().value!)
    return value
  }
  invalidate(threadId: string): void {
    for (const key of this.pages.keys()) if (JSON.parse(key)[0] === threadId) this.pages.delete(key)
  }
  clear(): void { this.pages.clear() }
}
