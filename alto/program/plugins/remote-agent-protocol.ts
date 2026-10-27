import type * as acp from '@agentclientprotocol/sdk'
import type { AgentConfigOption, AgentEvent, AgentPromptPart, AgentProviderCapabilities } from '../../src/server/services/agent-registry.js'
import type { RemoteRpcMessage } from '../../src/server/services/remote-rpc.js'
import { isRecord, type PermissionMode } from '../../src/shared/protocol.js'
import { configOptions, toolContent, toolFiles, updateContent } from './acp-format.js'
import { childNotification, supportsChildren } from './acp-extensions.js'
import { commandTitle, toolTitle } from './app-server-format.js'

type Payload<T> = T extends AgentEvent ? Omit<T, 'providerId' | 'sessionId' | 'occurredAt'> : never
export type RemoteEvent = Payload<AgentEvent>
export const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {}
export const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback
export const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : []

type RemoteChild = {
  parent: string
  kind: 'subagent' | 'background'
  canStop: boolean
  permissionMode: PermissionMode
  turnId?: string
  activeTurn?: string
}

const collabStatus: Record<string, 'working' | 'done' | 'failed' | 'stopped'> = {
  pendingInit: 'working', running: 'working', interrupted: 'stopped', completed: 'done',
  errored: 'failed', shutdown: 'stopped', notFound: 'failed',
}

function nativeParent(value: unknown): string | undefined {
  const thread = record(value)
  const spawn = record(record(record(thread.source).subAgent).thread_spawn)
  return string(thread.parentThreadId) || string(spawn.parent_thread_id) || undefined
}

function childTitle(thread: Record<string, unknown>): string {
  const spawn = record(record(record(thread.source).subAgent).thread_spawn)
  return string(thread.name) || string(thread.agentNickname) || string(spawn.agent_nickname)
    || string(spawn.agent_role) || 'Subagent'
}

export function inputSchema(params: Record<string, unknown>): Record<string, unknown> {
  const properties = Object.fromEntries(records(params.questions).map((question) => [string(question.id), {
    type: 'string', description: string(question.question),
    ...(records(question.options).length ? { enum: records(question.options).map((option) => string(option.label)) } : {}),
  }]))
  return { type: 'object', properties, required: Object.keys(properties) }
}

/** Rebuilds protocol state from the remote journal, including unanswered requests. */
export class RemoteAgentProtocol {
  nativeId = ''
  initialized = false
  turnPermissionMode: PermissionMode = 'ask'
  private readonly completedTurns = new Set<string>()
  activeTurn: string | undefined
  config: AgentConfigOption[] = []
  private modelCatalog: Record<string, unknown>[] = []
  capabilities: AgentProviderCapabilities = { images: false, resources: false, mcpServers: false, sessionHistory: true, sessionModes: false, durableSession: true }
  readonly requests = new Map<string, RemoteRpcMessage>()
  readonly decisions = new Map<string, RemoteRpcMessage>()
  readonly children = new Map<string, RemoteChild>()
  private readonly pendingThreads = new Map<string, { thread: Record<string, unknown>; time: string; fallback?: { parent: string; prompt?: string; title?: string; model?: string; effort?: string } }>()
  private readonly decisionTimes = new Map<string, string>()
  private readonly announcedDecisions = new Set<string>()
  private readonly titles = new Map<string, string>()
  private readonly output = new Map<string, string>()
  private readonly commands = new Map<string, string>()

  constructor(readonly kind: 'acp' | 'codex-app-server', private readonly emit: (event: RemoteEvent, timestamp: string, childId?: string) => void) {}

