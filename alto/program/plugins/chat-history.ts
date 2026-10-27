import { z } from 'zod'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { readThreadSummary } from '../../src/server/services/thread-view.js'
import { errorMessage, isRecord, type JsonValue, type ThreadSummary } from '../../src/shared/protocol.js'
import { CHAT_HISTORY_LIST, CHAT_HISTORY_PAGE_SIZE, type ChatHistoryPage } from './chat-history-api.js'

interface HistoryRuntime {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
}

export async function readChatHistoryPage(
  runtime: HistoryRuntime,
  classify: (threads: ThreadSummary[]) => Promise<ThreadSummary[]>,
  cursor?: string,
): Promise<ChatHistoryPage> {
  const response = await runtime.request('thread/list', {
    ...(cursor ? { cursor } : {}),
    limit: CHAT_HISTORY_PAGE_SIZE,
    sortKey: 'recency_at',
    sortDirection: 'desc',
    sourceKinds: ['cli', 'vscode', 'appServer'],
  })
  if (!isRecord(response) || !Array.isArray(response.data)) {
    throw new Error('The chat service returned an invalid history page.')
  }
  const nextCursor = typeof response.nextCursor === 'string' && response.nextCursor
    ? response.nextCursor : null
  if (nextCursor && nextCursor === cursor) throw new Error('The chat service repeated a history page. Try Refresh.')
  const threads = response.data.flatMap((value) => {
    const thread = readThreadSummary(value)
    return thread ? [thread] : []
  })
  return { threads: await classify(threads), nextCursor }
}

const chatHistory: HarnessPlugin = (ctx) => {
  // The standard listThreads method gathers the first N entries each time.
  // Keep the native cursor here so scrolling only fetches the next page.
  const access = ctx.codex as unknown as { client?: HistoryRuntime }
  let active = true
  ctx.effect(() => () => { active = false }, 'chat-history.lifetime')
  ctx.clientExtensions.registerMethod(ctx, CHAT_HISTORY_LIST, async (payload) => {
    const { cursor } = z.object({ cursor: z.string().min(1).max(8192).optional() }).parse(payload ?? {})
    if (!active) throw new Error('Chat history is unavailable.')
    if (!cursor) await ctx.agentChats.refreshHistory()
    let page: ChatHistoryPage
    try {
      if (!access.client) throw new Error('Codex history is unavailable.')
      await ctx.codex.start()
      page = await readChatHistoryPage(access.client, async (threads) => {
        if (!active) throw new Error('Chat history was closed.')
        return ctx.projects.classifyThreads(threads)
      }, cursor)
    } catch (error) {
      if (cursor) throw error
      page = { threads: [], nextCursor: null, warnings: [`Codex history: ${errorMessage(error)}`] }
    }
    if (!active) throw new Error('Chat history was closed.')
    if (!cursor) {
      page.threads = await ctx.projects.classifyThreads([...page.threads, ...ctx.agentChats.threads()])
      page.warnings = [...(page.warnings ?? []), ...ctx.agentChats.historyErrors()]
    }
    return page as unknown as JsonValue
  })
}
chatHistory.inject = ['codex', 'projects', 'clientExtensions', 'agentChats']
export default chatHistory
