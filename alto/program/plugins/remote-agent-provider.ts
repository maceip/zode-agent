import { initialAgentConfig } from './agent-model-options.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConfigOption, AgentEvent, AgentEventListener, AgentPromptPart, AgentProvider, AgentProviderSnapshot, AgentSession, AgentSessionOptions, AgentTurn } from '../../src/server/services/agent-registry.js'
import type { RemoteAgentBackend, RemoteAgentDescriptor, RemoteAgentProcess } from '../../src/server/services/remote-agent-api.js'
import { RemoteRpc, type RemoteRpcMessage } from '../../src/server/services/remote-rpc.js'
import type { PermissionMode } from '../../src/shared/protocol.js'
import { childCapabilities } from './acp-extensions.js'
import { promptBlock } from './acp-format.js'
import { RemoteAgentProtocol, inputSchema, record, records, string, type RemoteEvent } from './remote-agent-protocol.js'
import type { RemoteWorkspace } from './remote-workspace-api.js'

type Saved = { version: 1; id: string; providerId: string; process: RemoteAgentProcess; cwd: string; createdAt: string; mode: PermissionMode; config?: AgentConfigOption[] }
type Attached = { saved: Saved; rpc: RemoteRpc; protocol: RemoteAgentProtocol; replaying: boolean; answering: Set<string> }
const now = () => new Date().toISOString()

export class RemoteAgentProvider implements AgentProvider {
  private readonly sessions = new Map<string, Attached>()
  private readonly loading = new Map<string, Promise<AgentSession>>()
  private readonly workspaces = new Map<string, { expires: number; value: Promise<RemoteWorkspace | undefined> }>()
  private readonly listeners = new Set<AgentEventListener>()
  private readonly lifecycle = new AbortController()
  readonly id: string

  constructor(private readonly backend: RemoteAgentBackend, private readonly agent: RemoteAgentDescriptor, private readonly directory: string) {
    this.id = `${backend.id}-${agent.id}`
  }

  snapshot(): AgentProviderSnapshot {
    const capabilities = [...this.sessions.values()][0]?.protocol.capabilities ?? new RemoteAgentProtocol(this.agent.protocol, () => {}).capabilities
    return { id: this.id, label: this.agent.label, agentId: this.agent.id, location: { id: this.backend.id, label: this.backend.label }, protocol: 'remote', status: 'ready', capabilities, remoteLocation: this.backend.label,
      activeSessionIds: [...this.sessions.keys()],
      configOptions: initialAgentConfig(this.agent.id, [...this.sessions.values()].at(-1)?.protocol.config) }
  }

  async workspaceName(cwd: string): Promise<string | undefined> {
    return this.backend.workspaceName?.(cwd, this.lifecycle.signal)
  }