  accept(direction: 'input' | 'output', message: RemoteRpcMessage, time: string): void {
    const params = message.params ?? {}
    const id = String(message.id)
    if (direction === 'input') {
      if (message.method && message.id !== undefined) {
        this.requests.set(id, message)
        if (message.method === 'session/prompt') {
          this.turnPermissionMode = record(record(params._meta).alto).permissionMode === 'full' ? 'full' : 'ask'
          this.activeTurn = id
          this.emit({ type: 'turn.started', turnId: id }, time)
          this.submitted(id, params.prompt, time)
        } else if (message.method === 'turn/start') this.submitted(id, params.input, time)
      } else if (message.id !== undefined) {
        const decision = this.decisions.get(id)
        if (decision) {
          const permission = decision.method === 'session/request_permission' || decision.method?.endsWith('/requestApproval')
          const childId = this.decisionChild(decision.params ?? {})
          if (this.announcedDecisions.has(id) && childId !== null) this.emit(permission ? { type: 'permission.resolved', requestId: id, toolCallId: string(record(decision.params?.toolCall).toolCallId) }
            : { type: 'input.resolved', requestId: id, ...this.answered(decision, record(message.result)) }, time, childId)
          this.decisions.delete(id)
          this.decisionTimes.delete(id)
          this.announcedDecisions.delete(id)
        }
      }
      return
    }
    if (message.id !== undefined && !message.method) {
      const request = this.requests.get(id)
      this.requests.delete(id)
      if (!request) return
      const result = record(message.result)
      if (request.method === 'initialize' && !message.error) {
        this.initialized = true
        const caps = record(result.agentCapabilities)
        this.capabilities = { ...this.capabilities, images: this.kind === 'codex-app-server' || record(caps.promptCapabilities).image === true,
          resources: false, steering: this.kind === 'codex-app-server' || record(record(result._meta).steering).supported === true,
          subagents: this.kind === 'codex-app-server' || supportsChildren(result._meta) }
      }
      if (request.method === 'session/new' && typeof result.sessionId === 'string') this.nativeId = result.sessionId
      if (request.method === 'thread/start' && typeof record(result.thread).id === 'string') {
        this.nativeId = String(record(result.thread).id)
        this.discoverPendingChildren()
      }
      if (this.kind === 'acp' && result.configOptions) this.config = configOptions(result as unknown as acp.NewSessionResponse)
      if (this.kind === 'acp' && result.modes && !this.config.length) this.config = configOptions(result as unknown as acp.NewSessionResponse)
      if (request.method === 'model/list') this.codexModels(result)
      if (request.method === 'session/prompt') {
        this.emit(message.error ? { type: 'turn.failed', turnId: id, message: message.error.message ?? 'Remote turn failed' }
          : { type: 'turn.completed', turnId: id, stopReason: string(result.stopReason, 'end_turn') }, time)
        if (this.activeTurn === id) this.activeTurn = undefined
      }
      if (request.method === 'turn/start') {
        if (message.error) this.emit({ type: 'turn.failed', turnId: id, message: message.error.message ?? 'Remote turn failed' }, time)
        else {
          const turnId = string(record(result.turn).id)
          if (turnId && !this.completedTurns.has(turnId)) this.activeTurn = turnId
        }
      }
      if (request.method === '_session/steering' && result.outcome === 'injected') this.submitted(id, request.params?.prompt, time)
      if (request.method === 'turn/steer' && !message.error) this.submitted(id, request.params?.input, time)
      if (result.configOptions || result.modes || request.method === 'model/list') this.emit({ type: 'config.updated', configOptions: this.config }, time)
      return
    }
    if (message.id !== undefined && message.method) {
      this.decisions.set(id, message)
      this.decisionTimes.set(id, time)
      this.announceDecision(id, message, time)
      return
    }
    if (this.kind === 'acp' && message.method === 'session/update') this.acpUpdate(params, time)
    if (this.kind === 'codex-app-server') this.codexUpdate(message.method ?? '', params, time)
  }

  private decisionChild(params: Record<string, unknown>): string | undefined | null {
    const threadId = string(params.threadId, string(params.sessionId))
    if (!threadId || threadId === this.nativeId) return undefined
    return this.children.has(threadId) ? threadId : null
  }

