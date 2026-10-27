import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChats } from '../program/plugins/agent-chats.js'
import { RemoteAgentProvider } from '../program/plugins/remote-agent-provider.js'
import type { AgentRegistry } from '../src/server/services/agent-registry.js'
import type { RemoteAgentBackend, RemoteAgentProcess, RemoteAgentRecord } from '../src/server/services/remote-agent-api.js'
import type { RemoteRpcMessage } from '../src/server/services/remote-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

class RecordedAgent implements RemoteAgentBackend {
  id = 'example'
  label = 'Example Remote'
  agents = [{ id: 'claude', label: 'Claude', protocol: 'acp' as const }]
  journal: RemoteAgentRecord[] = []
  private wake = new Set<() => void>()
  promptId?: string | number
  modes = false
  failRead = false
  creates = 0
  sends: RemoteRpcMessage[] = []
  terminate = vi.fn(async () => {})
  async create(): Promise<RemoteAgentProcess> { this.creates++; return { id: 'process-1', cwd: '/remote/repo', workspaceName: 'actual-remote-workspace', data: {} } }
  append(stream: 'input' | 'output', message: RemoteRpcMessage): void {
    this.journal.push({ cursor: String(this.journal.length + 1), timestamp: new Date().toISOString(), stream, text: JSON.stringify(message) + '\n' })
    for (const wake of this.wake) wake()
    this.wake.clear()
  }
  async *read(_process: RemoteAgentProcess, options: { after?: string; follow: boolean; signal: AbortSignal }): AsyncIterable<RemoteAgentRecord> {
    if (this.failRead) throw new Error('Network unavailable')
    let position = Number(options.after ?? 0)
    while (!options.signal.aborted) {
      while (position < this.journal.length) yield this.journal[position++]!
      if (!options.follow) return
      await new Promise<void>((resolve) => {
        const wake = () => { options.signal.removeEventListener('abort', wake); this.wake.delete(wake); resolve() }
        this.wake.add(wake); options.signal.addEventListener('abort', wake, { once: true })
      })
    }
  }
  async send(_process: RemoteAgentProcess, text: string): Promise<void> {
    const message = JSON.parse(text) as RemoteRpcMessage
    this.sends.push(message)
    this.append('input', message)
    if (message.method === 'initialize') this.append('output', { id: message.id!, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } })
    if (message.method === 'session/new') this.append('output', { id: message.id!, result: { sessionId: 'native-session', configOptions: this.modes ? [{ id: 'mode', type: 'select', category: 'mode', name: 'Mode', currentValue: 'bypassPermissions', options: [{ value: 'default', name: 'Ask' }, { value: 'bypassPermissions', name: 'Full' }] }] : [] } })
    if (message.method === 'session/set_mode') this.append('output', { id: message.id!, result: {} })
    if (message.method === 'session/prompt') {
      this.promptId = message.id!
      this.append('output', { method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'tool_call', toolCallId: 'shell', title: 'Run tests', kind: 'execute', status: 'in_progress' } } })
    }
    if (message.method === 'session/cancel') this.finish('cancelled')
  }
  finish(stopReason = 'end_turn'): void {
    this.append('output', { method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finished while disconnected.' } } } })
    this.append('output', { id: this.promptId!, result: { stopReason } })
  }
  question(): void {
    this.append('output', { id: 'question-1', method: 'elicitation/create', params: { sessionId: 'native-session', mode: 'form', message: 'Which branch?',
      requestedSchema: { type: 'object', properties: { branch: { type: 'string', enum: ['main', 'feature'] } }, required: ['branch'] } } })
  }
}

class RecordedCodex implements RemoteAgentBackend {
  id = 'example'
  label = 'Example Remote'
  agents = [{ id: 'codex', label: 'Codex', protocol: 'codex-app-server' as const }]
  journal: RemoteAgentRecord[] = []
  sends: RemoteRpcMessage[] = []
  creates = 0
  failRead = false
  terminate = vi.fn(async () => {})
  private wake = new Set<() => void>()
  async create(): Promise<RemoteAgentProcess> { this.creates++; return { id: 'codex-process', cwd: '/remote/repo', data: {} } }
  append(stream: 'input' | 'output', message: RemoteRpcMessage): void {
    this.journal.push({ cursor: String(this.journal.length + 1), timestamp: new Date().toISOString(), stream, text: JSON.stringify(message) + '\n' })
    for (const wake of this.wake) wake()
    this.wake.clear()
  }
  output(method: string, params: Record<string, unknown>): void { this.append('output', { method, params }) }
  async *read(_process: RemoteAgentProcess, options: { after?: string; follow: boolean; signal: AbortSignal }): AsyncIterable<RemoteAgentRecord> {
    let position = Number(options.after ?? 0)
    while (!options.signal.aborted) {
      if (this.failRead) throw new Error('Network unavailable')
      while (position < this.journal.length) yield this.journal[position++]!
      if (!options.follow) return
      await new Promise<void>((resolve) => {
        const wake = () => { options.signal.removeEventListener('abort', wake); this.wake.delete(wake); resolve() }
        this.wake.add(wake); options.signal.addEventListener('abort', wake, { once: true })
      })
    }
  }
  disconnect(): void {
    this.failRead = true
    for (const wake of this.wake) wake()
    this.wake.clear()
  }
  exit(code = 1): void {
    this.journal.push({ stream: 'exit', cursor: String(this.journal.length + 1), timestamp: new Date().toISOString(), code })
    for (const wake of this.wake) wake()
    this.wake.clear()
  }
  async send(_process: RemoteAgentProcess, text: string): Promise<void> {
    const message = JSON.parse(text) as RemoteRpcMessage
    this.sends.push(message)
    this.append('input', message)
    if (message.method === 'initialize') this.append('output', { id: message.id!, result: {} })
    if (message.method === 'thread/start') this.append('output', { id: message.id!, result: { thread: { id: 'root' } } })
    if (message.method === 'model/list') this.append('output', { id: message.id!, result: { data: [
      { id: 'codex', model: 'codex', displayName: 'Codex', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      { id: 'other', model: 'other', displayName: 'Other', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ] } })
    if (message.method === 'turn/start') {
      this.append('output', { id: message.id!, result: { turn: { id: 'root-turn' } } })
      this.output('turn/started', { threadId: 'root', turn: { id: 'root-turn' } })
    }
    if (message.method === 'turn/interrupt') {
      this.append('output', { id: message.id!, result: {} })
      this.output('turn/completed', { threadId: message.params?.threadId, turn: { id: message.params?.turnId, status: 'interrupted' } })
    }
  }
  spawn(id: string, name: string, prompt: string): void {
    this.output('thread/started', { thread: { id, parentThreadId: 'root', name, preview: prompt } })
    this.output('turn/started', { threadId: id, turn: { id: `${id}-turn` } })
  }
  text(id: string, value: string): void {
    this.output('item/agentMessage/delta', { threadId: id, turnId: `${id}-turn`, itemId: `${id}-reply`, delta: value })
  }
  complete(id: string): void {
    this.output('turn/completed', { threadId: id, turn: { id: `${id}-turn`, status: 'completed' } })
  }
  question(id: string): void {
    this.append('output', { id: `${id}-question`, method: 'item/tool/requestUserInput', params: { threadId: id,
      questions: [{ id: 'choice', question: 'Continue?', options: [{ label: 'yes' }, { label: 'no' }] }] } })
  }
  approval(id: string): void {
    this.append('output', { id: `${id}-approval`, method: 'commandExecution/requestApproval', params: { threadId: id, itemId: 'write', reason: 'Write file' } })
  }
  finishRoot(): void { this.output('turn/completed', { threadId: 'root', turn: { id: 'root-turn', status: 'completed' } }) }
}

type ProcessState = { journal: RemoteAgentRecord[]; wake: Set<() => void> }

class MultiRecordedAgent implements RemoteAgentBackend {
  id = 'example'
  label = 'Example Remote'
  agents = [{ id: 'claude', label: 'Claude', protocol: 'acp' as const }]
  creates = 0
  readonly states = new Map<string, ProcessState>()
  readonly deliveries: Array<{ processId: string; message: RemoteRpcMessage }> = []
  terminate = vi.fn(async () => {})

  async create(): Promise<RemoteAgentProcess> {
    const id = `process-${++this.creates}`
    this.states.set(id, { journal: [], wake: new Set() })
    return { id, cwd: `/remote/${id}`, data: {} }
  }

  private state(processId: string): ProcessState {
    const state = this.states.get(processId)
    if (!state) throw new Error(`Unknown process ${processId}`)
    return state
  }

  append(processId: string, stream: 'input' | 'output', message: RemoteRpcMessage): void {
    const state = this.state(processId)
    state.journal.push({ cursor: String(state.journal.length + 1), timestamp: new Date().toISOString(), stream, text: JSON.stringify(message) + '\n' })
    for (const wake of state.wake) wake()
    state.wake.clear()
  }

  async *read(process: RemoteAgentProcess, options: { after?: string; follow: boolean; signal: AbortSignal }): AsyncIterable<RemoteAgentRecord> {
    const state = this.state(process.id)
    let position = Number(options.after ?? 0)
    while (!options.signal.aborted) {
      while (position < state.journal.length) yield state.journal[position++]!
      if (!options.follow) return
      await new Promise<void>((resolve) => {
        const wake = () => { options.signal.removeEventListener('abort', wake); state.wake.delete(wake); resolve() }
        state.wake.add(wake); options.signal.addEventListener('abort', wake, { once: true })
      })
    }
  }

  async send(process: RemoteAgentProcess, text: string): Promise<void> {
    const message = JSON.parse(text) as RemoteRpcMessage
    this.deliveries.push({ processId: process.id, message })
    this.append(process.id, 'input', message)
    if (message.method === 'initialize') this.append(process.id, 'output', { id: message.id!, result: { protocolVersion: 1, agentCapabilities: {} } })
    if (message.method === 'session/new') this.append(process.id, 'output', { id: message.id!, result: { sessionId: `native-${process.id}`, configOptions: [] } })
  }

  question(processId: string, id: string | number): void {
    this.append(processId, 'output', { id, method: 'elicitation/create', params: { sessionId: `native-${processId}`, mode: 'form', message: 'Which branch?',
      requestedSchema: { type: 'object', properties: { branch: { type: 'string', enum: ['main', 'feature'] } }, required: ['branch'] } } })
  }

  approval(processId: string, id: string | number): void {
    this.append(processId, 'output', { id, method: 'session/request_permission', params: { sessionId: `native-${processId}`,
      toolCall: { toolCallId: 'write', title: 'Write file' }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] } })
  }
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'alto-remote-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const backend = new RecordedAgent()
  const connect = async () => {
    const provider = new RemoteAgentProvider(backend, backend.agents[0]!, path.join(directory, 'bindings'))
    const registry = { provider: () => provider, cancel: (_providerId: string, id: string) => provider.cancel(id) } as unknown as AgentRegistry
    const chats = new AgentChats(registry, path.join(directory, 'chats'), () => {})
    provider.subscribe((event) => chats.event(event))
    await chats.load()
    const close = async () => { await chats.dispose(); await provider.stop() }
    cleanup.push(close)
    return { chats, provider, close }
  }
  return { backend, connect }
}

async function codexFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'alto-remote-codex-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const backend = new RecordedCodex()
  const connect = async () => {
    const provider = new RemoteAgentProvider(backend, backend.agents[0]!, path.join(directory, 'bindings'))
    const registry = { provider: () => provider, cancel: (_providerId: string, id: string) => provider.cancel(id) } as unknown as AgentRegistry
    const chats = new AgentChats(registry, path.join(directory, 'chats'), () => {})
    provider.subscribe((event) => chats.event(event))
    await chats.load()
    const close = async () => { await chats.dispose(); await provider.stop() }
    cleanup.push(close)
    return { chats, provider, close }
  }
  return { backend, connect }
}

async function multiFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'alto-remote-multi-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const backend = new MultiRecordedAgent()
  const connect = async () => {
    const provider = new RemoteAgentProvider(backend, backend.agents[0]!, path.join(directory, 'bindings'))
    const registry = { provider: () => provider, cancel: (_providerId: string, id: string) => provider.cancel(id) } as unknown as AgentRegistry
    const chats = new AgentChats(registry, path.join(directory, 'chats'), () => {})
    provider.subscribe((event) => chats.event(event))
    await chats.load()
    const close = async () => { await chats.dispose(); await provider.stop() }
    cleanup.push(close)
    return { chats, provider, close }
  }
  return { backend, connect }
}