  async workspaceInfo(sessionId: string): Promise<RemoteWorkspace | undefined> {
    const cached = this.workspaces.get(sessionId)
    if (cached && cached.expires > Date.now()) return cached.value
    const value = (async () => {
      const saved = this.sessions.get(sessionId)?.saved ?? await this.readSaved(sessionId)
      return this.backend.workspaceInfo
        ? this.backend.workspaceInfo(saved.process, AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(25_000)]))
        : saved.process.workspace
    })()
    this.workspaces.set(sessionId, { expires: Date.now() + 30_000, value })
    void value.catch(() => { if (this.workspaces.get(sessionId)?.value === value) this.workspaces.delete(sessionId) })
    return value
  }

  private publicRequestId(sessionId: string, wireId: string): string {
    return `${sessionId}:${wireId}`
  }

  private publicEvent(sessionId: string, event: RemoteEvent): RemoteEvent {
    return event.type === 'input.requested' || event.type === 'input.resolved'
      || event.type === 'permission.requested' || event.type === 'permission.resolved'
      ? { ...event, requestId: this.publicRequestId(sessionId, event.requestId) } : event
  }

  private emit(id: string, event: RemoteEvent, occurredAt = now(), childId?: string): void {
    const value = { ...this.publicEvent(id, event), providerId: this.id, sessionId: childId ?? id, occurredAt } as AgentEvent
    for (const listener of this.listeners) listener(structuredClone(value))
  }

  private session(value: Attached): AgentSession {
    return { id: value.saved.id, providerId: this.id, cwd: value.saved.cwd, createdAt: value.saved.createdAt, ...(value.saved.process.workspaceName ? { workspaceName: value.saved.process.workspaceName } : {}), ...(value.saved.process.workspace ? { workspace: value.saved.process.workspace } : {}), configOptions: structuredClone(value.protocol.config) }
  }

  private file(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid remote session ID')
    return path.join(this.directory, `${id}.json`)
  }

  private async save(saved: Saved): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const target = this.file(saved.id)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 })
    await rename(temporary, target)
  }

  private async readSaved(id: string): Promise<Saved> {
    const saved = JSON.parse(await readFile(this.file(id), 'utf8')) as Saved
    if (saved.version !== 1 || saved.id !== id || saved.providerId !== this.id || !saved.process?.id) throw new Error('Invalid remote session binding')
    return saved
  }

  private async attach(saved: Saved, replay: boolean): Promise<Attached> {
    let attached: Attached
    const history: Array<{ event: RemoteEvent; time: string; childId?: string }> = []
    const protocol = new RemoteAgentProtocol(this.agent.protocol, (event, time, childId) => {
      if (attached.replaying) history.push({ event, time, ...(childId ? { childId } : {}) })
      else this.emit(saved.id, event, time, childId)
    })
    const rpc = new RemoteRpc(this.backend, saved.process, {
      message: (direction, message, time) => {
        protocol.accept(direction, message, time)
        if (direction === 'output' && message.method && message.id !== undefined && !attached.replaying) void this.automaticReplies(attached)
      },
      connection: (state, message) => this.emit(saved.id, { type: 'connection.changed', state, ...(message ? { message } : {}) }),
    })
    attached = { saved, rpc, protocol, replaying: replay, answering: new Set() }
    this.sessions.set(saved.id, attached)
    try {
      await rpc.attach(replay)
      if (saved.config && this.agent.protocol === 'codex-app-server') protocol.config = saved.config
      if (replay) {
        this.emit(saved.id, { type: 'session.replay', phase: 'started' })
        for (const item of history) this.emit(saved.id, item.event, item.time, item.childId)
        this.emit(saved.id, { type: 'config.updated', configOptions: protocol.config })
      }
      attached.replaying = false
      if (replay) this.emit(saved.id, { type: 'session.replay', phase: 'finished' })
      await this.automaticReplies(attached)
      return attached
    } catch (error) {
      this.sessions.delete(saved.id)
      await rpc.detach()
      throw error
    }
  }

  async createSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (this.lifecycle.signal.aborted) throw new Error('Remote provider is unavailable')
    const process = await this.backend.create(this.agent.id, options.cwd, this.lifecycle.signal)
    const saved: Saved = { version: 1, id: randomUUID(), providerId: this.id, process, cwd: options.cwd, createdAt: now(), mode: options.permissionMode }
    let session: Attached | undefined
    try {
      this.lifecycle.signal.throwIfAborted()
      await this.save(saved)
      this.lifecycle.signal.throwIfAborted()
      session = await this.attach(saved, false)
      if (this.agent.protocol === 'acp') {
        await session.rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'Alto', version: '0.1.0' },
          clientCapabilities: { elicitation: { form: {} }, _meta: childCapabilities } })
        await session.rpc.request('session/new', { cwd: process.cwd, mcpServers: [] })
        await this.applyPermissionMode(session)
      } else {
        await session.rpc.request('initialize', { clientInfo: { name: 'alto', title: 'Alto', version: '0.1.0' }, capabilities: { experimentalApi: true } })
        await session.rpc.send({ method: 'initialized', params: {} })
        await session.rpc.request('thread/start', { cwd: process.cwd, ...this.codexPermissions(saved.mode), dynamicTools: [], experimentalRawEvents: false, config: { 'features.current_time_reminder.clock_source': 'system' } })
        await session.rpc.request('model/list', {})
      }
      if (!session.protocol.nativeId) throw new Error('Remote agent did not create a session')
      this.emit(saved.id, { type: 'session.created', cwd: saved.cwd })
      return this.session(session)
    } catch (error) {
      await session?.rpc.detach()
      this.sessions.delete(saved.id)
      await this.backend.terminate(process, AbortSignal.timeout(10_000)).catch(() => {})
      throw error
    }
  }

  async loadSession(id: string, _options: AgentSessionOptions): Promise<AgentSession> {
    const existing = this.sessions.get(id)
    if (existing) return this.session(existing)
    const pending = this.loading.get(id)
    if (pending) return pending
    const operation = (async () => {
      const saved = await this.readSaved(id)
      if (!saved.process.workspaceName && this.backend.workspaceName) {
        // Older bindings kept provider-specific metadata in the opaque process
        // handle. A missing display name must never prevent reconnecting.
        const name = await this.backend.workspaceName(saved.cwd, this.lifecycle.signal, saved.process).catch(() => undefined)
        if (name) saved.process.workspaceName = name
      }
      return this.session(await this.attach(saved, true))
    })().finally(() => this.loading.delete(id))
    this.loading.set(id, operation)
    return operation
  }

  private get(id: string): Attached {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Remote session is not attached')
    if (session.rpc.isEnded) throw new Error('The remote agent has exited. Its conversation remains available; start a new remote chat to continue.')
    if (!session.rpc.isConnected) throw new Error('Reconnecting to the remote agent. Wait for the connection before sending.')
    return session
  }

  private codexPermissions(mode: PermissionMode): Record<string, unknown> {
    return { approvalPolicy: mode === 'full' ? 'never' : 'on-request', approvalsReviewer: 'user', sandbox: mode === 'full' ? 'danger-full-access' : 'workspace-write' }
  }

  async prompt(id: string, input: AgentPromptPart[]): Promise<AgentTurn> {
    const session = this.get(id)
    if (session.protocol.activeTurn) throw new Error('The remote agent is still working')
    if (input.some((part) => part.type === 'resource')) throw new Error('Remote file references must point to files on the remote workspace. Paste text or attach an image instead.')
    await this.applyPermissionMode(session)
    await this.save(session.saved)
    const requestId = randomUUID()
    const nativeId = session.protocol.nativeId
    const config = session.protocol.config
    await session.rpc.send(this.agent.protocol === 'acp'
      ? { id: requestId, method: 'session/prompt', params: { sessionId: nativeId, prompt: input.map(promptBlock), _meta: { alto: { permissionMode: session.saved.mode } } } }
      : { id: requestId, method: 'turn/start', params: { threadId: nativeId, input: this.codexInput(input),
        cwd: session.saved.process.cwd, model: config.find((option) => option.id === 'model')?.currentValue ?? null,
        effort: config.find((option) => option.id === 'effort')?.currentValue ?? null,
        approvalPolicy: session.saved.mode === 'full' ? 'never' : 'on-request',
        sandboxPolicy: session.saved.mode === 'full' ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: [session.saved.process.cwd], networkAccess: false } } })
    return { id: requestId, providerId: this.id, sessionId: id, startedAt: now() }
  }

  private async applyPermissionMode(session: Attached): Promise<void> {
    if (this.agent.protocol !== 'acp') return
    const mode = session.protocol.config.find((option) => option.category === 'mode')
    if (!mode) return
    const preferred = session.saved.mode === 'full' ? ['bypassPermissions', 'yolo'] : ['default', 'manual']
    const value = preferred.find((value) => mode.options.some((option) => option.value === value))
    if (!value) {
      if (session.saved.mode === 'ask' && ['bypassPermissions', 'yolo'].includes(mode.currentValue)) throw new Error('This agent does not offer a permission mode compatible with Ask')
      return
    }
    if (mode.currentValue !== value) await session.rpc.request('session/set_mode', { sessionId: session.protocol.nativeId, modeId: value })
    mode.currentValue = value
  }

  private codexInput(input: AgentPromptPart[]): unknown[] {
    return input.map((part) => part.type === 'image' ? { type: 'image', url: `data:${part.mimeType};base64,${part.data}` } : part)
  }

  async steer(id: string, input: AgentPromptPart[]): Promise<'injected' | 'promptRequired'> {
    const session = this.get(id)
    if (!session.protocol.activeTurn) return 'promptRequired'
    if (!session.protocol.capabilities.steering) throw new Error('This remote agent does not support steering')
    const result = record(await session.rpc.request(this.agent.protocol === 'acp' ? '_session/steering' : 'turn/steer', this.agent.protocol === 'acp'
      ? { sessionId: session.protocol.nativeId, prompt: input.map(promptBlock), _meta: { steering: { idleBehavior: 'promptRequired' } } }
      : { threadId: session.protocol.nativeId, expectedTurnId: session.protocol.activeTurn, input: this.codexInput(input) }))
    return this.agent.protocol === 'acp' && result.outcome === 'promptRequired' ? 'promptRequired' : 'injected'
  }

  async cancel(id: string): Promise<void> {
    const session = this.get(id)
    await session.rpc.send(this.agent.protocol === 'acp' ? { method: 'session/cancel', params: { sessionId: session.protocol.nativeId } }
      : { id: randomUUID(), method: 'turn/interrupt', params: { threadId: session.protocol.nativeId, turnId: session.protocol.activeTurn } })
  }

  async stopTask(id: string, taskId: string): Promise<void> {
    const session = this.get(id)
    const child = session.protocol.children.get(taskId)
    if (!child?.canStop) throw new Error('This agent cannot stop that child separately')
    if (this.agent.protocol === 'codex-app-server') {
      if (!child.activeTurn) throw new Error('This subagent no longer has an active turn')
      await session.rpc.request('turn/interrupt', { threadId: taskId, turnId: child.activeTurn })
    } else if (child.kind === 'background') await session.rpc.request('_session/async_task/stop', { sessionId: session.protocol.nativeId, asyncTaskId: taskId })
    else await session.rpc.send({ method: 'session/cancel', params: { sessionId: taskId } })
  }

  async configure(id: string, configId: string, value: string): Promise<AgentConfigOption[]> {
    const session = this.get(id)
    const option = session.protocol.config.find((candidate) => candidate.id === configId)
    if (!option?.options.some((candidate) => candidate.value === value)) throw new Error('Invalid remote agent configuration')
    if (this.agent.protocol === 'acp') await session.rpc.request(configId === '__mode' ? 'session/set_mode' : 'session/set_config_option', {
      sessionId: session.protocol.nativeId, ...(configId === '__mode' ? { modeId: value } : { configId, value }),
    })
    option.currentValue = value
    if (this.agent.protocol === 'codex-app-server' && configId === 'model') session.protocol.selectCodexModel(value)
    session.saved.config = structuredClone(session.protocol.config)
    await this.save(session.saved)
    this.emit(id, { type: 'config.updated', configOptions: session.protocol.config })
    return structuredClone(session.protocol.config)
  }

  setPermissionMode(id: string, mode: PermissionMode): void {
    const session = this.sessions.get(id)
    if (session) session.saved.mode = mode
  }

  private decision(requestId: string): [Attached, RemoteRpcMessage] {
    if (!/^[a-f0-9-]{36}:/.test(requestId)) throw new Error('This request is no longer pending')
    const sessionId = requestId.slice(0, 36)
    const wireId = requestId.slice(37)
    const session = this.sessions.get(sessionId)
    const request = session?.protocol.decisions.get(wireId)
    if (!session || !request) throw new Error('This request is no longer pending')
    this.get(sessionId)
    return [session, request]
  }

  async resolvePermission(requestId: string, optionId: string): Promise<void> {
    const [session, request] = this.decision(requestId)
    const options = records(request.params?.options)
    if (request.method === 'session/request_permission' ? !options.some((option) => option.optionId === optionId) : !['accept', 'decline'].includes(optionId)) throw new Error('Invalid permission option')
    await session.rpc.send({ id: request.id!, result: request.method === 'session/request_permission'
      ? { outcome: { outcome: 'selected', optionId } } : { decision: optionId } })
  }

  async resolveInput(requestId: string, response: unknown): Promise<void> {
    const [session, request] = this.decision(requestId)
    const result = record(response)
    if (!['accept', 'decline', 'cancel'].includes(string(result.action))) throw new Error('Invalid input response')
    const content = record(result.content)
    if (result.action === 'accept') {
      const schema = request.method === 'item/tool/requestUserInput' ? inputSchema(request.params ?? {}) : record(request.params?.requestedSchema)
      for (const key of Array.isArray(schema.required) ? schema.required : []) if (typeof key === 'string' && content[key] === undefined) throw new Error(`${key} is required`)
      for (const [key, raw] of Object.entries(record(schema.properties))) {
        const field = record(raw), value = content[key]
        if (value === undefined) continue
        if (field.type === 'string' && typeof value !== 'string' || field.type === 'boolean' && typeof value !== 'boolean'
          || field.type === 'number' && typeof value !== 'number' || field.type === 'integer' && !Number.isInteger(value)) throw new Error(`Invalid value for ${key}`)
        if (Array.isArray(field.enum) && !field.enum.includes(value)) throw new Error(`Choose an offered value for ${key}`)
      }
    }
    await session.rpc.send({ id: request.id!, result: request.method === 'item/tool/requestUserInput'
      ? { answers: Object.fromEntries(Object.entries(content).map(([key, value]) => [key, { answers: Array.isArray(value) ? value : [String(value)] }])) } : result })
  }

  private async automaticReplies(session: Attached): Promise<void> {
    if (session.replaying || session.rpc.isEnded) return
    for (const [id, request] of session.protocol.decisions) {
      if (session.answering.has(id)) continue
      if (request.method !== 'currentTime/read' && request.method !== 'session/request_permission') continue
      if (request.method === 'session/request_permission' && (session.protocol.children.get(string(request.params?.sessionId))?.permissionMode ?? session.protocol.turnPermissionMode) !== 'full') continue
      session.answering.add(id)
      try {
        if (request.method === 'currentTime/read') await session.rpc.send({ id: request.id!, result: { currentTimeAt: Math.floor(Date.now() / 1000) } })
        else {
          const option = records(request.params?.options).find((option) => option.kind === 'allow_once')
          if (option) await this.resolvePermission(this.publicRequestId(session.saved.id, id), string(option.optionId))
        }
      } catch { session.answering.delete(id) }
    }
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await session.rpc.detach()
  }
  subscribe(listener: AgentEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async stop(): Promise<void> { this.lifecycle.abort(); await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id))) }
}
