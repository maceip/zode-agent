import type { ClientDraft } from '../../src/client/plugin-api.js'
import type { AgentPromptPart } from '../../src/server/services/agent-registry.js'
import type { AgentConfigOption, AgentPlanEntry, AgentProviderSnapshot } from '../../src/server/services/agent-registry.js'
import type { PendingServerRequest, PermissionMode, ThreadSummary } from '../../src/shared/protocol.js'
import type { AgentTask } from './orchestrator-api.js'
import type { ActivityItem } from './ui/transcript.js'
import type { RemoteWorkspace } from './remote-workspace-api.js'

export const AGENT_CHATS_STATE = 'agent-chats'
export const agentChatStateKey = (id: string): string => `agent-chats.${id}`
export const isAgentChatId = (id: string): boolean => /^acp-[a-f0-9-]{36}$/.test(id)

export interface AgentChat {
  summary: ThreadSummary & { providerId: string; providerSessionId: string }
  permissionMode: PermissionMode
  remote?: { workspaceName?: string; workspace?: RemoteWorkspace; state: 'connecting' | 'connected' | 'disconnected' | 'ended'; message?: string; replaying?: boolean }
  historyLoaded?: boolean
  replaying?: boolean
  turn: 'idle' | 'sending' | 'running'
  turnPermissionMode?: PermissionMode
  children?: Array<{ task: AgentTask; sessionId: string; kind: 'subagent' | 'background'; activities: ActivityItem[] }>
  turnId?: string
  turnStartedAt?: number
  configurationRevision?: number
  activities: ActivityItem[]
  requests: PendingServerRequest[]
  queue?: Array<{ id: string; draft: ClientDraft; error?: string }>
  queuePaused?: boolean
  configOptions?: AgentConfigOption[]
  plan?: AgentPlanEntry[]
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } }
  commands?: Array<{ name: string; description: string }>
  problem?: string
}

export interface AgentChatCatalog {
  providers: AgentProviderSnapshot[]
  threads: ThreadSummary[]
  historyErrors?: string[]
}

export function agentPromptInput(draft: ClientDraft): AgentPromptPart[] {
  const input: AgentPromptPart[] = []
  if (draft.text.trim()) input.push({ type: 'text', text: draft.text.trim() })
  for (const image of draft.images) {
    const match = /^data:([^;,]+);base64,(.+)$/.exec(image.url)
    if (!match?.[1] || !match[2]) throw new Error('This agent needs an uploaded image')
    input.push({ type: 'image', mimeType: match[1], data: match[2] })
  }
  for (const attachment of draft.attachments) {
    input.push({ type: 'resource', name: attachment.name, uri: `file://${attachment.path.split('/').map(encodeURIComponent).join('/')}` })
  }
  for (const skill of draft.skills) input.push({ type: 'text', text: `Use the ${skill.name} skill at ${skill.path}.` })
  return input
}