  private announceDecision(id: string, request: RemoteRpcMessage, time: string): void {
    if (this.announcedDecisions.has(id)) return
    const params = request.params ?? {}
    const childId = this.decisionChild(params)
    // An App Server request from a thread that has not been classified must
    // never appear as a parent request. Discovery retries it against that exact
    // thread without answering it automatically.
    if (childId === null) return
    if (request.method === 'session/request_permission') {
      const call = record(params.toolCall)
      const options = records(params.options).map((option) => ({ id: string(option.optionId), label: string(option.name), kind: string(option.kind) as 'allow_once' }))
      this.emit({ type: 'permission.requested', requestId: id, toolCallId: string(call.toolCallId), title: string(call.title, 'Permission requested'), options }, time, childId)
    } else if (request.method === 'elicitation/create' && params.mode === 'form' && isRecord(params.requestedSchema)) {
      this.emit({ type: 'input.requested', requestId: id, message: string(params.message), schema: params.requestedSchema }, time, childId)
    } else if (request.method?.endsWith('/requestApproval')) {
      this.emit({ type: 'permission.requested', requestId: id, toolCallId: string(params.itemId), title: string(params.reason, string(params.command, 'Permission requested')),
        options: [{ id: 'accept', label: 'Allow once', kind: 'allow_once' }, { id: 'decline', label: 'Decline', kind: 'reject_once' }] }, time, childId)
    } else if (request.method === 'item/tool/requestUserInput') {
      this.emit({ type: 'input.requested', requestId: id, message: 'Your input is needed', schema: inputSchema(params) }, time, childId)
    } else return
    this.announcedDecisions.add(id)
  }

  private discoverPendingChildren(): void {
    let changed = true
    while (changed) {
      changed = false
      for (const [id, pending] of this.pendingThreads) {
        if (!this.discoverChild(pending.thread, pending.time, pending.fallback)) continue
        this.pendingThreads.delete(id)
        changed = true
      }
    }
  }

  private discoverChild(thread: Record<string, unknown>, time: string, fallback?: { parent: string; prompt?: string; title?: string; model?: string; effort?: string }): boolean {
    const id = string(thread.id)
    const parent = nativeParent(thread) ?? fallback?.parent
    if (!id || !parent || id === this.nativeId) return false
    if (parent !== this.nativeId && !this.children.has(parent)) {
      this.pendingThreads.set(id, { thread, time, ...(fallback ? { fallback } : {}) })
      return false
    }
    if (this.children.has(id)) return true
    const turnId = this.children.get(parent)?.turnId ?? this.activeTurn
    this.children.set(id, { parent, kind: 'subagent', canStop: true,
      permissionMode: this.children.get(parent)?.permissionMode ?? this.turnPermissionMode, ...(turnId ? { turnId } : {}) })
    this.emit({ type: 'task.started', taskId: id, parentSessionId: parent,
      title: fallback?.title || childTitle(thread), prompt: fallback?.prompt ?? string(thread.preview), canStop: true,
      ...(string(thread.model, fallback?.model) ? { model: string(thread.model, fallback?.model) } : {}),
      ...(string(thread.reasoningEffort, fallback?.effort) ? { effort: string(thread.reasoningEffort, fallback?.effort) } : {}),
      taskKind: 'subagent', ...(turnId ? { turnId } : {}) }, time)
    for (const [decisionId, decision] of this.decisions) {
      if (this.decisionChild(decision.params ?? {}) === id) this.announceDecision(decisionId, decision, this.decisionTimes.get(decisionId) ?? time)
    }
    return true
  }

