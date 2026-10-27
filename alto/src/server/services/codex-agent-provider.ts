import { fileURLToPath } from 'node:url'
import type { Context, Plugin } from 'cordis'
import { isRecord, type RpcNotification, type TurnInput } from '../../shared/protocol.js'
import type {
  AgentEvent,
  AgentEventListener,
  AgentPromptPart,
  AgentProvider,
  AgentProviderSnapshot,
  AgentSession,
  AgentSessionOptions,
  AgentTurn,
} from './agent-registry.js'
import type { CodexService } from './codex-service.js'

interface CodexAgentSession extends AgentSession {
  options: AgentSessionOptions
}

function stringAt(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined
}

function promptInput(part: AgentPromptPart): TurnInput {
  if (part.type === 'text') return { type: 'text', text: part.text }
  if (part.type === 'image') {
    return {
      type: 'image',
      url: `data:${part.mimeType};base64,${part.data}`,
    }
  }

  if (part.uri.startsWith('file:')) {
    return {
      type: 'mention',
      name: part.name,
      path: fileURLToPath(part.uri),
    }
  }
  return { type: 'text', text: `[${part.name}](${part.uri})` }
}

function toolTitle(item: Record<string, unknown>): string {
  return stringAt(item, 'title')
    ?? stringAt(item, 'command')
    ?? stringAt(item, 'tool')
    ?? 'Tool call'
}

/**
 * Makes the native Codex service visible through the provider contract without
 * putting the existing Codex gateway or UI path behind that new abstraction.
 * The adapter can be exercised by new plugins while current chats continue to
 * call CodexService directly.
 */
export class CodexAgentProvider implements AgentProvider {
  private readonly sessions = new Map<string, CodexAgentSession>()
  private readonly activeTurns = new Map<string, string>()
  private readonly listeners = new Set<AgentEventListener>()

  constructor(private readonly codex: CodexService) {}

  snapshot(): AgentProviderSnapshot {
    const snapshot = this.codex.snapshot()
    return {
      id: 'codex',
      label: 'Codex',
      protocol: 'codex-app-server',
      status: snapshot.status,
      capabilities: {
        images: true,
        resources: true,
        mcpServers: false,
        sessionHistory: true,
        sessionModes: false,
      },
      activeSessionIds: [...this.sessions.keys()],
      ...(snapshot.version ? { version: snapshot.version } : {}),
      ...(snapshot.error ? { error: snapshot.error } : {}),
    }
  }

