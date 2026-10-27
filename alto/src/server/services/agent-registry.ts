import type { Context, Plugin } from 'cordis'
import type { PermissionMode } from '../../shared/protocol.js'

export type AgentProviderProtocol = 'codex-app-server' | 'acp' | 'remote'
export type AgentProviderStatus = 'stopped' | 'starting' | 'ready' | 'failed'

export interface AgentProviderCapabilities {
  images: boolean
  resources: boolean
  mcpServers: boolean
  sessionHistory: boolean
  sessionList?: boolean
  sessionModes: boolean
  steering?: boolean
  durableSession?: boolean
  subagents?: boolean
}

export interface AgentProviderSnapshot {
  id: string
  label: string
  agentId?: string
  location?: { id: string; label: string }
  protocol: AgentProviderProtocol
  status: AgentProviderStatus
  capabilities: AgentProviderCapabilities
  activeSessionIds: string[]
  /** Choices available before starting a session; the session validates them on Send. */
  configOptions?: AgentConfigOption[]
  remoteLocation?: string
  version?: string
  error?: string
}

export type AgentMcpServer =
  | {
      type: 'stdio'
      name: string
      command: string
      args?: string[]
      env?: Record<string, string>
    }
  | {
      type: 'http' | 'sse'
      name: string
      url: string
      headers?: Record<string, string>
    }

export interface AgentPromptOptions {
  additionalContext?: Record<string, { kind: 'application' | 'untrusted'; value: string }>
}

export interface AgentSessionOptions extends AgentPromptOptions {
  cwd: string
  permissionMode: PermissionMode
  additionalDirectories?: string[]
  mcpServers?: AgentMcpServer[]
}

export interface AgentSession {
  id: string
  providerId: string
  cwd: string
  workspaceName?: string
  createdAt: string
  configOptions?: AgentConfigOption[]
}

export interface AgentSessionInfo {
  id: string
  cwd: string
  title?: string
  updatedAt?: string
}

export interface AgentSessionPage {
  sessions: AgentSessionInfo[]
  nextCursor?: string
}

export interface AgentConfigOption {
  id: string
  name: string
  category?: string
  currentValue: string
  options: Array<{ value: string; name: string; description?: string }>
}

export interface AgentFileChange {
  path: string
  oldText: string | null
  newText: string
}

export type AgentPromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'resource'; uri: string; name: string; mimeType?: string }

export interface AgentTurn {
  id: string
  providerId: string
  sessionId: string
  startedAt: string
}

export interface AgentPlanEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: 'high' | 'medium' | 'low'
}

interface AgentEventBase {
  providerId: string
  occurredAt: string
}

interface AgentSessionEventBase extends AgentEventBase {
  sessionId: string
}

export type AgentEvent =
  | (AgentSessionEventBase & { type: 'session.replay'; phase: 'started' | 'finished' })
  | (AgentSessionEventBase & { type: 'connection.changed'; state: 'connecting' | 'connected' | 'disconnected' | 'ended'; message?: string })
  | (AgentSessionEventBase & { type: 'message.submitted'; messageId: string; turnId?: string; input: AgentPromptPart[] })
  | (AgentSessionEventBase & { type: 'task.started'; turnId?: string; taskId: string; parentSessionId: string; title: string; prompt: string; canStop: boolean; taskKind: 'subagent' | 'background'; model?: string; effort?: string })
  | (AgentSessionEventBase & { type: 'task.updated'; taskId: string; status?: 'working' | 'waiting' | 'done' | 'failed' | 'stopped'; summary?: string; model?: string; effort?: string })
  | (AgentSessionEventBase & { type: 'config.updated'; configOptions: AgentConfigOption[] })
  | (AgentSessionEventBase & { type: 'usage.updated'; used: number; size: number; cost?: { amount: number; currency: string } })
  | (AgentSessionEventBase & { type: 'commands.updated'; commands: Array<{ name: string; description: string }> })
  | (AgentSessionEventBase & { type: 'input.requested'; requestId: string; message: string; schema: Record<string, unknown> })
  | (AgentSessionEventBase & { type: 'input.resolved'; requestId: string; answer?: { message: string; values: string[] } })
  | (AgentEventBase & {
      type: 'provider.status'
      status: AgentProviderStatus
      error?: string
    })
  | (AgentSessionEventBase & {
      type: 'session.created' | 'session.closed'
      cwd: string
    })
  | (AgentSessionEventBase & {
      type: 'turn.started'
      turnId: string
    })
  | (AgentSessionEventBase & {
      type: 'turn.completed'
      turnId: string
      stopReason: string
    })
  | (AgentSessionEventBase & {
      type: 'turn.failed'
      turnId: string
      message: string
    })
  | (AgentSessionEventBase & {
      type: 'message.delta'
      turnId?: string
      messageId?: string
      role: 'user' | 'agent' | 'thought'
      content: AgentPromptPart
    })
  | (AgentSessionEventBase & {
      type: 'tool.started' | 'tool.updated'
      turnId?: string
      toolCallId: string
      title: string
      content?: string
      files?: AgentFileChange[]
      patches?: Array<{ path: string; diff: string; kind: string }>
      status?: string
      kind?: string
    })
  | (AgentSessionEventBase & {
      type: 'plan.updated'
      turnId?: string
      entries: AgentPlanEntry[]
    })
  | (AgentSessionEventBase & {
      type: 'permission.requested'
      requestId: string
      turnId?: string
      toolCallId: string
      title: string
      options: Array<{
        id: string
        label: string
        kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
      }>
    })
  | (AgentSessionEventBase & {
      type: 'permission.resolved'
      requestId: string
      turnId?: string
      toolCallId: string
      optionId?: string
    })