  private discoverCollab(item: Record<string, unknown>, parentThreadId: string, time: string): void {
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string' && !!value) : []
    const sender = string(item.senderThreadId, parentThreadId)
    if (sender !== this.nativeId && !this.children.has(sender)) return
    for (const id of receivers) {
      const model = string(item.model), effort = string(item.reasoningEffort)
      if (this.children.has(id) && (model || effort)) this.emit({ type: 'task.updated', taskId: id,
        ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, time)
      this.discoverChild({ id }, time, { parent: sender, prompt: string(item.prompt), title: 'Subagent',
        ...(model ? { model } : {}), ...(effort ? { effort } : {}) })
    }
    this.discoverPendingChildren()
  }

  private updateCollabChildren(item: Record<string, unknown>, time: string): void {
    const ids = item.type === 'subAgentActivity' ? [string(item.agentThreadId)]
      : Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string') : []
    for (const id of ids) {
      if (!this.children.has(id)) continue
      const state = record(record(item.agentsStates)[id])
      const status = item.type === 'subAgentActivity'
        ? item.kind === 'completed' ? 'done' : item.kind === 'interrupted' ? 'stopped' : 'working'
        : collabStatus[string(state.status)]
      if (status) this.emit({ type: 'task.updated', taskId: id, status,
        ...(string(state.message) ? { summary: string(state.message) } : {}) }, time)
    }
  }

  private answered(request: RemoteRpcMessage, result: Record<string, unknown>): { answer?: { message: string; values: string[] } } {
    if (request.method !== 'elicitation/create' && request.method !== 'item/tool/requestUserInput') return {}
    const values = request.method === 'item/tool/requestUserInput'
      ? Object.values(record(result.answers)).flatMap((value) => Array.isArray(record(value).answers) ? record(value).answers as string[] : [])
      : Object.values(record(result.content)).filter((value) => value !== undefined && value !== '').map((value) => Array.isArray(value) ? value.join(', ') : String(value))
    const message = string(request.params?.message, records(request.params?.questions).map((question) => string(question.question)).join('\n'))
    return { answer: { message, values: values.length ? values : ['Skipped'] } }
  }

  private submitted(id: string, input: unknown, time: string): void {
    const parts: AgentPromptPart[] = records(input).flatMap((part): AgentPromptPart[] => {
      if (part.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text }]
      if (part.type === 'image' && typeof part.data === 'string') return [{ type: 'image', data: part.data, mimeType: string(part.mimeType, 'image/png') }]
      if (part.type === 'image' && typeof part.url === 'string') {
        const match = /^data:([^;]+);base64,(.+)$/s.exec(part.url)
        if (match) return [{ type: 'image', data: match[2]!, mimeType: match[1]! }]
      }
      return []
    })
    this.emit({ type: 'message.submitted', messageId: id, ...(this.activeTurn ? { turnId: this.activeTurn } : {}), input: parts }, time)
  }

