import path from 'node:path'
import type { HarnessPlugin, TurnDraft } from '../../src/server/plugin-api.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import { isAgentChatId } from './agent-chats-api.js'
import { requireAgentChats } from './agent-chats-access.js'
import { CONVERSATION_RENAME, CONVERSATION_TITLES_STATE } from './conversation-titles-api.js'
import { ConversationTitles } from './conversation-titles-model.js'

export const conversationTitleGuidance = `Maintain a concise title for this conversation using the Cordis conversation/set_title tool. Before your first substantive response, set a specific 3–7 word title describing the user's task. Update it when the user changes the main topic; keep it stable for ordinary follow-ups and status updates. Use sentence case, at most 80 characters, without quotes or an ending period. This tool only names the current conversation and preserves manually chosen names. If it reports updated: false, leave the title alone. Do not mention title maintenance in your response.`

interface NamingTransport {
  request?<T>(method: string, params: unknown): Promise<T>
  client?: { request<T>(method: string, params: unknown): Promise<T> }
}

const plugin: HarnessPlugin = async (ctx) => {
  let active = true
  const codex = ctx.codex as unknown as NamingTransport
  // Older desktop hosts expose the transport directly; current hosts start it
  // lazily through request(). ACP naming never starts Codex.
  const request = <T>(method: string, params: unknown): Promise<T> => {
    if (codex.request) return codex.request<T>(method, params)
    if (codex.client) return codex.client.request<T>(method, params)
    throw new Error('Conversation naming is unavailable')
  }
  const state = ctx.clientExtensions.registerState(ctx, CONVERSATION_TITLES_STATE, {})
  const write = async (id: string, title: string): Promise<void> => {
    if (isAgentChatId(id)) await requireAgentChats(ctx).rename(id, title)
    else await request('thread/name/set', { threadId: id, name: title })
  }
  const titles = new ConversationTitles(
    path.join(ctx.program.projectRoot, '.codex-cordis', 'conversation-titles.json'),
    async (id) => {
      if (isAgentChatId(id)) {
        const chat = await requireAgentChats(ctx).open(id)
        const first = chat.activities.find((activity) => activity.kind === 'user')?.content
        return { title: chat.summary.title, ...(first ? { initialTitle: first.slice(0, 100) } : {}) }
      }
      // Read authoritative metadata instead of a possibly stale history cache.
      const result = await request<{ thread?: { name?: string } }>('thread/read', { threadId: id, includeTurns: false })
      if (!result.thread) throw new Error('Conversation was not found')
      return { title: result.thread.name ?? 'Untitled conversation' }
    },
    write,
    (snapshot) => state.update(snapshot as unknown as JsonValue),
  )
  ctx.effect(() => () => { active = false; return titles.dispose() }, 'conversationTitles.lifetime')
  await titles.load()
  if (!active) return
  ctx.on('conversation/rename', (id, title, next) => titles.manual(id, title, next))
  ctx.clientExtensions.registerMethod(ctx, CONVERSATION_RENAME, async (payload) => {
    if (!isRecord(payload) || typeof payload.id !== 'string' || !payload.id || typeof payload.title !== 'string' || !payload.title.trim()) {
      throw new Error('A conversation and title are required')
    }
    await titles.manual(payload.id, payload.title.trim().slice(0, 200))
    return { ok: true }
  })
  ctx.tools.register(ctx, {
    namespace: 'conversation', name: 'set_title',
    description: 'Set or update a short descriptive title for the invoking conversation. Preserves manually chosen names. Use on the first response and when the main topic changes.',
    inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['title'], additionalProperties: false },
  }, (call) => {
    if (!isRecord(call.arguments) || typeof call.arguments.title !== 'string' || !call.threadId) throw new Error('A title and invoking conversation are required')
    return titles.generate(call.threadId, call.arguments.title)
  })
  ctx.on('codex/turn/prepare', async (_draft: TurnDraft, next) => {
    const prepared = await next()
    return { ...prepared, additionalContext: { ...prepared.additionalContext, conversation_title: { kind: 'application' as const, value: conversationTitleGuidance } } }
  })
}

plugin.inject = ['clientExtensions', 'codex', 'program', 'tools', 'turnProgram']
export default plugin
