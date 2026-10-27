import type { ThreadSummary } from '../../src/shared/protocol.js'

export const CHAT_HISTORY_LIST = 'chat-history.list'
export const CHAT_HISTORY_PAGE_SIZE = 80

export interface ChatHistoryPage {
  threads: ThreadSummary[]
  warnings?: string[]
  nextCursor: string | null
}
