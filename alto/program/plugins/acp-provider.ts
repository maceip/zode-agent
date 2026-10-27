import { claudeSystemContext, claudeContextMeta, contextUpdates, type AgentContext } from './acp-context.js'
import { promptBlock, updateContent, configOptions, toolFiles, toolContent } from './acp-format.js'
import { initialAgentConfig } from './agent-model-options.js'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { CHILD_UPDATE, childCapabilities, childNotification, supportsChildren, withChildUpdates, type ChildNotification } from './acp-extensions.js'
import type { Context } from 'cordis'
import type {
  AgentEvent,
  AgentEventListener,
  AgentMcpServer,
  AgentPromptPart,
  AgentProvider,
  AgentProviderCapabilities,
  AgentProviderSnapshot,
  AgentSession,
  AgentSessionOptions,
  AgentTurn,
  HarnessPlugin,
} from '../../src/server/plugin-api.js'
import type { AgentConfigOption, AgentPromptOptions, AgentSessionPage } from '../../src/server/services/agent-registry.js'
import {
  isRecord,
  errorMessage,
  type PermissionMode,
} from '../../src/shared/protocol.js'

export interface AcpOpenedConnection {
  connection: acp.ClientConnection
  close(): void | Promise<void>
}

export type AcpConnectionFactory = (
  app: acp.ClientApp,
) => AcpOpenedConnection | Promise<AcpOpenedConnection>

export interface AcpProcessProviderOptions {
  id: string
  label: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  setupHint?: string
  clientVersion?: string
  openConnection?: AcpConnectionFactory
}

interface AcpSessionRecord extends AgentSession {
  options: AgentSessionOptions
  context: AgentContext
}

interface AcpProviderConfig {
  id?: string
  label?: string
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  setupHint?: string
}

function now(): string {
  return new Date().toISOString()
}

function toolKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`
}

function headers(values: Record<string, string> | undefined): acp.HttpHeader[] {
  return Object.entries(values ?? {}).map(([name, value]) => ({ name, value }))
}

function environment(values: Record<string, string> | undefined): acp.EnvVariable[] {
  return Object.entries(values ?? {}).map(([name, value]) => ({ name, value }))
}

function mcpServer(server: AgentMcpServer): acp.McpServer {
  if (server.type === 'stdio') {
    return {
      name: server.name,
      command: server.command,
      args: server.args ?? [],
      env: environment(server.env),
    }
  }
  return {
    type: server.type,
    name: server.name,
    url: server.url,
    headers: headers(server.headers),
  }
}

function spawnConnection(
  options: AcpProcessProviderOptions,
  app: acp.ClientApp,
  onStderr: (text: string) => void,
): AcpOpenedConnection {
  const child: ChildProcessWithoutNullStreams = spawn(options.command, options.args ?? [], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => onStderr(chunk))

  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  const connection = app.connect(withChildUpdates(acp.ndJsonStream(writable, readable)))
  child.once('error', (error) => {
    onStderr(errorMessage(error))
    connection.close(error)
  })
  return {
    connection,
    close: () => {
      connection.close()
      if (!child.killed) child.kill('SIGTERM')
    },
  }
}

/**
 * Stable ACP v1 transport for one agent executable. The process is started on
 * the first session rather than when the plugin is loaded, so a missing
 * optional adapter does not affect Alto's native Codex startup path.
 */
export class AcpProcessProvider implements AgentProvider {
  private status: AgentProviderSnapshot['status'] = 'stopped'
  private error: string | undefined
  private version: string | undefined
  private capabilities: AgentProviderCapabilities = {
    images: false,
    resources: true,
    mcpServers: false,
    sessionHistory: false,
    sessionModes: false,
  }
  private sessions = new Map<string, AcpSessionRecord>()
  private readonly replayUpdates = new Map<string, acp.SessionNotification[]>()
  private children = new Map<string, { root: string; parent: string; canStop: boolean; kind: 'subagent' | 'background'; terminal: boolean; permissionMode: PermissionMode; turnId?: string }>()
  private activeTurns = new Map<string, string>()
  private completions = new Map<string, Promise<void>>()
  private toolTitles = new Map<string, string>()
  private listeners = new Set<AgentEventListener>()
  private opened: AcpOpenedConnection | undefined
  private startPromise: Promise<void> | undefined
  private stopping = false
  private lifecycle = 0
  private stderrTail = ''
  private pendingPermissions = new Map<string, {
    sessionId: string
    toolCallId: string
    options: acp.PermissionOption[]
    resolve: (response: acp.RequestPermissionResponse) => void
  }>()

  private pendingInputs = new Map<string, {
    sessionId: string
    schema: Record<string, unknown>
    resolve: (response: acp.CreateElicitationResponse) => void
  }>()

  constructor(private readonly options: AcpProcessProviderOptions) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.id)) {
      throw new Error(`invalid ACP provider id: ${options.id}`)
    }
  }

  snapshot(): AgentProviderSnapshot {
    return {
      id: this.options.id,
      label: this.options.label,
      protocol: 'acp',
      status: this.status,
      capabilities: structuredClone(this.capabilities),
      activeSessionIds: [...this.sessions.keys()],
      configOptions: initialAgentConfig(this.options.id, [...this.sessions.values()].at(-1)?.configOptions),
      ...(this.version ? { version: this.version } : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  async createSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (!path.isAbsolute(options.cwd)) throw new Error('ACP session cwd must be absolute')
    for (const directory of options.additionalDirectories ?? []) {
      if (!path.isAbsolute(directory)) throw new Error('ACP additional directories must be absolute')
    }
    await this.ensureStarted()
    const lifecycle = this.lifecycle
    const connection = this.connection()
    const context = this.options.id === 'claude' ? claudeSystemContext(options.additionalContext) : {}
    const response = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: options.cwd,
      ...(Object.keys(context).length ? { _meta: claudeContextMeta(context) } : {}),
      mcpServers: (options.mcpServers ?? []).map(mcpServer),
      ...(options.additionalDirectories?.length
        ? { additionalDirectories: [...options.additionalDirectories] }
        : {}),
    }).catch((error: unknown) => { throw this.sessionError(error) })
    if (lifecycle !== this.lifecycle || this.stopping) throw new Error('ACP provider stopped while creating the session')
    const session: AcpSessionRecord = {
      id: response.sessionId,
      providerId: this.options.id,
      cwd: options.cwd,
      createdAt: now(),
      options: structuredClone(options),
      context,
      configOptions: configOptions(response),
    }
    if (response.modes) this.capabilities.sessionModes = true
    this.sessions.set(session.id, session)
    this.emit({
      type: 'session.created',
      providerId: this.options.id,
      sessionId: session.id,
      cwd: session.cwd,
      occurredAt: session.createdAt,
    })
    return structuredClone(session)
  }

  async prompt(sessionId: string, input: AgentPromptPart[], options?: AgentPromptOptions): Promise<AgentTurn> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`unknown ${this.options.label} session: ${sessionId}`)
    if (this.activeTurns.has(sessionId)) {
      throw new Error(`${this.options.label} session ${sessionId} already has an active turn`)
    }
    if (input.length === 0) throw new Error('ACP prompt needs at least one content block')
    if (input.some((part) => part.type === 'image') && !this.capabilities.images) {
      throw new Error(`${this.options.label} did not advertise image prompt support`)
    }

    const turn: AgentTurn = {
      id: randomUUID(),
      providerId: this.options.id,
      sessionId,
      startedAt: now(),
    }
    this.activeTurns.set(sessionId, turn.id)
    this.emit({
      type: 'turn.started',
      providerId: this.options.id,
      sessionId,
      turnId: turn.id,
      occurredAt: turn.startedAt,
    })

    const context = options?.additionalContext
    const prompt = context ? [...contextUpdates(session.context, context), ...input] : input
    if (context) session.context = structuredClone(context)
    const lifecycle = this.lifecycle
    const completion = this.connection().agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: prompt.map(promptBlock),
    }).then((response) => {
      if (lifecycle !== this.lifecycle || this.activeTurns.get(sessionId) !== turn.id) return
      if (response.stopReason === 'cancelled') session.context = {}
      this.activeTurns.delete(sessionId)
      this.cancelPermissions(sessionId)
      this.emit({
        type: 'turn.completed',
        providerId: this.options.id,
        sessionId,
        turnId: turn.id,
        stopReason: response.stopReason,
        occurredAt: now(),
      })
    }, (error: unknown) => {
      session.context = {}
      if (lifecycle !== this.lifecycle || this.activeTurns.get(sessionId) !== turn.id) return
      this.activeTurns.delete(sessionId)
      this.cancelPermissions(sessionId)
      this.finishChildren(sessionId, 'failed')
      this.emit({
        type: 'turn.failed',
        providerId: this.options.id,
        sessionId,
        turnId: turn.id,
        message: errorMessage(error),
        occurredAt: now(),
      })
    }).finally(() => {
      if (this.activeTurns.get(sessionId) === turn.id) this.activeTurns.delete(sessionId)
    })

    this.completions.set(sessionId, completion)
    return turn
  }

  async steer(sessionId: string, input: AgentPromptPart[], options?: AgentPromptOptions): Promise<'injected' | 'promptRequired'> {
    if (!this.capabilities.steering) throw new Error('This agent does not support live steering')
    if (!this.sessions.has(sessionId)) throw new Error('Unknown ACP session')
    if (!input.length) throw new Error('Write a message first')
    if (input.some((part) => part.type === 'image') && !this.capabilities.images) throw new Error('This agent does not support images')
    if (!this.activeTurns.has(sessionId)) return 'promptRequired'
    const session = this.sessions.get(sessionId)!
    const context = options?.additionalContext
    const previous = session.context
    const prompt = context ? [...contextUpdates(previous, context), ...input] : input
    const result = await this.connection().agent.request<{ outcome: string }>('_session/steering', {
      sessionId, prompt: prompt.map(promptBlock), _meta: { steering: { idleBehavior: 'promptRequired' } },
    })
    if (result.outcome !== 'injected' && result.outcome !== 'promptRequired') throw new Error('Unexpected steering response')
    if (result.outcome === 'promptRequired') await this.completions.get(sessionId)
    // A compaction arriving during the request must still force a refresh.
    else if (context && session.context === previous) session.context = structuredClone(context)
    return result.outcome
  }

  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const child = this.children.get(taskId)
    if (!child || child.root !== sessionId || child.terminal) throw new Error('This task is no longer running')
    if (!child.canStop) throw new Error('Claude cannot stop this child separately. Stop the parent turn to stop its agents.')
    if (child.kind === 'background') {
      const result = await this.connection().agent.request<{ stopped: boolean }>('_session/async_task/stop', { sessionId, asyncTaskId: taskId })
      if (!result.stopped) throw new Error('The agent could not stop this task')
    } else await this.connection().agent.notify(acp.methods.agent.session.cancel, { sessionId: taskId })
  }

  private rootSession(sessionId: string): string { return this.children.get(sessionId)?.root ?? sessionId }

  private finishChildren(sessionId: string, status: 'failed' | 'stopped'): void {
    for (const [taskId, child] of this.children) {
      if (child.root !== sessionId || child.terminal) continue
      child.terminal = true
      this.cancelPermissions(taskId)
      this.emit({ type: 'task.updated', providerId: this.options.id, sessionId, taskId, status, occurredAt: now() })
    }
  }

  private acceptChild(notification: ChildNotification): void {
    if (!this.capabilities.subagents) return
    const root = this.rootSession(notification.sessionId)
    if (!this.sessions.has(root)) return
    const update = notification.update
    const taskId = 'subagentSessionId' in update ? update.subagentSessionId : update.asyncTaskId
    const base = { providerId: this.options.id, sessionId: root, taskId, occurredAt: now() }
    if (update.sessionUpdate === 'subagent_spawned' || update.sessionUpdate === 'async_task_spawned') {
      if (this.sessions.has(taskId) || this.children.has(taskId)) return
      const kind = update.sessionUpdate === 'subagent_spawned' ? 'subagent' : 'background'
      const canStop = update.sessionUpdate === 'subagent_spawned' ? update.capabilities.cancel === true : update.canStop
      const turnId = this.children.get(notification.sessionId)?.turnId ?? this.activeTurns.get(root)
      this.children.set(taskId, { root, parent: notification.sessionId, canStop, kind, terminal: false,
        permissionMode: this.children.get(notification.sessionId)?.permissionMode ?? this.sessions.get(root)!.options.permissionMode,
        ...(turnId ? { turnId } : {}) })
      this.emit({ ...base, type: 'task.started', ...(turnId ? { turnId } : {}), parentSessionId: notification.sessionId, title: update.name,
        prompt: update.sessionUpdate === 'subagent_spawned' ? update.task : update.description, canStop, taskKind: kind })
      return
    }
    const child = this.children.get(taskId)
    if (!child || child.parent !== notification.sessionId || child.terminal) return
    const status = 'state' in update ? update.state === 'completed' ? 'done'
      : update.state === 'failed' || update.state === 'disconnected' ? 'failed'
        : update.state === 'cancelled' || update.state === 'stopped' ? 'stopped'
          : update.state === 'paused' ? 'waiting' : 'working' : undefined
    if (status && ['done', 'failed', 'stopped'].includes(status)) { child.terminal = true; this.cancelPermissions(taskId) }
    this.emit({ ...base, type: 'task.updated', ...(status ? { status } : {}),
      ...('summary' in update && update.summary ? { summary: update.summary } : {}) })
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) throw new Error(`unknown ${this.options.label} session: ${sessionId}`)
    if (!this.activeTurns.has(sessionId)) {
      const children = [...this.children].filter(([, child]) => child.root === sessionId && !child.terminal)
      if (children.some(([, child]) => !child.canStop)) throw new Error('Claude cannot stop this background agent separately')
      await Promise.all(children.map(([taskId]) => this.stopTask(sessionId, taskId)))
      this.finishChildren(sessionId, 'stopped')
      return
    }
    this.cancelPermissions(sessionId)
    this.finishChildren(sessionId, 'stopped')
    await this.connection().agent.notify(acp.methods.agent.session.cancel, { sessionId })
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (this.activeTurns.has(sessionId)) await this.cancel(sessionId)
    this.cancelPermissions(sessionId)
    const canClose = this.initializeCapabilities()?.sessionCapabilities?.close !== undefined
    if (canClose) {
      await this.connection().agent.request(acp.methods.agent.session.close, { sessionId })
    }
    this.activeTurns.delete(sessionId)
    this.sessions.delete(sessionId)
    this.finishChildren(sessionId, 'stopped')
    for (const [id, child] of this.children) if (child.root === sessionId) this.children.delete(id)
    for (const key of this.toolTitles.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.toolTitles.delete(key)
    }
    this.emit({
      type: 'session.closed',
      providerId: this.options.id,
      sessionId,
      cwd: session.cwd,
      occurredAt: now(),
    })
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async stop(): Promise<void> {
    this.lifecycle += 1
    this.stopping = true
    for (const sessionId of this.sessions.keys()) { this.cancelPermissions(sessionId); this.finishChildren(sessionId, 'stopped') }
    for (const [sessionId, turnId] of this.activeTurns) {
      this.emit({ type: 'turn.failed', providerId: this.options.id, sessionId, turnId,
        message: 'The agent was stopped. Send another message to resume this chat.', occurredAt: now() })
    }
    const opened = this.opened
    this.opened = undefined
    this.startPromise = undefined
    this.sessions.clear()
    this.children.clear()
    this.activeTurns.clear()
    this.completions.clear()
    this.toolTitles.clear()
    if (opened) await opened.close()
    this.setStatus('stopped')
    this.stopping = false
  }

  private initialized: acp.InitializeResponse | undefined

  private initializeCapabilities(): acp.AgentCapabilities | undefined {
    return this.initialized?.agentCapabilities
  }

  private async ensureStarted(): Promise<void> {
    if (this.status === 'ready' && this.opened) return
    if (!this.startPromise) {
      const lifecycle = ++this.lifecycle
      this.startPromise = this.start(lifecycle).catch((error: unknown) => {
        if (lifecycle === this.lifecycle) {
          const detail = this.stderrTail.trim()
          const message = detail ? `${errorMessage(error)}: ${detail}` : errorMessage(error)
          const failure = new Error([message, this.options.setupHint].filter(Boolean).join('\n\n'), { cause: error })
          this.setStatus('failed', failure.message)
          this.startPromise = undefined
          throw failure
        }
        throw error
      })
    }
    await this.startPromise
  }

  private async start(lifecycle: number): Promise<void> {
    this.stderrTail = ''
    this.setStatus('starting')
    const app = acp.client({ name: 'Alto' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => (
        this.requestPermission(ctx.params)
      ))
      .onRequest(acp.methods.client.elicitation.create, (ctx) => this.requestInput(ctx.params))
      .onNotification(CHILD_UPDATE, childNotification, (ctx) => this.acceptChild(ctx.params))
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.acceptUpdate(ctx.params)
      })
    const opened = this.options.openConnection
      ? await this.options.openConnection(app)
      : spawnConnection(this.options, app, (text) => this.recordStderr(text))
    if (lifecycle !== this.lifecycle || this.stopping) {
      await opened.close()
      throw new Error(`${this.options.label} ACP provider stopped while starting`)
    }
    this.opened = opened
    void opened.connection.closed.then(() => {
      if (this.opened !== opened || this.stopping) return
      for (const sessionId of this.sessions.keys()) { this.cancelPermissions(sessionId); this.finishChildren(sessionId, 'failed') }
      for (const [sessionId, turnId] of this.activeTurns) {
        this.emit({ type: 'turn.failed', providerId: this.options.id, sessionId, turnId,
          message: this.stderrTail.trim() || 'ACP agent connection closed', occurredAt: now() })
      }
      this.activeTurns.clear()
      this.completions.clear()
      this.sessions.clear()
      this.children.clear()
      this.opened = undefined
      this.startPromise = undefined
      this.setStatus('failed', this.stderrTail.trim() || 'ACP agent connection closed')
    })

    let initialized: acp.InitializeResponse
    try {
      initialized = await opened.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} }, session: { compaction: {} }, _meta: childCapabilities },
        clientInfo: {
          name: 'Alto',
          version: this.options.clientVersion ?? '0.1.0',
        },
      })
    } catch (error) {
      if (this.opened === opened) this.opened = undefined
      await opened.close()
      throw error
    }
    if (lifecycle !== this.lifecycle || this.stopping) {
      if (this.opened === opened) this.opened = undefined
      await opened.close()
      throw new Error(`${this.options.label} ACP provider stopped while initializing`)
    }
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(
        `ACP protocol mismatch: Alto supports ${acp.PROTOCOL_VERSION}, agent selected ${initialized.protocolVersion}`,
      )
    }
    this.initialized = initialized
    const advertised = initialized.agentCapabilities
    this.capabilities = {
      images: advertised?.promptCapabilities?.image === true,
      resources: true,
      mcpServers: advertised?.mcpCapabilities !== undefined,
      sessionHistory: advertised?.loadSession === true
        || advertised?.sessionCapabilities?.list !== undefined
        || advertised?.sessionCapabilities?.resume !== undefined,
      sessionList: advertised?.sessionCapabilities?.list !== undefined,
      sessionModes: false,
      steering: isRecord(initialized._meta?.steering) && initialized._meta.steering.supported === true,
      subagents: supportsChildren(initialized._meta),
    }
    this.version = initialized.agentInfo?.version ?? undefined
    this.setStatus('ready')
  }

  private connection(): acp.ClientConnection {
    if (!this.opened || this.status !== 'ready') {
      throw new Error(`${this.options.label} ACP provider is not ready`)
    }
    return this.opened.connection
  }

  private requestPermission(
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const session = this.sessions.get(this.rootSession(request.sessionId))
    if (!session || this.stopping || this.children.get(request.sessionId)?.terminal) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const turnId = this.children.get(request.sessionId)?.turnId ?? this.activeTurns.get(request.sessionId)
    const requestId = randomUUID()
    const response = new Promise<acp.RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(requestId, { sessionId: request.sessionId, toolCallId: request.toolCall.toolCallId, options: request.options, resolve })
    })
    this.emit({
      type: 'permission.requested',
      requestId,
      providerId: this.options.id,
      sessionId: request.sessionId,
      ...(turnId ? { turnId } : {}),
      toolCallId: request.toolCall.toolCallId,
      title: request.toolCall.title
        ?? this.toolTitles.get(toolKey(request.sessionId, request.toolCall.toolCallId))
        ?? 'Tool call',
      options: request.options.map((option) => ({
        id: option.optionId,
        label: option.name,
        kind: option.kind,
      })),
      occurredAt: now(),
    })

    if ((this.children.get(request.sessionId)?.permissionMode ?? session.options.permissionMode) === 'full') {
      const selected = request.options.find((option) => option.kind === 'allow_once')
        ?? request.options.find((option) => option.kind === 'allow_always')
      if (selected) void this.resolvePermission(requestId, selected.optionId)
      else this.finishPermission(requestId)
    }
    return response
  }

  async resolvePermission(requestId: string, optionId: string): Promise<void> {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) throw new Error('This permission request is no longer pending')
    if (!pending.options.some((option) => option.optionId === optionId)) throw new Error('Invalid permission option')
    this.finishPermission(requestId, optionId)
  }

  private finishPermission(requestId: string, optionId?: string): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    this.pendingPermissions.delete(requestId)
    const turnId = this.children.get(pending.sessionId)?.turnId ?? this.activeTurns.get(pending.sessionId)
    this.emit({
      type: 'permission.resolved',
      requestId,
      providerId: this.options.id,
      sessionId: pending.sessionId,
      ...(turnId ? { turnId } : {}),
      toolCallId: pending.toolCallId,
      ...(optionId ? { optionId } : {}),
      occurredAt: now(),
    })
    pending.resolve(optionId
      ? { outcome: { outcome: 'selected', optionId } }
      : { outcome: { outcome: 'cancelled' } })
  }

  private requestInput(request: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    if (request.mode !== 'form' || !('sessionId' in request) || typeof request.sessionId !== 'string' || !this.sessions.has(this.rootSession(request.sessionId))
      || this.children.get(request.sessionId)?.terminal || !isRecord(request.requestedSchema)) return Promise.resolve({ action: 'cancel' })
    const requestId = randomUUID()
    const sessionId = request.sessionId
    const schema = request.requestedSchema
    const response = new Promise<acp.CreateElicitationResponse>((resolve) => {
      this.pendingInputs.set(requestId, { sessionId, schema, resolve })
    })
    this.emit({ type: 'input.requested', providerId: this.options.id, sessionId, requestId,
      message: request.message, schema, occurredAt: now() })
    return response
  }

  async resolveInput(requestId: string, response: unknown): Promise<void> {
    const pending = this.pendingInputs.get(requestId)
    if (!pending) throw new Error('This question is no longer pending')
    if (!isRecord(response) || !['accept', 'decline', 'cancel'].includes(String(response.action))) throw new Error('Invalid answer')
    if (response.action === 'accept') {
      if (!isRecord(response.content)) throw new Error('Answers are required')
      const properties = isRecord(pending.schema.properties) ? pending.schema.properties : {}
      const required = Array.isArray(pending.schema.required) ? pending.schema.required : []
      for (const [key, field] of Object.entries(properties)) {
        if (!isRecord(field)) continue
        const value = response.content[key]
        if (value === undefined) { if (required.includes(key)) throw new Error(`${key} is required`); continue }
        const validType = field.type === 'array' ? Array.isArray(value) && value.every((item) => typeof item === 'string')
          : field.type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
          : typeof value === field.type
        if (!validType) throw new Error(`Invalid value for ${key}`)
        const choices = Array.isArray(field.enum) ? field.enum : Array.isArray(field.oneOf)
          ? field.oneOf.filter(isRecord).map((option) => option.const) : undefined
        if (choices && !choices.includes(value)) throw new Error(`Choose an offered value for ${key}`)
      }
    }
    this.pendingInputs.delete(requestId)
    this.emit({ type: 'input.resolved', providerId: this.options.id, sessionId: pending.sessionId, requestId, occurredAt: now() })
    pending.resolve(response as acp.CreateElicitationResponse)
  }

  async configure(sessionId: string, configId: string, value: string): Promise<AgentConfigOption[]> {
    const session = this.sessions.get(sessionId)
    const option = session?.configOptions?.find((option) => option.id === configId)
    if (!session || !option || !option.options.some((candidate) => candidate.value === value)) throw new Error('Invalid agent configuration option')
    const lifecycle = this.lifecycle
    let updated: AgentConfigOption[] | undefined
    if (configId === '__mode') {
      await this.connection().agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: value })
    } else {
      const response = await this.connection().agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value })
      updated = configOptions(response)
    }
    if (lifecycle !== this.lifecycle || this.sessions.get(sessionId) !== session || this.stopping) {
      throw new Error('ACP session closed while changing configuration')
    }
    if (updated) session.configOptions = updated
    else option.currentValue = value
    const options = session.configOptions ?? []
    this.emit({ type: 'config.updated', providerId: this.options.id, sessionId, configOptions: options, occurredAt: now() })
    return structuredClone(options)
  }

  private cancelPermissions(sessionId: string): void {
    for (const [requestId, pending] of this.pendingInputs) {
      if (pending.sessionId === sessionId) void this.resolveInput(requestId, { action: 'cancel' })
    }
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId) this.finishPermission(requestId)
    }
  }

  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Unknown ACP session')
    session.options.permissionMode = mode
  }

  private sessionError(error: unknown): unknown {
    if (error instanceof acp.RequestError && error.code === -32000 && this.options.setupHint) {
      return new Error(`${error.message}\n\n${this.options.setupHint}`, { cause: error })
    }
    return error
  }

  async listSessions(options: { cwd?: string; cursor?: string } = {}): Promise<AgentSessionPage> {
    if (options.cwd && !path.isAbsolute(options.cwd)) throw new Error('ACP history cwd must be absolute')
    await this.ensureStarted()
    if (!this.initializeCapabilities()?.sessionCapabilities?.list) {
      throw new Error(`${this.options.label} does not support listing saved sessions`)
    }
    const lifecycle = this.lifecycle
    const response = await this.connection().agent.request<acp.ListSessionsResponse>(acp.methods.agent.session.list, options)
    if (lifecycle !== this.lifecycle || this.stopping) throw new Error('ACP provider stopped while listing sessions')
    return {
      sessions: response.sessions.map((session) => ({ id: session.sessionId, cwd: session.cwd,
        ...(session.title ? { title: session.title } : {}), ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}) })),
      ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
    }
  }

  async loadSession(sessionId: string, options: AgentSessionOptions): Promise<AgentSession> {
    if (!path.isAbsolute(options.cwd)) throw new Error('ACP session cwd must be absolute')
    await this.ensureStarted()
    const lifecycle = this.lifecycle
    if (!this.initializeCapabilities()?.loadSession) {
      throw new Error(`${this.options.label} cannot resume saved sessions. Start a new chat to continue.`)
    }
    if (this.activeTurns.has(sessionId) || this.replayUpdates.has(sessionId)) throw new Error('ACP session is busy')
    const context = this.options.id === 'claude' ? claudeSystemContext(options.additionalContext) : {}
    // session/load emits its transcript before its response. Buffer it until
    // loading succeeds so a failed load cannot erase Alto's saved transcript.
    const updates: acp.SessionNotification[] = []
    this.replayUpdates.set(sessionId, updates)
    try {
      const response = await this.connection().agent.request(acp.methods.agent.session.load, {
        ...(Object.keys(context).length ? { _meta: claudeContextMeta(context) } : {}),
        sessionId, cwd: options.cwd, mcpServers: (options.mcpServers ?? []).map(mcpServer),
      }).catch((error: unknown) => { throw this.sessionError(error) })
      if (lifecycle !== this.lifecycle || this.stopping) throw new Error('ACP provider stopped while loading the session')
      // A resumed Claude session may retain its original system prompt. Send
      // current context once with the next prompt even when append was supplied.
      const session: AcpSessionRecord = { context: {}, id: sessionId, providerId: this.options.id, cwd: options.cwd,
        createdAt: now(), options: structuredClone(options), configOptions: configOptions(response) }
      this.sessions.set(sessionId, session)
      this.replayUpdates.delete(sessionId)
      const base = { providerId: this.options.id, sessionId, occurredAt: now() }
      this.emit({ ...base, type: 'session.replay', phase: 'started' })
      for (const update of updates) this.acceptUpdate(update)
      this.emit({ ...base, type: 'session.replay', phase: 'finished' })
      this.emit({ ...base, type: 'session.created', cwd: options.cwd })
      return structuredClone(session)
    } finally {
      this.replayUpdates.delete(sessionId)
    }
  }

  private acceptUpdate(notification: acp.SessionNotification): void {
    const replay = this.replayUpdates.get(notification.sessionId)
    if (replay) { replay.push(notification); return }
    if (!this.sessions.has(this.rootSession(notification.sessionId)) || this.children.get(notification.sessionId)?.terminal) return
    const update = notification.update
    const turnId = this.children.get(notification.sessionId)?.turnId ?? this.activeTurns.get(notification.sessionId)
    const occurredAt = now()
    const session = this.sessions.get(this.rootSession(notification.sessionId))!
    const base = { providerId: this.options.id, sessionId: notification.sessionId, occurredAt }
    if (update.sessionUpdate === 'compaction_update') {
      if (notification.sessionId === session.id && update.status === 'completed') session.context = {}
      this.emit({ ...base, ...(turnId ? { turnId } : {}),
        type: update.status === 'in_progress' ? 'tool.started' : 'tool.updated',
        toolCallId: `compaction:${update.compactionId}`, title: 'Compact context',
        status: update.status === 'cancelled' ? 'failed' : update.status,
      })
      return
    }
    if (update.sessionUpdate === 'config_option_update') {
      session.configOptions = configOptions(update)
      this.emit({ ...base, type: 'config.updated', configOptions: session.configOptions }); return
    }
    if (update.sessionUpdate === 'current_mode_update') {
      const mode = session.configOptions?.find((option) => option.category === 'mode')
      if (mode) { mode.currentValue = update.currentModeId; this.emit({ ...base, type: 'config.updated', configOptions: session.configOptions! }) }
      return
    }
    if (update.sessionUpdate === 'usage_update') {
      this.emit({ ...base, type: 'usage.updated', used: update.used, size: update.size, ...(update.cost ? { cost: update.cost } : {}) }); return
    }
    if (update.sessionUpdate === 'available_commands_update') {
      this.emit({ ...base, type: 'commands.updated', commands: update.availableCommands.map(({ name, description }) => ({ name, description })) }); return
    }
    const content = updateContent(update)
    if (content) {
      const role = update.sessionUpdate === 'agent_message_chunk'
        ? 'agent'
        : update.sessionUpdate === 'agent_thought_chunk'
          ? 'thought'
          : 'user'
      this.emit({
        type: 'message.delta',
        providerId: this.options.id,
        sessionId: notification.sessionId,
        ...(turnId ? { turnId } : {}),
        ...('messageId' in update && update.messageId ? { messageId: update.messageId } : {}),
        role,
        content,
        occurredAt,
      })
      return
    }

    if (update.sessionUpdate === 'tool_call') {
      this.toolTitles.set(toolKey(notification.sessionId, update.toolCallId), update.title)
      this.emit({
        type: 'tool.started',
        providerId: this.options.id,
        sessionId: notification.sessionId,
        ...(turnId ? { turnId } : {}),
        toolCallId: update.toolCallId,
        title: update.title,
        ...(update.content ? { content: toolContent(update.content) ?? '', files: toolFiles(update.content) ?? [] } : {}),
        ...(update.status ? { status: update.status } : {}),
        ...(update.kind ? { kind: update.kind } : {}),
        occurredAt,
      })
      return
    }

    if (update.sessionUpdate === 'tool_call_update') {
      const key = toolKey(notification.sessionId, update.toolCallId)
      if (update.title) this.toolTitles.set(key, update.title)
      this.emit({
        type: 'tool.updated',
        providerId: this.options.id,
        sessionId: notification.sessionId,
        ...(turnId ? { turnId } : {}),
        toolCallId: update.toolCallId,
        title: update.title ?? this.toolTitles.get(key) ?? 'Tool call',
        ...(update.content ? { content: toolContent(update.content) ?? '', files: toolFiles(update.content) ?? [] } : {}),
        ...(update.status ? { status: update.status } : {}),
        ...(update.kind ? { kind: update.kind } : {}),
        occurredAt,
      })
      return
    }

    if (update.sessionUpdate !== 'plan') return
    this.emit({
      type: 'plan.updated',
      providerId: this.options.id,
      sessionId: notification.sessionId,
      ...(turnId ? { turnId } : {}),
      entries: update.entries.map((entry) => ({
        content: entry.content,
        status: entry.status,
        priority: entry.priority,
      })),
      occurredAt,
    })
  }

  private recordStderr(text: string): void {
    this.stderrTail = `${this.stderrTail}${text}`.slice(-4000)
  }

  private setStatus(status: AgentProviderSnapshot['status'], error?: string): void {
    this.status = status
    this.error = error
    this.emit({
      type: 'provider.status',
      providerId: this.options.id,
      status,
      ...(error ? { error } : {}),
      occurredAt: now(),
    })
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event))
  }
}

const plugin: HarnessPlugin<AcpProviderConfig> = (ctx: Context, config) => {
  const id = config.id?.trim() || 'claude'
  const label = config.label?.trim() || 'Claude'
  const provider = new AcpProcessProvider({
    id,
    label,
    command: config.command?.trim() || 'claude-agent-acp',
    ...(config.args ? { args: [...config.args] } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.env ? { env: { ...config.env } } : {}),
    ...(config.setupHint ? { setupHint: config.setupHint } : {}),
  })
  ctx.agents.register(ctx, provider)

}

plugin.inject = ['agents']

export default plugin
