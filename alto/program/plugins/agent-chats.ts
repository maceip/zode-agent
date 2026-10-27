import type {} from './conversation-titles-api.js'
import type { TurnProgram } from '../../src/server/services/turn-program.js'
import { applyAgentChatEvent } from './agent-chat-events.js'
import { AgentChatStore } from './agent-chat-store.js'
import { AgentToolBridge, type AgentToolContext } from './agent-tool-bridge.js'
import { taskActive, type AgentTask } from './orchestrator-api.js'
import type { ThreadHistoryPage } from '../../src/shared/protocol.js'
import { turnInputsFor } from '../../src/server/services/turn-input.js'
import type { ClientDraft } from '../../src/client/plugin-api.js'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { AgentEvent, AgentPromptOptions, AgentPromptPart, AgentRegistry } from '../../src/server/services/agent-registry.js'
import type { Context } from 'cordis'
import { errorMessage, isRecord, type JsonValue, type PermissionMode, type ThreadSummary } from '../../src/shared/protocol.js'
import { AGENT_CHATS_STATE, agentChatStateKey, isAgentChatId, type AgentChat, agentPromptInput } from './agent-chats-api.js'
import type { RemoteWorkspace } from './remote-workspace-api.js'

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue
// Child history is fetched through orchestrator.open. Broadcasting it with every
// chat update can fill the harness socket buffer and disconnect the entire UI.
function clientChat(chat: AgentChat): AgentChat {
  return { ...chat, ...(chat.children ? {
    children: chat.children.map((child) => ({ ...child, task: taskPreview(child.task), activities: [] })),
  } : {}) }
}

// Match the native agent monitor's preview limit; full output stays in history.
function taskPreview(task: AgentTask): AgentTask {
  return { ...task, activity: task.activity.slice(0, 16_000), result: task.result.slice(0, 16_000) }
}

