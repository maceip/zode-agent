import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { z } from 'zod'
import path from 'node:path'
import { SEARCH_PREVIEW, searchSurface } from './search-api.js'
import { latestSearchPreview } from './search-preview.js'
import { AgentChatStore } from './agent-chat-store.js'
import { agentChatStateKey, isAgentChatId, type AgentChat } from './agent-chats-api.js'

const searchPlugin: HarnessPlugin = (ctx) => {
  ctx.ui.registerSurface(ctx, searchSurface)
  const store = new AgentChatStore(path.join(ctx.program.projectRoot, '.codex-cordis', 'agent-chats'), () => {})
  ctx.clientExtensions.registerMethod(ctx, SEARCH_PREVIEW, async (payload) => {
    const { threadId } = z.object({ threadId: z.string().min(1).max(200) }).parse(payload)
    if (isAgentChatId(threadId)) {
      // Reading a preview must not resume an ACP provider or reconnect a remote chat.
      const live = ctx.clientExtensions.snapshot()[agentChatStateKey(threadId)] as unknown as AgentChat | undefined
      const chat = live ?? await store.read(threadId)
      return { preview: latestSearchPreview(chat.activities) }
    }
    const page = await ctx.codex.listThreadTurns(threadId, undefined, 2)
    return { preview: latestSearchPreview(page.messages.map((message) => ({
      kind: message.role, content: message.text,
      ...(message.images ? { images: message.images } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
      ...(message.questions ? { questions: message.questions } : {}),
    }))) }
  })
}

searchPlugin.inject = ['ui', 'clientExtensions', 'codex', 'program']

export default searchPlugin
