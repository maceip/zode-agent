import type { ThreadSummary } from '../../src/shared/protocol.js'

export interface ClientRecentChatsSnapshot {
  revision: number
  recent: readonly ThreadSummary[]
  selectedThreadId?: string
}

export interface ClientRecentChatsService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientRecentChatsSnapshot
  cycle(direction: 1 | -1): void
  select(threadId: string): void
  commit(): void
  cancel(): void
  openThread(threadId: string): void
}

declare module 'cordis' {
  interface Context {
    clientRecentChats: ClientRecentChatsService
  }
}
