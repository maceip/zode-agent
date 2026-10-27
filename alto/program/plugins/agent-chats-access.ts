import type { Context } from 'cordis'
import type { AgentChats } from './agent-chats.js'

// Core tools only require ACP chats when handling an ACP conversation. Looking
// up the current service also avoids retaining a disposed fiber after reload.
export function requireAgentChats(ctx: Context): AgentChats {
  const chats = ctx.get('agentChats', false) as AgentChats | undefined
  if (!chats) throw new Error('ACP chats is unavailable. Enable the Agent Chats plugin to use this conversation.')
  return chats
}