function historyChatId(providerId: string, sessionId: string): string {
  const hex = createHash('sha256').update(JSON.stringify([providerId, sessionId])).digest('hex').slice(0, 32)
  return `acp-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const permissionMode = (value: unknown): PermissionMode => value === 'full' || value === 'auto' ? value : 'ask'
function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value
}

export class AgentChats {
  private readonly chats = new Map<string, AgentChat>()
  private readonly store: AgentChatStore
  private readonly loading = new Map<string, Promise<AgentChat>>()
  private active = true
  private discovered = new Map<string, AgentChat['summary']>()
  private historyRefresh: Promise<void> | undefined
  private historyProblems: string[] = []
  private readonly queueStarting = new Set<string>()
  private readonly steering = new Set<string>()
  private readonly starting = new Map<string, Promise<void>>()

  constructor(
    private readonly agents: AgentRegistry,
    directory: string,
    private readonly changed: (chat?: AgentChat) => void,
    private readonly bridge?: AgentToolBridge,
    private readonly turnProgram?: Pick<TurnProgram, 'prepare'>,
    private readonly historyProviders: readonly string[] = ['claude'],
  ) {
    this.store = new AgentChatStore(directory, (chat, error) => {
      chat.problem = `Could not save this chat: ${errorMessage(error)}`
      this.publish(chat)
    })
  }

  load(): Promise<void> { return this.store.load() }

  threads(): ThreadSummary[] {
    const threads = new Map<string, ThreadSummary>()
    for (const thread of [...this.discovered.values(), ...this.store.threads()]) {
      const key = JSON.stringify([thread.providerId, thread.providerSessionId])
      const previous = threads.get(key)
      threads.set(key, { ...thread, updatedAt: Math.max(thread.updatedAt, previous?.updatedAt ?? 0) })
    }
    return [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  historyErrors(): string[] { return [...this.historyProblems] }

  refreshHistory(): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (this.historyRefresh) return this.historyRefresh
    this.historyRefresh = (async () => {
      const problems: string[] = []
      for (const providerId of this.historyProviders) {
        if (!this.active) return
        const snapshot = this.agents.snapshot().find((provider) => provider.id === providerId && provider.protocol === 'acp')
        if (!snapshot) continue
        const provider = this.agents.provider(providerId)
        if (!provider.listSessions) continue
        try {
          const discovered = new Map<string, AgentChat['summary']>()
          const saved = this.store.threads().filter((thread) => thread.providerId === providerId)
          const savedIds = new Map(saved.map((thread) => [thread.providerSessionId, thread.id]))
          const cursors = new Set<string>()
          let cursor: string | undefined
          do {
            const page = await provider.listSessions(cursor ? { cursor } : {})
            if (!this.active || this.agents.provider(providerId) !== provider) return
            for (const session of page.sessions) {
              if (!session.id || !path.isAbsolute(session.cwd)) continue
              const timestamp = session.updatedAt ? Date.parse(session.updatedAt) / 1000 : 0
              const updatedAt = Number.isFinite(timestamp) ? Math.floor(timestamp) : 0
              const id = savedIds.get(session.id) ?? historyChatId(providerId, session.id)
              discovered.set(id, { id, providerId, providerSessionId: session.id, cwd: session.cwd,
                title: session.title?.trim() || `${snapshot.label} chat`, preview: '', createdAt: updatedAt, updatedAt })
            }
            cursor = page.nextCursor
            if (cursor && cursors.has(cursor)) throw new Error('The agent repeated a history page')
            if (cursor) cursors.add(cursor)
          } while (cursor)
          for (const [id, thread] of this.discovered) if (thread.providerId === providerId) this.discovered.delete(id)
          for (const [id, thread] of discovered) this.discovered.set(id, thread)
        } catch (error) {
          if (!this.active) return
          problems.push(`${snapshot.label} history: ${errorMessage(error)}`)
        }
      }
      if (!this.active) return
      this.historyProblems = problems
      this.changed()
    })().finally(() => { this.historyRefresh = undefined })
    return this.historyRefresh
  }

  /** Metadata inspection must not open or resume a saved remote conversation. */
  async workspace(id: string): Promise<RemoteWorkspace | undefined> {
    const chat = this.chats.get(id) ?? await this.store.read(id)
    if (!chat.remote) return undefined
    const provider = this.agents.provider(chat.summary.providerId)
    const workspace = await provider.workspaceInfo?.(chat.summary.providerSessionId) ?? chat.remote.workspace
    const current = this.chats.get(id)
    if (this.active && current?.remote && workspace
      && JSON.stringify(current.remote.workspace) !== JSON.stringify(workspace)) {
      current.remote.workspace = workspace
      this.changed(current)
    }
    return workspace
  }

  providersChanged(): void {
    for (const chat of this.chats.values()) {
      if (chat.turn === 'idle') continue
      let connected = false
      try { connected = this.agents.provider(chat.summary.providerId).snapshot().activeSessionIds.includes(chat.summary.providerSessionId) }
      catch { /* An unloaded provider no longer appears in the registry. */ }
      if (chat.remote) { if (!connected) { chat.remote.state = 'disconnected'; this.publish(chat) }; continue }
      if (!connected) this.event({ type: 'turn.failed', providerId: chat.summary.providerId,
        sessionId: chat.summary.providerSessionId, turnId: chat.turnId ?? '',
        message: 'The agent disconnected. Send another message to resume this chat.', occurredAt: new Date().toISOString() })
    }
  }

  private async promptOptions(id: string, cwd: string): Promise<AgentPromptOptions | undefined> {
    if (!this.turnProgram) return undefined
    const prepared = await this.turnProgram.prepare({ threadId: id, cwd, input: [] })
    if (prepared.cwd && prepared.cwd !== cwd) throw new Error('Open a new ACP pane to change its working directory.')
    return { additionalContext: prepared.additionalContext ?? {} }
  }

  async create(providerId: string, cwd: string, mode: PermissionMode): Promise<AgentChat> {
    if (!this.active) throw new Error('Agent chats is unavailable')
    const provider = this.agents.provider(providerId)
    if (provider.snapshot().protocol === 'codex-app-server') throw new Error('Choose an ACP provider')
    const id = `acp-${randomUUID()}`
    let session
    try { session = await provider.createSession({ cwd, permissionMode: mode, ...(provider.snapshot().capabilities?.durableSession ? {} : await this.promptOptions(id, cwd)), mcpServers: provider.snapshot().capabilities?.durableSession ? [] : await this.bridge?.attach(id) ?? [] }) }
    catch (error) { this.bridge?.revoke(id); throw error }
    if (!this.active) {
      await provider.closeSession(session.id)
      throw new Error('Agent chats was closed')
    }
    const timestamp = Math.floor(Date.now() / 1000)
    const chat: AgentChat = {
      summary: { id, providerId, providerSessionId: session.id,
        cwd, title: `New ${provider.snapshot().label} chat`, preview: '', createdAt: timestamp, updatedAt: timestamp },
      ...(provider.snapshot().capabilities?.durableSession ? { remote: { state: 'connected' as const, ...(session.workspaceName ? { workspaceName: session.workspaceName } : {}), ...(session.workspace ? { workspace: session.workspace } : {}) } } : {}),
      permissionMode: mode, turn: 'idle', activities: [], requests: [], configOptions: session.configOptions ?? [],
    }
    this.chats.set(chat.summary.id, chat)
    this.publish(chat)
    await this.store.save(chat)
    return chat
  }

  async open(id: string): Promise<AgentChat> {
    if (!isAgentChatId(id) || (!this.store.has(id) && !this.discovered.has(id))) throw new Error('Agent chat was not found')
    const cached = this.chats.get(id)
    if (cached && cached.historyLoaded !== false && (!cached.remote || cached.remote.state !== 'disconnected')) return cached
    const pending = this.loading.get(id)
    if (pending) return pending
    const loading = (async () => {
      const discovered = this.discovered.get(id)
      const chat: AgentChat = cached ?? (this.store.has(id) ? await this.store.read(id) : {
        summary: { ...discovered! }, historyLoaded: false,
        permissionMode: 'ask', turn: 'idle', activities: [], requests: [], queuePaused: true,
      })
      if (!this.active) throw new Error('Agent chats is unavailable')
      if (chat.remote) {
        chat.remote.state = 'connecting'
        chat.queuePaused = true
        this.chats.set(id, chat)
        try { await this.resume(chat) }
        catch (error) { chat.remote.state = 'disconnected'; chat.remote.message = errorMessage(error) }
      } else {
        chat.turn = 'idle'
        for (const child of chat.children ?? []) if (taskActive(child.task)) { child.task.status = 'stopped'; child.task.activity = 'Alto restarted' }
        chat.queuePaused = true
        chat.requests = []
        for (const activity of chat.activities) {
          if (activity.status === 'streaming' || activity.status === 'in_progress') activity.status = 'interrupted'
        }
        this.chats.set(id, chat)
      }
      if (chat.historyLoaded === false) {
        try {
          await this.resume(chat)
          if (!this.active) throw new Error('Agent chats was closed')
          chat.historyLoaded = true
          delete chat.problem
          this.store.updateSummary(chat)
          await this.store.save(chat)
        } catch (error) { chat.problem = errorMessage(error) }
      }
      this.publish(chat, false)
      return chat
    })().finally(() => this.loading.delete(id))
    this.loading.set(id, loading)
    return loading
  }

  private async resume(chat: AgentChat): Promise<void> {
    const provider = this.agents.provider(chat.summary.providerId)
    const sessionId = chat.summary.providerSessionId
    if (provider.snapshot().activeSessionIds.includes(sessionId)) return
    if (!provider.loadSession) throw new Error('This agent cannot resume saved chats')
    if (provider.snapshot().capabilities?.durableSession) {
      const session = await provider.loadSession(sessionId, { cwd: chat.summary.cwd, permissionMode: chat.permissionMode })
      if (!this.active) { await provider.closeSession(sessionId); throw new Error('Agent chats was closed') }
      if (chat.remote && session.workspaceName) chat.remote.workspaceName = session.workspaceName
      if (chat.remote && session.workspace) chat.remote.workspace = session.workspace
      return
    }
    const desired = chat.configOptions ?? []
    const session = await provider.loadSession(sessionId, { cwd: chat.summary.cwd, permissionMode: chat.permissionMode, ...await this.promptOptions(chat.summary.id, chat.summary.cwd), mcpServers: await this.bridge?.attach(chat.summary.id) ?? [] })
    if (!this.active) { await provider.closeSession(sessionId); throw new Error('Agent chats was closed') }
    chat.configOptions = session.configOptions ?? []
    for (const option of desired) {
      const current = chat.configOptions.find((candidate) => candidate.id === option.id)
      if (!current || current.currentValue === option.currentValue || !provider.configure) continue
      if (!current.options.some((candidate) => candidate.value === option.currentValue)) continue
      chat.configOptions = await provider.configure(sessionId, option.id, option.currentValue)
    }
    chat.configurationRevision = (chat.configurationRevision ?? 0) + 1
    this.publish(chat, false)
  }

  async send(id: string, input: AgentPromptPart[], mode: PermissionMode): Promise<void> {
    const chat = await this.open(id)
    if (!this.active || chat.turn !== 'idle' || this.starting.has(id)) throw new Error('This chat already has an active turn')
    if (!input.length) throw new Error('Write a message first')
    const operation = (async () => {
      chat.permissionMode = mode
      chat.turnPermissionMode = mode
      chat.queuePaused = false
      await this.resume(chat)
      if (!this.active) throw new Error('Agent chats is unavailable')
      const provider = this.agents.provider(chat.summary.providerId)
      provider.setPermissionMode?.(chat.summary.providerSessionId, mode)
      const text = input.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      if (!chat.activities.length) chat.summary.title = text.slice(0, 100) || 'New chat'
      chat.summary.preview = text.slice(0, 200)
      if (!chat.remote) chat.activities.push({ id: `user:${randomUUID()}`, threadId: id, kind: 'user', title: 'You',
        content: text, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), createdAtMs: Date.now(),
        images: input.flatMap((part) => part.type === 'image'
          ? [{ name: 'Image', mediaType: part.mimeType, url: `data:${part.mimeType};base64,${part.data}` }] : []),
      })
      chat.turn = 'sending'
      delete chat.problem
      this.publish(chat)
      await this.store.save(chat)
      if (!this.active) throw new Error('Agent chats is unavailable')
      const options = chat.remote ? undefined : await this.promptOptions(id, chat.summary.cwd)
      if (!this.active) throw new Error('Agent chats is unavailable')
      if (options) await provider.prompt(chat.summary.providerSessionId, input, options)
      else await provider.prompt(chat.summary.providerSessionId, input)
    })()
    this.starting.set(id, operation)
    try { await operation }
    catch (error) {
      // Recorded input may have started the remote turn before delivery failed.
      if (!chat.remote || (chat as AgentChat).turn === 'sending') chat.turn = 'idle'
      chat.problem = errorMessage(error)
      this.publish(chat)
      await this.store.save(chat)
      throw error
    } finally { this.starting.delete(id) }
  }

  toolContext(id: string): AgentToolContext | undefined {
    const chat = this.chats.get(id)
    if (!this.active || !chat || chat.turn !== 'running' || !chat.turnId) return undefined
    // Claude shares one MCP connection with its children. An older child must
    // not inherit Full access when the user starts a later, more privileged turn.
    const olderChild = chat.children?.some((child) => taskActive(child.task) && child.task.turnId !== chat.turnId)
    return { threadId: id, turnId: chat.turnId, permissionMode: olderChild ? 'ask' : chat.turnPermissionMode ?? 'ask' }
  }

  async steer(id: string, input: AgentPromptPart[]): Promise<void> {
    const chat = await this.open(id)
    if (!input.length) throw new Error('Write a message first')
    if (this.steering.has(id)) throw new Error('A steering message is already being sent')
    if (chat.turn === 'idle') return this.send(id, input, chat.permissionMode)
    const provider = this.agents.provider(chat.summary.providerId)
    if (!provider.steer) throw new Error('This agent does not support live steering')
    this.steering.add(id)
    const messageId = `user:${randomUUID()}`
    if (!chat.remote) chat.activities.push({ id: messageId, threadId: id, ...(chat.turnId ? { turnId: chat.turnId } : {}), kind: 'user', title: 'You', continuesTurn: true,
      content: input.filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
      images: input.flatMap((part) => part.type === 'image' ? [{ name: 'Image', mediaType: part.mimeType, url: `data:${part.mimeType};base64,${part.data}` }] : []),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), createdAtMs: Date.now() })
    this.publish(chat)
    try {
      const options = chat.remote ? undefined : await this.promptOptions(id, chat.summary.cwd)
      if (!this.active) throw new Error('Agent chats is unavailable')
      const outcome = options
        ? await provider.steer(chat.summary.providerSessionId, input, options)
        : await provider.steer(chat.summary.providerSessionId, input)
      if (outcome === 'promptRequired') {
        chat.activities = chat.activities.filter((item) => item.id !== messageId)
        await this.starting.get(id)
        await this.send(id, input, chat.permissionMode)
      }
    } catch (error) {
      chat.activities = chat.activities.filter((item) => item.id !== messageId)
      throw error
    } finally {
      this.steering.delete(id)
      this.publish(chat)
      await this.store.save(chat)
      void this.startQueued(chat)
    }
  }

  tasks(): AgentTask[] { return [...this.chats.values()].flatMap((chat) => (chat.children ?? []).map((child) => taskPreview(child.task))) }

  async taskHistory(id: string, taskId: string): Promise<ThreadHistoryPage> {
    const chat = await this.open(id)
    const child = chat.children?.find((child) => child.task.id === taskId)
    if (!child) throw new Error('Agent was not found in this chat')
    return { messages: child.activities.map((item) => ({ id: item.id, role: item.kind === 'user' ? 'user' : 'agent',
      text: item.kind === 'user' || item.kind === 'agent' ? item.content : '',
      ...(!['user', 'agent'].includes(item.kind) ? { tracesBefore: [{ id: item.id, kind: item.kind === 'reasoning' ? 'reasoning' : 'tool', title: item.title, text: item.content }] } : {}) })) }
  }

  async stopTask(id: string, taskId?: string): Promise<void> {
    const chat = await this.open(id)
    if (!taskId) { await this.cancel(id); return }
    const child = chat.children?.find((child) => child.task.id === taskId)
    if (!child || !taskActive(child.task)) throw new Error('This agent is no longer active')
    if (!child.task.canStop) throw new Error('Stop the parent turn to stop this agent')
    const provider = this.agents.provider(chat.summary.providerId)
    if (!provider.stopTask) throw new Error('This agent does not support stopping tasks')
    await provider.stopTask(chat.summary.providerSessionId, child.sessionId)
  }

  async cancel(id: string): Promise<void> {
    const chat = await this.open(id)
    chat.queuePaused = true
    this.publish(chat)
    await this.store.save(chat)
    await this.agents.cancel(chat.summary.providerId, chat.summary.providerSessionId)
  }

  async approve(id: string, requestId: string, optionId: string): Promise<void> {
    const chat = await this.open(id)
    if (!chat.requests.some((request) => request.id === requestId)) throw new Error('This permission request is no longer pending')
    const provider = this.agents.provider(chat.summary.providerId)
    if (!provider.resolvePermission) throw new Error('This agent cannot receive approval decisions')
    await provider.resolvePermission(requestId, optionId)
  }

  async queue(id: string, operation: string, payload: Record<string, unknown>): Promise<unknown> {
    const chat = await this.open(id)
    const queue = chat.queue ??= []
    const item = () => {
      const found = queue.find((entry) => entry.id === payload.queuedSubmissionId)
      if (!found) throw new Error('Queued message was not found')
      return found
    }
    const draft = (): ClientDraft => {
      if (!isRecord(payload.draft) || typeof payload.draft.text !== 'string'
        || !Array.isArray(payload.draft.images) || !Array.isArray(payload.draft.attachments) || !Array.isArray(payload.draft.skills)) throw new Error('Invalid queued message')
      const value = payload.draft as unknown as ClientDraft
      if (!agentPromptInput(value).length) throw new Error('Write a message first')
      return structuredClone(value)
    }
    const wire = (entry: typeof queue[number]) => ({ id: entry.id, input: turnInputsFor(entry.draft) })
    if (operation === 'list') return queue.map(wire)
    if (operation === 'steer') {
      if (this.queueStarting.has(id)) throw new Error('A queued message is already being delivered')
      const entry = item()
      this.queueStarting.add(id)
      try {
        await this.steer(id, agentPromptInput(entry.draft))
        chat.queue = (chat.queue ?? []).filter((candidate) => candidate.id !== entry.id)
      } finally {
        this.queueStarting.delete(id)
        this.publish(chat)
        await this.store.save(chat)
      }
      void this.startQueued(chat)
      return { ok: true }
    }
    let result: unknown = { ok: true }
    if (operation === 'add') {
      const entry = { id: randomUUID(), draft: draft() }
      queue.push(entry); chat.queuePaused = false; result = wire(entry)
    } else if (operation === 'update') { const entry = item(); entry.draft = draft(); delete entry.error; result = wire(entry) }
    else if (operation === 'delete') chat.queue = queue.filter((entry) => entry !== item())
    else if (operation === 'reorder') {
      const ids = payload.queuedSubmissionIds
      if (!Array.isArray(ids) || ids.length !== queue.length || new Set(ids).size !== queue.length || !ids.every((id) => queue.some((entry) => entry.id === id))) throw new Error('Queue changed; retry reordering')
      chat.queue = ids.map((id) => queue.find((entry) => entry.id === id)!)
    } else if (operation === 'start') {
      if (chat.queuePaused) return result
      if (queue[0]?.id !== payload.queuedSubmissionId) throw new Error('Queue order changed')
      await this.startQueued(chat); return result
    } else throw new Error('Unknown queue operation')
    this.publish(chat)
    await this.store.save(chat)
    if (operation === 'add' && chat.turn === 'idle') await this.startQueued(chat)
    return result
  }

  private async startQueued(chat: AgentChat): Promise<void> {
    const id = chat.summary.id
    if (!this.active || chat.remote?.replaying || (chat.remote && chat.remote.state !== 'connected') || chat.queuePaused || chat.turn !== 'idle' || this.queueStarting.has(id) || this.steering.has(id)) return
    const entry = chat.queue?.[0]
    if (!entry) return
    this.queueStarting.add(id)
    try {
      await this.starting.get(id)
      if (!this.active || chat.turn !== 'idle' || chat.queuePaused) return
      await this.send(id, agentPromptInput(entry.draft), chat.permissionMode)
      chat.queue = (chat.queue ?? []).filter((candidate) => candidate.id !== entry.id)
    } catch (error) {
      entry.error = errorMessage(error)
      chat.queuePaused = true
    } finally {
      this.queueStarting.delete(id)
      this.publish(chat)
      await this.store.save(chat)
    }
  }

  async configure(id: string, configId: string, value: string): Promise<void> {
    const chat = await this.open(id)
    await this.resume(chat)
    const provider = this.agents.provider(chat.summary.providerId)
    if (!provider.configure) throw new Error('This agent does not support configuration')
    chat.configOptions = await provider.configure(chat.summary.providerSessionId, configId, value)
    chat.configurationRevision = (chat.configurationRevision ?? 0) + 1
    this.publish(chat)
    await this.store.save(chat)
  }

  async answer(id: string, requestId: string, response: unknown): Promise<void> {
    const chat = await this.open(id)
    const request = chat.requests.find((request) => request.id === requestId && request.method === 'agent/requestUserInput')
    if (!request) throw new Error('This question is no longer pending')
    const provider = this.agents.provider(chat.summary.providerId)
    if (!provider.resolveInput) throw new Error('This agent cannot receive answers')
    await provider.resolveInput(requestId, response)
    if (chat.remote) return
    const content = isRecord(response) && isRecord(response.content) ? response.content : {}
    const answers = Object.values(content).filter((value) => value !== undefined && value !== '').map((value) => Array.isArray(value) ? value.join(', ') : String(value))
    chat.activities.push({ id: `answer:${requestId}`, threadId: id, ...(chat.turnId ? { turnId: chat.turnId } : {}),
      kind: 'agent', title: 'Answered', content: String(request.params.message ?? ''), delivery: 'async',
      questions: [{ title: String(request.params.message ?? '') }], questionAnswers: [answers.join(' · ') || 'Skipped'],
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), createdAtMs: Date.now() })
    this.publish(chat)
    await this.store.save(chat)
  }

  async rename(id: string, title: string): Promise<void> {
    const chat = await this.open(id)
    chat.summary.title = title.trim().slice(0, 200)
    this.publish(chat)
    await this.store.save(chat)
  }

  event(event: AgentEvent): void {
    if (!this.active || !('sessionId' in event)) return
    const owner = [...this.chats.values()].find((candidate) => candidate.summary.providerId === event.providerId
      && (candidate.summary.providerSessionId === event.sessionId || candidate.children?.some((child) => child.sessionId === event.sessionId)))
    if (!owner) return
    if (!applyAgentChatEvent(owner, event)) return
    if (event.sessionId === owner.summary.providerSessionId && event.type === 'turn.completed' && event.stopReason !== 'cancelled') {
      void this.startQueued(owner)
    }
    if (!owner.replaying && !owner.remote?.replaying) this.record(owner, !['session.replay', 'config.updated', 'commands.updated', 'usage.updated'].includes(event.type))
  }

  private record(chat: AgentChat, touch = true): void {
    this.publish(chat, touch)
    this.store.schedule(chat)
  }

  private publish(chat: AgentChat, touch = true): void {
    if (!this.active) return
    if (touch) chat.summary.updatedAt = Math.floor(Date.now() / 1000)
    this.store.updateSummary(chat)
    this.changed(chat)
  }

  async dispose(): Promise<void> {
    if (!this.active) return
    this.active = false
    // A reloaded chat fiber must not leave an unobserved turn running in its provider.
    await Promise.allSettled([...this.chats.values()].map(async (chat) => {
      chat.queuePaused = true
      try { await this.agents.provider(chat.summary.providerId).closeSession(chat.summary.providerSessionId) }
      finally {
        if (chat.remote) { chat.remote.state = 'disconnected'; this.store.schedule(chat); return }
        chat.turn = 'idle'; chat.requests = []
        for (const item of chat.activities) {
          if (item.status === 'streaming' || item.status === 'in_progress' || item.status === 'pending') item.status = 'interrupted'
        }
        this.store.schedule(chat)
      }
    }))
    await this.store.dispose()
    await this.bridge?.dispose()
  }
}

const plugin = async (ctx: Context, config: { historyProviders?: string[] } = {}) => {
  const agents = ctx.agents
  const extensions = ctx.clientExtensions
  const states = new Map<string, ReturnType<typeof extensions.registerState>>()
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const updates = new Map<string, AgentChat>()
  const catalog = extensions.registerState(ctx, AGENT_CHATS_STATE, { providers: [], threads: [] })
  let catalogValue = ''
  const publishCatalog = () => {
    if (!active) return
    const value = { providers: agents.snapshot().filter((provider) => provider.protocol !== 'codex-app-server'), threads: chats.threads(), historyErrors: chats.historyErrors() }
    const serialized = JSON.stringify(value)
    if (serialized !== catalogValue) { catalogValue = serialized; catalog.update(json(value)) }
  }
  const publish = (chat: AgentChat) => {
    if (!active) return
    const id = chat.summary.id
    const existing = states.get(id)
    if (existing) existing.update(json(clientChat(chat)))
    else states.set(id, extensions.registerState(ctx, agentChatStateKey(id), json(clientChat(chat))))
  }
  const bridge = new AgentToolBridge(ctx.tools, (id) => chats.toolContext(id))
  const chats: AgentChats = new AgentChats(agents, path.join(ctx.program.projectRoot, '.codex-cordis', 'agent-chats'), (chat) => {
    if (!active) return
    if (chat) updates.set(chat.summary.id, chat)
    if (!timer) timer = setTimeout(() => {
      timer = undefined
      for (const chat of updates.values()) publish(chat)
      updates.clear()
      publishCatalog()
      ctx.emit('agent-chats/changed')
    }, 32)
  }, bridge, ctx.turnProgram, config?.historyProviders ?? ['claude'])
  ctx.provide('agentChats', chats)
  ctx.effect(() => () => { active = false; clearTimeout(timer); return chats.dispose() }, 'agentChats.lifetime')
  await chats.load()
  if (!active) return
  publishCatalog()
  void chats.refreshHistory()
  ctx.on('agents/changed', () => { chats.providersChanged(); publishCatalog() })
  ctx.on('agents/event', (event) => chats.event(event))
  const method = (name: string, run: (payload: Record<string, unknown>) => Promise<unknown>) => {
    extensions.registerMethod(ctx, `agent-chats.${name}`, async (payload) => {
      if (!active || !isRecord(payload)) throw new Error('Agent chat request is unavailable')
      return json(await run(payload))
    })
  }
  method('refresh-history', async () => { await chats.refreshHistory(); publishCatalog(); return { errors: chats.historyErrors() } })
  method('workspace-name', async (payload) => {
    const provider = agents.provider(required(payload.providerId, 'providerId'))
    return { name: await provider.workspaceName?.(required(payload.cwd, 'cwd')) ?? null }
  })
  method('workspace', async (payload) => await chats.workspace(required(payload.id, 'id')) ?? null)
  method('create', async (payload) => {
    const chat = await chats.create(required(payload.providerId, 'providerId'), required(payload.cwd, 'cwd'), permissionMode(payload.permissionMode))
    publish(chat); publishCatalog(); return clientChat(chat)
  })
  method('open', async (payload) => { const chat = await chats.open(required(payload.id, 'id')); publish(chat); return clientChat(chat) })
  for (const operation of ['send', 'steer'] as const) method(operation, async (payload) => {
    if (!Array.isArray(payload.input)) throw new Error('Prompt input is required')
    const input: AgentPromptPart[] = payload.input.map((part) => {
      if (!isRecord(part)) throw new Error('Invalid prompt content')
      if (part.type === 'text') return { type: 'text', text: required(part.text, 'text') }
      if (part.type === 'image') return { type: 'image', data: required(part.data, 'data'), mimeType: required(part.mimeType, 'mimeType') }
      if (part.type === 'resource') return { type: 'resource', uri: required(part.uri, 'uri'), name: required(part.name, 'name') }
      throw new Error('Unsupported prompt content')
    })
    const id = required(payload.id, 'id')
    if (operation === 'steer') await chats.steer(id, input)
    else await chats.send(id, input, permissionMode(payload.permissionMode))
    return clientChat(await chats.open(id))
  })
  for (const operation of ['list', 'add', 'update', 'delete', 'reorder', 'start', 'steer']) {
    method(`queue.${operation}`, (payload) => chats.queue(required(payload.threadId, 'threadId'), operation, payload))
  }
  method('configure', async (payload) => {
    const id = required(payload.id, 'id')
    await chats.configure(id, required(payload.configId, 'configId'), required(payload.value, 'value'))
    return { configOptions: (await chats.open(id)).configOptions ?? [] }
  })
  method('answer', async (payload) => {
    await chats.answer(required(payload.id, 'id'), required(payload.requestId, 'requestId'), payload.response); return { ok: true }
  })
  method('cancel', async (payload) => { await chats.cancel(required(payload.id, 'id')); return { ok: true } })
  method('approve', async (payload) => {
    await chats.approve(required(payload.id, 'id'), required(payload.requestId, 'requestId'), required(payload.optionId, 'optionId')); return { ok: true }
  })
  method('rename', async (payload) => {
    const id = required(payload.id, 'id')
    const title = required(payload.title, 'title').trim().slice(0, 200)
    await ctx.waterfall('conversation/rename', id, title, () => chats.rename(id, title))
    return { ok: true }
  })
}
plugin.inject = ['agents', 'clientExtensions', 'program', 'tools', 'turnProgram']
plugin.provide = ['agentChats']
declare module 'cordis' {
  interface Context { agentChats: AgentChats }
  interface Events { 'agent-chats/changed'(): void }
}
export default plugin