export type AgentEventListener = (event: AgentEvent) => void

export interface AgentProvider {
  snapshot(): AgentProviderSnapshot
  workspaceName?(cwd: string): Promise<string | undefined>
  createSession(options: AgentSessionOptions): Promise<AgentSession>
  listSessions?(options?: { cwd?: string; cursor?: string }): Promise<AgentSessionPage>
  loadSession?(sessionId: string, options: AgentSessionOptions): Promise<AgentSession>
  resolvePermission?(requestId: string, optionId: string): Promise<void>
  resolveInput?(requestId: string, response: unknown): Promise<void>
  configure?(sessionId: string, configId: string, value: string): Promise<AgentConfigOption[]>
  setPermissionMode?(sessionId: string, mode: PermissionMode): void
  prompt(sessionId: string, input: AgentPromptPart[], options?: AgentPromptOptions): Promise<AgentTurn>
  steer?(sessionId: string, input: AgentPromptPart[], options?: AgentPromptOptions): Promise<'injected' | 'promptRequired'>
  stopTask?(sessionId: string, taskId: string): Promise<void>
  cancel(sessionId: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
  subscribe(listener: AgentEventListener): () => void
  stop(): Promise<void>
}

export interface AgentProviderRegistration {
  dispose(): Promise<void>
}

interface RegisteredProvider {
  owner: string
  provider: AgentProvider
}

function eventChangesSnapshot(event: AgentEvent): boolean {
  return event.type === 'provider.status'
    || event.type === 'session.created'
    || event.type === 'session.closed'
}

export class AgentRegistry {
  private readonly entries = new Map<string, RegisteredProvider>()

  constructor(private readonly root: Context) {}

  register(owner: Context, provider: AgentProvider): AgentProviderRegistration {
    const initial = provider.snapshot()
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(initial.id)) {
      throw new Error(`invalid agent provider id: ${initial.id}`)
    }

    const entry = { owner: owner.fiber.name, provider }
    const dispose = owner.effect(() => {
      if (this.entries.has(initial.id)) {
        throw new Error(`agent provider "${initial.id}" is already registered`)
      }

      const unsubscribe = provider.subscribe((event) => {
        this.root.emit('agents/event', structuredClone(event))
        if (eventChangesSnapshot(event)) this.emitChanged()
      })
      this.entries.set(initial.id, entry)
      this.emitChanged()

      return async () => {
        unsubscribe()
        if (this.entries.get(initial.id) === entry) this.entries.delete(initial.id)
        await provider.stop()
        this.emitChanged()
      }
    }, `agents.register(${JSON.stringify(initial.id)})`)

    return { dispose: async () => dispose() }
  }

  snapshot(): AgentProviderSnapshot[] {
    return [...this.entries.values()]
      .map(({ provider }) => structuredClone(provider.snapshot()))
      .sort((left, right) => left.label.localeCompare(right.label))
  }

  describe(): Array<AgentProviderSnapshot & { owner: string }> {
    return [...this.entries.values()]
      .map(({ owner, provider }) => ({ ...structuredClone(provider.snapshot()), owner }))
      .sort((left, right) => left.label.localeCompare(right.label))
  }

  provider(id: string): AgentProvider {
    const provider = this.entries.get(id)?.provider
    if (!provider) throw new Error(`unknown agent provider: ${id}`)
    return provider
  }

  createSession(providerId: string, options: AgentSessionOptions): Promise<AgentSession> {
    return this.provider(providerId).createSession(options)
  }

  prompt(providerId: string, sessionId: string, input: AgentPromptPart[]): Promise<AgentTurn> {
    return this.provider(providerId).prompt(sessionId, input)
  }

  cancel(providerId: string, sessionId: string): Promise<void> {
    return this.provider(providerId).cancel(sessionId)
  }

  closeSession(providerId: string, sessionId: string): Promise<void> {
    return this.provider(providerId).closeSession(sessionId)
  }

  private emitChanged(): void {
    this.root.emit('agents/changed', this.snapshot())
  }
}

export const agentRegistryPlugin: Plugin = (ctx) => {
  ctx.provide('agents', new AgentRegistry(ctx.root))
}

agentRegistryPlugin.provide = 'agents'

declare module 'cordis' {
  interface Events {
    'agents/changed'(snapshot: AgentProviderSnapshot[]): void
    'agents/event'(event: AgentEvent): void
  }
}