  private acpUpdate(params: Record<string, unknown>, time: string): void {
    const parsedChild = childNotification.safeParse(params)
    if (parsedChild.success) {
      const { sessionId, update } = parsedChild.data
      const taskId = 'subagentSessionId' in update ? update.subagentSessionId : update.asyncTaskId
      if (update.sessionUpdate === 'subagent_spawned' || update.sessionUpdate === 'async_task_spawned') {
        const kind = update.sessionUpdate === 'subagent_spawned' ? 'subagent' : 'background'
        const canStop = update.sessionUpdate === 'subagent_spawned' ? update.capabilities.cancel === true : update.canStop
        const turnId = this.activeTurn
        this.children.set(taskId, { parent: sessionId, kind, canStop, permissionMode: this.children.get(sessionId)?.permissionMode ?? this.turnPermissionMode, ...(turnId ? { turnId } : {}) })
        this.emit({ type: 'task.started', taskId, parentSessionId: sessionId, title: update.name, canStop, taskKind: kind,
          prompt: update.sessionUpdate === 'subagent_spawned' ? update.task : update.description, ...(turnId ? { turnId } : {}) }, time)
      } else {
        const state = 'state' in update ? update.state : undefined
        const status = state === 'completed' ? 'done' : state === 'paused' ? 'waiting' : state === 'running' ? 'working'
          : state === 'cancelled' || state === 'stopped' ? 'stopped' : state ? 'failed' : undefined
        this.emit({ type: 'task.updated', taskId, ...(status ? { status } : {}), ...('summary' in update && update.summary ? { summary: update.summary } : {}) }, time)
      }
      return
    }
    const update = record(params.update) as unknown as acp.SessionUpdate
    const childId = this.children.has(string(params.sessionId)) ? string(params.sessionId) : undefined
    const turnId = childId ? this.children.get(childId)?.turnId : this.activeTurn
    const emit = (event: RemoteEvent) => this.emit(event, time, childId)
    const turn = turnId ? { turnId } : {}
    if (update.sessionUpdate === 'config_option_update') { this.config = configOptions(update); emit({ type: 'config.updated', configOptions: this.config }); return }
    if (update.sessionUpdate === 'current_mode_update') {
      const mode = this.config.find((option) => option.category === 'mode')
      if (mode) { mode.currentValue = update.currentModeId; emit({ type: 'config.updated', configOptions: this.config }) }
      return
    }
    if (update.sessionUpdate === 'usage_update') { emit({ type: 'usage.updated', used: update.used, size: update.size, ...(update.cost ? { cost: update.cost } : {}) }); return }
    if (update.sessionUpdate === 'available_commands_update') { emit({ type: 'commands.updated', commands: update.availableCommands }); return }
    // Prompt input is already recorded. Agent echoes would duplicate user bubbles.
    if (update.sessionUpdate === 'user_message_chunk') return
    const content = updateContent(update)
    if (content) { emit({ type: 'message.delta', ...turn, role: update.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'agent', content,
      ...('messageId' in update && update.messageId ? { messageId: update.messageId } : {}) }); return }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const key = `${params.sessionId}:${update.toolCallId}`
      if (update.title) this.titles.set(key, update.title)
      emit({ type: update.sessionUpdate === 'tool_call' ? 'tool.started' : 'tool.updated', ...turn,
        toolCallId: update.toolCallId, title: this.titles.get(key) ?? 'Tool call',
        ...(update.content ? { content: toolContent(update.content) ?? '', files: toolFiles(update.content) ?? [] } : {}),
        ...(update.status ? { status: update.status } : {}), ...(update.kind ? { kind: update.kind } : {}) })
    } else if (update.sessionUpdate === 'plan') emit({ type: 'plan.updated', ...turn, entries: update.entries })
  }

  private codexModels(result: Record<string, unknown>): void {
    const models = this.modelCatalog = records(result.data)
    const model = models.find((item) => item.isDefault === true) ?? models[0]
    if (!model) return
    this.config = [{ id: 'model', name: 'Model', category: 'model', currentValue: string(model.model, string(model.id)),
      options: models.map((item) => ({ value: string(item.model, string(item.id)), name: string(item.displayName, string(item.model)) })) }]
    this.selectCodexModel(string(model.model, string(model.id)))
  }

  selectCodexModel(value: string): void {
    const model = this.modelCatalog.find((item) => string(item.model, string(item.id)) === value)
    if (!model) return
    const options = records(model.supportedReasoningEfforts).map((item) => ({ value: string(item.reasoningEffort), name: string(item.reasoningEffort) }))
    const previous = this.config.find((option) => option.id === 'effort')?.currentValue
    const currentValue = previous && options.some((option) => option.value === previous) ? previous : string(model.defaultReasoningEffort, 'medium')
    this.config = this.config.filter((option) => option.id !== 'effort')
    this.config.push({ id: 'effort', name: 'Reasoning', category: 'thought_level', currentValue, options })
  }

  private commandContent(key: string, output: string): string {
    const command = this.commands.get(key)
    return command ? [command, output].filter(Boolean).join('\n\n') : output
  }

  private codexUpdate(method: string, params: Record<string, unknown>, time: string): void {
    if (method === 'thread/started') {
      const thread = record(params.thread)
      const id = string(thread.id)
      if (id && nativeParent(thread)) {
        this.pendingThreads.set(id, { thread, time })
        this.discoverPendingChildren()
      }
      return
    }
    const threadId = string(params.threadId)
    const childId = this.children.has(threadId) ? threadId : undefined
    const rootEvent = !threadId || threadId === this.nativeId
    const turn = record(params.turn)
    if (method === 'turn/started') {
      const turnId = string(turn.id)
      if (childId) {
        const child = this.children.get(childId)!
        child.activeTurn = turnId
        this.emit({ type: 'task.updated', taskId: childId, status: 'working' }, time)
      } else if (rootEvent) {
        this.activeTurn = turnId
        this.emit({ type: 'turn.started', turnId }, time)
      }
    } else if (method === 'turn/completed') {
      if (childId) {
        const child = this.children.get(childId)!
        const turnId = string(turn.id, child.activeTurn)
        if (!child.activeTurn || !turnId || child.activeTurn === turnId) {
          delete child.activeTurn
          const status = turn.status === 'failed' ? 'failed' : turn.status === 'interrupted' ? 'stopped' : 'done'
          this.emit({ type: 'task.updated', taskId: childId, status,
            ...(turn.status === 'failed' && string(record(turn.error).message) ? { summary: string(record(turn.error).message) } : {}) }, time)
        }
      } else if (rootEvent) {
        const turnId = string(turn.id, this.activeTurn)
        this.completedTurns.add(turnId)
        if (turn.status === 'failed') this.emit({ type: 'turn.failed', turnId, message: string(record(turn.error).message, 'Remote turn failed') }, time)
        else this.emit({ type: 'turn.completed', turnId, stopReason: turn.status === 'interrupted' ? 'cancelled' : 'end_turn' }, time)
        if (!this.activeTurn || !turnId || this.activeTurn === turnId) this.activeTurn = undefined
      }
    } else if (method === 'thread/status/changed' && childId) {
      const status = record(params.status)
      if (status.type === 'systemError') this.emit({ type: 'task.updated', taskId: childId, status: 'failed' }, time)
      else if (status.type === 'active') {
        const waiting = Array.isArray(status.activeFlags) && status.activeFlags.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')
        this.emit({ type: 'task.updated', taskId: childId, status: waiting ? 'waiting' : 'working' }, time)
      }
    } else if (method === 'thread/closed' && childId) {
      delete this.children.get(childId)!.activeTurn
      this.emit({ type: 'task.updated', taskId: childId, status: 'stopped' }, time)
    } else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      if (!rootEvent && !childId) return
      const displayTurn = childId ? this.children.get(childId)?.turnId : this.activeTurn
      this.emit({ type: 'message.delta', ...(displayTurn ? { turnId: displayTurn } : {}), messageId: string(params.itemId),
        role: method === 'item/agentMessage/delta' ? 'agent' : 'thought', content: { type: 'text', text: string(params.delta) } }, time, childId)
    } else if (method === 'thread/tokenUsage/updated') {
      if (!rootEvent && !childId) return
      const usage = record(params.tokenUsage), last = record(usage.last)
      if (typeof last.totalTokens === 'number' && typeof usage.modelContextWindow === 'number') this.emit({ type: 'usage.updated', used: last.totalTokens, size: usage.modelContextWindow }, time, childId)
    } else if (method === 'turn/plan/updated') {
      if (!rootEvent && !childId) return
      this.emit({ type: 'plan.updated', entries: records(params.plan).map((step) => ({ content: string(step.step), status: string(step.status) as 'pending', priority: 'medium' })) }, time, childId)
    } else if (method === 'item/commandExecution/outputDelta') {
      if (!rootEvent && !childId) return
      const id = string(params.itemId)
      const key = `${threadId || this.nativeId}:${id}`
      const output = ((this.output.get(key) ?? '') + string(params.delta)).slice(-40_000)
      this.output.set(key, output)
      this.emit({ type: 'tool.updated', toolCallId: id, title: this.titles.get(key) ?? 'Ran a command', content: this.commandContent(key, output), kind: 'execute' }, time, childId)
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = record(params.item)
      if (item.type === 'collabAgentToolCall') this.discoverCollab(item, threadId, time)
      else if (item.type === 'subAgentActivity' && string(item.agentThreadId)) {
        this.discoverChild({ id: string(item.agentThreadId) }, time, { parent: threadId, title: string(item.agentPath, 'Subagent') })
        this.discoverPendingChildren()
      }
      if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') this.updateCollabChildren(item, time)
      const routedChild = this.children.has(threadId) ? threadId : undefined
      if ((!rootEvent && !routedChild) || ['agentMessage', 'reasoning', 'userMessage'].includes(string(item.type))) return
      const id = string(item.id)
      const key = `${threadId || this.nativeId}:${id}`
      const command = item.type === 'commandExecution'
      const title = command ? commandTitle(item) : item.type === 'fileChange' ? 'Files' : toolTitle(item)
      if (command && typeof item.command === 'string') this.commands.set(key, item.command)
      const content = command
        ? this.commandContent(key, string(item.aggregatedOutput, this.output.get(key) ?? ''))
        : JSON.stringify(item, null, 2)
      this.titles.set(key, title)
      this.emit({ type: method === 'item/started' ? 'tool.started' : 'tool.updated', toolCallId: id, title,
        status: method === 'item/started' ? 'in_progress' : item.status === 'failed' ? 'failed' : 'completed',
        kind: item.type === 'commandExecution' ? 'execute' : string(item.type),
        ...(item.type === 'fileChange' ? { patches: records(item.changes).map((file) => ({ path: string(file.path), diff: string(file.diff), kind: string(record(file.kind).type, 'update') })) } : {}),
        content }, time, routedChild)
    }
  }
}