  async createSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.additionalDirectories?.length || options.mcpServers?.length) {
      throw new Error('the native Codex provider does not accept ACP session roots or MCP servers')
    }
    const response = await this.codex.startThread({
      workspace: options.cwd,
      permissionMode: options.permissionMode,
    })
    const sessionId = response.thread?.id
    if (!sessionId) throw new Error('Codex created a provider session without an id')
    const session: CodexAgentSession = {
      id: sessionId,
      providerId: 'codex',
      cwd: options.cwd,
      createdAt: new Date().toISOString(),
      options: structuredClone(options),
    }
    this.sessions.set(session.id, session)
    this.emit({
      type: 'session.created',
      providerId: 'codex',
      sessionId: session.id,
      cwd: session.cwd,
      occurredAt: session.createdAt,
    })
    return structuredClone(session)
  }

  async prompt(sessionId: string, input: AgentPromptPart[]): Promise<AgentTurn> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`unknown Codex agent session: ${sessionId}`)
    const response = await this.codex.startTurn(
      sessionId,
      input.map(promptInput),
      { workspace: session.cwd, permissionMode: session.options.permissionMode },
    )
    const turnId = response.turn?.id
    if (!turnId) throw new Error('Codex accepted the prompt without returning a turn id')
    const turn: AgentTurn = {
      id: turnId,
      providerId: 'codex',
      sessionId,
      startedAt: new Date().toISOString(),
    }
    this.activeTurns.set(sessionId, turnId)
    this.emit({
      type: 'turn.started',
      providerId: 'codex',
      sessionId,
      turnId,
      occurredAt: turn.startedAt,
    })
    return turn
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) throw new Error(`unknown Codex agent session: ${sessionId}`)
    await this.codex.interrupt(sessionId)
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (this.activeTurns.has(sessionId)) await this.codex.interrupt(sessionId)
    this.activeTurns.delete(sessionId)
    this.sessions.delete(sessionId)
    this.emit({
      type: 'session.closed',
      providerId: 'codex',
      sessionId,
      cwd: session.cwd,
      occurredAt: new Date().toISOString(),
    })
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async stop(): Promise<void> {
    this.activeTurns.clear()
    this.sessions.clear()
  }

  publishStatus(): void {
    const snapshot = this.snapshot()
    this.emit({
      type: 'provider.status',
      providerId: 'codex',
      status: snapshot.status,
      ...(snapshot.error ? { error: snapshot.error } : {}),
      occurredAt: new Date().toISOString(),
    })
  }

  acceptNotification(notification: RpcNotification): void {
    const params = notification.params ?? {}
    const sessionId = typeof params.threadId === 'string' ? params.threadId : undefined
    if (!sessionId || !this.sessions.has(sessionId)) return
    const turnId = this.activeTurns.get(sessionId)
    const occurredAt = new Date().toISOString()

    if (notification.method === 'item/agentMessage/delta') {
      this.emit({
        type: 'message.delta',
        providerId: 'codex',
        sessionId,
        ...(turnId ? { turnId } : {}),
        ...(typeof params.itemId === 'string' ? { messageId: params.itemId } : {}),
        role: 'agent',
        content: { type: 'text', text: typeof params.delta === 'string' ? params.delta : '' },
        occurredAt,
      })
      return
    }

    if (notification.method === 'item/reasoning/summaryTextDelta') {
      this.emit({
        type: 'message.delta',
        providerId: 'codex',
        sessionId,
        ...(turnId ? { turnId } : {}),
        ...(typeof params.itemId === 'string' ? { messageId: params.itemId } : {}),
        role: 'thought',
        content: { type: 'text', text: typeof params.delta === 'string' ? params.delta : '' },
        occurredAt,
      })
      return
    }

    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      const item = isRecord(params.item) ? params.item : undefined
      const itemType = stringAt(item, 'type')
      if (!item || !itemType || itemType === 'agentMessage' || itemType === 'reasoning') return
      this.emit({
        type: notification.method === 'item/started' ? 'tool.started' : 'tool.updated',
        providerId: 'codex',
        sessionId,
        ...(turnId ? { turnId } : {}),
        toolCallId: stringAt(item, 'id') ?? `${itemType}:${occurredAt}`,
        title: toolTitle(item),
        status: notification.method === 'item/started' ? 'in_progress' : 'completed',
        kind: itemType,
        occurredAt,
      })
      return
    }

    if (notification.method !== 'turn/completed') return
    const completedTurn = isRecord(params.turn) ? params.turn : undefined
    const completedTurnId = typeof params.turnId === 'string'
      ? params.turnId
      : stringAt(completedTurn, 'id') ?? turnId
    if (!completedTurnId) return
    const status = stringAt(completedTurn, 'status') ?? ''
    this.activeTurns.delete(sessionId)
    this.emit({
      type: 'turn.completed',
      providerId: 'codex',
      sessionId,
      turnId: completedTurnId,
      stopReason: status.includes('interrupt') || status.includes('cancel') ? 'cancelled' : 'end_turn',
      occurredAt,
    })
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event))
  }
}

export const codexAgentProviderPlugin: Plugin = (ctx: Context) => {
  const provider = new CodexAgentProvider(ctx.codex)
  ctx.agents.register(ctx, provider)
  const statusListener = () => provider.publishStatus()
  ctx.codex.on('status', statusListener)
  ctx.on('codex/notification', (notification) => provider.acceptNotification(notification))

  return async () => {
    ctx.codex.off('status', statusListener)
  }
}

codexAgentProviderPlugin.inject = ['agents', 'codex']