describe('durable remote chats', () => {
  it('offers draft Claude models without starting a remote process', async () => {
    const f = await fixture()
    const { provider } = await f.connect()
    expect(provider.snapshot().configOptions?.[0]?.options.map((option) => option.value)).toContain('opus')
    expect(f.backend.creates).toBe(0)
    expect(f.backend.sends).toEqual([])
  })

  it('sends the selected Codex model with that model\'s reasoning settings', async () => {
    const f = await codexFixture()
    const { chats } = await f.connect()
    const chat = await chats.create('example-codex', '/local/repo', 'ask')
    await chats.configure(chat.summary.id, 'model', 'other')
    expect(chat.configOptions?.find((option) => option.id === 'effort')).toMatchObject({ currentValue: 'high', options: [{ value: 'high', name: 'high' }] })
    await expect(chats.configure(chat.summary.id, 'effort', 'medium')).rejects.toThrow('Invalid remote agent configuration')
    await chats.send(chat.summary.id, [{ type: 'text', text: 'Hello' }], 'ask')
    expect(f.backend.sends.find((message) => message.method === 'turn/start')?.params).toMatchObject({ model: 'other', effort: 'high' })
  })

  it('replays native Codex children independently, restores their requests, and interrupts the exact selected child', async () => {
    const f = await codexFixture()
    const first = await f.connect()
    const chat = await first.chats.create('example-codex', '/local/repo', 'ask')
    await first.chats.send(chat.summary.id, [{ type: 'text', text: 'Delegate this work' }], 'ask')
    f.backend.spawn('completed-child', 'Completed child', 'Finish offline')
    f.backend.text('completed-child', 'Started. ')
    f.backend.spawn('waiting-child', 'Waiting child', 'Ask safely')
    f.backend.spawn('managed-child', 'Managed child', 'Keep working')
    await vi.waitFor(() => expect(chat.children).toHaveLength(3))
    await first.close()

    f.backend.text('completed-child', 'Finished offline.')
    f.backend.complete('completed-child')
    f.backend.question('waiting-child')
    f.backend.approval('waiting-child')
    const second = await f.connect()
    const restored = await second.chats.open(chat.summary.id)
    expect(restored.turn).toBe('running')
    expect(restored.activities.some((item) => item.content.includes('Finished offline.'))).toBe(false)
    expect(restored.children).toHaveLength(3)
    const completed = restored.children!.find((child) => child.sessionId === 'completed-child')!
    expect(completed.task.status).toBe('done')
    expect(completed.activities.filter((item) => item.kind === 'agent').map((item) => item.content)).toEqual(['Started. Finished offline.'])
    expect(restored.requests.map((request) => request.params.agentSessionId)).toEqual(['waiting-child', 'waiting-child'])
    expect(restored.children!.find((child) => child.sessionId === 'waiting-child')?.task.status).toBe('waiting')

    const questionId = String(restored.requests.find((request) => request.method === 'agent/requestUserInput')!.id)
    const approvalId = String(restored.requests.find((request) => request.method === 'agent/requestApproval')!.id)
    expect(questionId).not.toBe('waiting-child-question')
    expect(approvalId).not.toBe('waiting-child-approval')
    await second.chats.answer(chat.summary.id, questionId, { action: 'accept', content: { choice: 'yes' } })
    await second.chats.approve(chat.summary.id, approvalId, 'accept')
    expect(restored.requests).toHaveLength(0)
    const managed = restored.children!.find((child) => child.sessionId === 'managed-child')!
    await second.chats.stopTask(chat.summary.id, managed.task.id)
    expect(f.backend.sends.findLast((message) => message.method === 'turn/interrupt')?.params).toEqual({ threadId: 'managed-child', turnId: 'managed-child-turn' })
    expect(restored.turn).toBe('running')
    f.backend.finishRoot()
    await vi.waitFor(() => expect(restored.turn).toBe('idle'))

    const activityCounts = restored.children!.map((child) => child.activities.length)
    await second.close()
    const third = await f.connect()
    const replayed = await third.chats.open(chat.summary.id)
    expect(replayed.children).toHaveLength(3)
    expect(replayed.children!.map((child) => child.activities.length)).toEqual(activityCounts)
    expect(replayed.requests).toHaveLength(0)
    expect(f.backend.creates).toBe(1)
    expect(f.backend.sends.filter((message) => message.method === 'turn/start')).toHaveLength(1)
  })

  it('reopens the exact conversation after the desktop exits, without rerunning the prompt or duplicating history', async () => {
    const f = await fixture()
    const first = await f.connect()
    const chat = await first.chats.create('example-claude', '/local/repo', 'ask')
    expect(chat.remote?.workspaceName).toBe('actual-remote-workspace')
    await first.chats.send(chat.summary.id, [{ type: 'text', text: 'Run the tests' }], 'ask')
    await vi.waitFor(() => expect(chat.turn).toBe('running'))
    await first.close()
    expect(f.backend.terminate).not.toHaveBeenCalled()
    f.backend.finish()
    const second = await f.connect()
    const restored = await second.chats.open(chat.summary.id)
    expect(restored.turn).toBe('idle')
    expect(restored.remote?.workspaceName).toBe('actual-remote-workspace')
    expect(restored.activities.filter((item) => item.kind === 'user').map((item) => item.content)).toEqual(['Run the tests'])
    expect(restored.activities.filter((item) => item.kind === 'agent').map((item) => item.content)).toEqual(['Finished while disconnected.'])
    expect(f.backend.creates).toBe(1)
    expect(f.backend.sends.filter((message) => message.method === 'session/prompt')).toHaveLength(1)
    await second.close()
    const third = await f.connect()
    expect((await third.chats.open(chat.summary.id)).activities).toHaveLength(restored.activities.length)
  })

  it('inspects a saved remote workspace without creating or reconnecting its agent', async () => {
    const f = await fixture()
    const first = await f.connect()
    const chat = await first.chats.create('example-claude', '/local/repo', 'ask')
    await first.close()
    const workspace = { name: 'original-workstation', url: 'https://remote.example/terminal',
      cwd: '/remote/repo', branch: 'feature/remote', repository: 'https://github.com/example/remote' }
    const lookup = vi.fn(async (_process: RemoteAgentProcess, _signal: AbortSignal) => workspace)
    Object.assign(f.backend, { workspaceInfo: lookup })
    const reconnect = vi.spyOn(f.backend, 'read')
    const sends = f.backend.sends.length
    const second = await f.connect()
    expect(await Promise.all([second.chats.workspace(chat.summary.id), second.chats.workspace(chat.summary.id)]))
      .toEqual([workspace, workspace])
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ id: 'process-1', cwd: '/remote/repo' }), expect.any(AbortSignal))
    expect(second.provider.snapshot().activeSessionIds).toEqual([])
    expect(reconnect).not.toHaveBeenCalled()
    expect(f.backend.creates).toBe(1)
    expect(f.backend.sends).toHaveLength(sends)
    expect(f.backend.terminate).not.toHaveBeenCalled()
  })

  it('updates remote workspace metadata without making the conversation appear newly active', async () => {
    const f = await fixture()
    const first = await f.connect()
    const chat = await first.chats.create('example-claude', '/local/repo', 'ask')
    chat.summary.updatedAt = 123
    const workspace = { branch: 'remote-branch', cwd: '/remote/repo' }
    Object.assign(f.backend, { workspaceInfo: vi.fn(async () => workspace) })
    expect(await first.chats.workspace(chat.summary.id)).toEqual(workspace)
    expect(chat.remote?.workspace).toEqual(workspace)
    expect(chat.summary.updatedAt).toBe(123)
  })

  it('restores a question asked offline and validates the answer without reinitializing the agent', async () => {
    const f = await fixture()
    const first = await f.connect()
    const chat = await first.chats.create('example-claude', '/local/repo', 'full')
    await first.chats.send(chat.summary.id, [{ type: 'text', text: 'Make a change' }], 'full')
    await first.close()
    f.backend.question()
    const second = await f.connect()
    const restored = await second.chats.open(chat.summary.id)
    expect(restored.requests).toHaveLength(1)
    const requestId = String(restored.requests[0]!.id)
    expect(requestId).not.toBe('question-1')
    expect(requestId.endsWith(':question-1')).toBe(true)
    expect(f.backend.sends.filter((message) => message.id === 'question-1')).toHaveLength(0)
    await expect(second.chats.answer(chat.summary.id, requestId, { action: 'accept', content: { branch: 'invented' } })).rejects.toThrow('offered')
    await second.chats.answer(chat.summary.id, requestId, { action: 'accept', content: { branch: 'feature' } })
    await vi.waitFor(() => expect(restored.requests).toHaveLength(0))
    await second.close()
    const third = await f.connect()
    const replayed = await third.chats.open(chat.summary.id)
    expect(replayed.activities.filter((item) => item.title === 'Answered')).toMatchObject([{ questionAnswers: ['feature'] }])
    expect(replayed.requests).toHaveLength(0)
    expect(f.backend.sends.filter((message) => message.method === 'initialize')).toHaveLength(1)
    expect(f.backend.sends.filter((message) => message.id === 'question-1')).toEqual([{ id: 'question-1', jsonrpc: '2.0', result: { action: 'accept', content: { branch: 'feature' } } }])
  })

  it('recovers an active turn and only cancels on an explicit stop', async () => {
    const f = await fixture()
    const first = await f.connect()
    const chat = await first.chats.create('example-claude', '/local/repo', 'ask')
    await first.chats.send(chat.summary.id, [{ type: 'text', text: 'Keep working' }], 'ask')
    await first.close()
    const second = await f.connect()
    const restored = await second.chats.open(chat.summary.id)
    expect(restored.turn).toBe('running')
    expect(restored.remote?.state).toBe('connected')
    expect(f.backend.sends.some((message) => message.method === 'session/cancel')).toBe(false)
    await second.chats.cancel(chat.summary.id)
    await vi.waitFor(() => expect(restored.turn).toBe('idle'))
    expect(f.backend.sends.filter((message) => message.method === 'session/cancel')).toHaveLength(1)
  })
  it('does not inherit a remote bypass mode when Alto selects Ask', async () => {
    const f = await fixture()
    f.backend.modes = true
    const first = await f.connect()
    const chat = await first.chats.create('example-claude', '/local/repo', 'ask')
    expect(f.backend.sends.find((message) => message.method === 'session/set_mode')?.params?.modeId).toBe('default')
    await first.chats.send(chat.summary.id, [{ type: 'text', text: 'Full turn' }], 'full')
    f.backend.finish()
    await vi.waitFor(() => expect(chat.turn).toBe('idle'))
    await first.chats.send(chat.summary.id, [{ type: 'text', text: 'Ask again' }], 'ask')
    expect(f.backend.sends.filter((message) => message.method === 'session/set_mode').map((message) => message.params?.modeId))
      .toEqual(['default', 'bypassPermissions', 'default'])
  })

  it('keeps cached history during a failed reconnect and retries without creating a new process', async () => {
    const f = await fixture()
    const first = await f.connect()
    const chat = await first.chats.create('example-claude', '/local/repo', 'ask')
    await first.chats.send(chat.summary.id, [{ type: 'text', text: 'Keep this message' }], 'ask')
    f.backend.finish()
    await vi.waitFor(() => expect(chat.turn).toBe('idle'))
    await first.close()
    f.backend.failRead = true
    const second = await f.connect()
    const restored = await second.chats.open(chat.summary.id)
    expect(restored.remote?.state).toBe('disconnected')
    expect(restored.activities.some((item) => item.content === 'Keep this message')).toBe(true)
    f.backend.failRead = false
    await second.chats.open(chat.summary.id)
    expect(restored.remote?.state).toBe('connected')
    expect(f.backend.creates).toBe(1)
  })

  it('shows an exited process as stopped when its unfinished turn is replayed', async () => {
    const f = await fixture()
    const first = await f.connect()
    const chat = await first.chats.create('example-claude', '/local/repo', 'ask')
    await first.chats.send(chat.summary.id, [{ type: 'text', text: 'Start work' }], 'ask')
    await first.close()
    f.backend.journal.push({ stream: 'exit', cursor: String(f.backend.journal.length + 1), timestamp: new Date().toISOString(), code: 1 })
    const second = await f.connect()
    const restored = await second.chats.open(chat.summary.id)
    expect(restored.remote?.state).toBe('ended')
    expect(restored.turn).toBe('idle')
    expect(restored.problem).toContain('exited')
    expect(f.backend.creates).toBe(1)
    expect(f.backend.terminate).not.toHaveBeenCalled()
  })

  it('keeps active children through a disconnect but makes them terminal when the remote process exits and on replay', async () => {
    const f = await codexFixture()
    const first = await f.connect()
    const chat = await first.chats.create('example-codex', '/local/repo', 'ask')
    await first.chats.send(chat.summary.id, [{ type: 'text', text: 'Delegate and keep working' }], 'ask')
    f.backend.spawn('active-child', 'Active child', 'Keep working')
    f.backend.text('active-child', 'Still running')
    await vi.waitFor(() => expect(chat.children?.[0]?.task.status).toBe('working'))

    f.backend.disconnect()
    await vi.waitFor(() => expect(chat.remote?.state).toBe('disconnected'))
    expect(chat.children?.[0]?.task.status).toBe('working')
    expect(chat.children?.[0]?.task.finishedAt).toBeUndefined()

    f.backend.failRead = false
    await vi.waitFor(() => expect(chat.remote?.state).toBe('connected'), { timeout: 3_000 })
    expect(chat.children?.[0]?.task.status).toBe('working')
    f.backend.exit()
    await vi.waitFor(() => expect(chat.remote?.state).toBe('ended'))
    expect(chat.turn).toBe('idle')
    expect(chat.children?.[0]?.task.status).toBe('stopped')
    expect(chat.children?.[0]?.task.finishedAt).toEqual(expect.any(Number))
    expect(chat.children?.[0]?.activities.find((item) => item.kind === 'agent')?.status).toBe('interrupted')

    await first.close()
    const second = await f.connect()
    const replayed = await second.chats.open(chat.summary.id)
    expect(replayed.remote?.state).toBe('ended')
    expect(replayed.children?.[0]?.task.status).toBe('stopped')
    expect(replayed.children?.[0]?.task.finishedAt).toEqual(expect.any(Number))
  })

  it('routes colliding question and approval wire IDs to the selected persisted session after replay', async () => {
    const f = await multiFixture()
    const first = await f.connect()
    const firstChat = await first.chats.create('example-claude', '/local/first', 'ask')
    const secondChat = await first.chats.create('example-claude', '/local/second', 'ask')
    await first.chats.send(firstChat.summary.id, [{ type: 'text', text: 'First' }], 'ask')
    await first.chats.send(secondChat.summary.id, [{ type: 'text', text: 'Second' }], 'ask')
    await first.close()

    f.backend.question('process-1', 7)
    f.backend.question('process-2', 7)
    const replay = await f.connect()
    const restoredFirst = await replay.chats.open(firstChat.summary.id)
    const restoredSecond = await replay.chats.open(secondChat.summary.id)
    const firstQuestion = String(restoredFirst.requests.find((request) => request.method === 'agent/requestUserInput')!.id)
    const secondQuestion = String(restoredSecond.requests.find((request) => request.method === 'agent/requestUserInput')!.id)
    expect(firstQuestion).not.toBe(secondQuestion)
    expect(firstQuestion.endsWith(':7')).toBe(true)
    expect(secondQuestion.endsWith(':7')).toBe(true)

    await replay.chats.answer(secondChat.summary.id, secondQuestion, { action: 'accept', content: { branch: 'feature' } })
    expect(restoredSecond.requests).toHaveLength(0)
    expect(restoredFirst.requests.map((request) => request.id)).toEqual([firstQuestion])
    expect(f.backend.deliveries.filter(({ message }) => message.id === 7 && message.result).map(({ processId }) => processId)).toEqual(['process-2'])
    await replay.chats.answer(firstChat.summary.id, firstQuestion, { action: 'accept', content: { branch: 'main' } })
    expect(restoredFirst.requests).toHaveLength(0)
    expect(f.backend.deliveries.filter(({ message }) => message.id === 7 && message.result).map(({ processId }) => processId)).toEqual(['process-2', 'process-1'])

    await replay.close()
    f.backend.approval('process-1', 7)
    f.backend.approval('process-2', 7)
    const approvalReplay = await f.connect()
    const approvalFirst = await approvalReplay.chats.open(firstChat.summary.id)
    const approvalSecond = await approvalReplay.chats.open(secondChat.summary.id)
    expect(approvalFirst.requests).toHaveLength(1)
    expect(approvalSecond.requests).toHaveLength(1)
    const firstApproval = String(approvalFirst.requests[0]!.id)
    const secondApproval = String(approvalSecond.requests[0]!.id)
    expect(firstApproval).not.toBe(secondApproval)
    await approvalReplay.chats.approve(secondChat.summary.id, secondApproval, 'allow')
    expect(approvalSecond.requests).toHaveLength(0)
    expect(approvalFirst.requests.map((request) => request.id)).toEqual([firstApproval])
    expect(f.backend.deliveries.filter(({ message }) => message.id === 7 && message.result).map(({ processId }) => processId)).toEqual(['process-2', 'process-1', 'process-2'])
    await approvalReplay.chats.approve(firstChat.summary.id, firstApproval, 'allow')
    expect(approvalFirst.requests).toHaveLength(0)
    expect(f.backend.deliveries.filter(({ message }) => message.id === 7 && message.result).map(({ processId }) => processId)).toEqual(['process-2', 'process-1', 'process-2', 'process-1'])
  })

  it('routes automatic Full-mode approval to its session when an Ask session has the same wire ID pending', async () => {
    const f = await multiFixture()
    const connection = await f.connect()
    const askChat = await connection.chats.create('example-claude', '/local/ask', 'ask')
    const fullChat = await connection.chats.create('example-claude', '/local/full', 'full')
    await connection.chats.send(askChat.summary.id, [{ type: 'text', text: 'Ask first' }], 'ask')
    await connection.chats.send(fullChat.summary.id, [{ type: 'text', text: 'Full second' }], 'full')

    f.backend.approval('process-1', 9)
    await vi.waitFor(() => expect(askChat.requests).toHaveLength(1))
    const askApproval = String(askChat.requests[0]!.id)
    f.backend.approval('process-2', 9)
    await vi.waitFor(() => expect(f.backend.deliveries.some(({ processId, message }) => processId === 'process-2' && message.id === 9 && message.result)).toBe(true))
    expect(askChat.requests.map((request) => request.id)).toEqual([askApproval])
    expect(fullChat.requests).toHaveLength(0)
    expect(f.backend.deliveries.some(({ processId, message }) => processId === 'process-1' && message.id === 9 && message.result)).toBe(false)

    await connection.chats.approve(askChat.summary.id, askApproval, 'allow')
    expect(askChat.requests).toHaveLength(0)
    expect(f.backend.deliveries.filter(({ message }) => message.id === 9 && message.result).map(({ processId }) => processId)).toEqual(['process-2', 'process-1'])
  })

  it('terminates a newly created process when its local binding cannot be saved', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'alto-remote-failed-save-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const blockedPath = path.join(directory, 'file')
    await writeFile(blockedPath, 'not a directory')
    const backend = new RecordedAgent()
    const provider = new RemoteAgentProvider(backend, backend.agents[0]!, blockedPath)
    cleanup.push(() => provider.stop())
    await expect(provider.createSession({ cwd: '/repo', permissionMode: 'ask' })).rejects.toThrow()
    expect(backend.creates).toBe(1)
    expect(backend.terminate).toHaveBeenCalledOnce()
    expect(backend.sends).toHaveLength(0)
  })

})
