import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChats } from '../program/plugins/agent-chats.js'
import type { AgentEvent, AgentProvider, AgentRegistry, AgentSessionOptions } from '../src/server/services/agent-registry.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'alto-agent-chats-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const sessions = new Map<string, string[]>()
  const prompt = vi.fn(async () => ({ id: 'turn', providerId: 'pi', sessionId: 'session', startedAt: new Date().toISOString() }))
  const steer = vi.fn(async (): Promise<'injected' | 'promptRequired'> => 'injected')
  const stopTask = vi.fn(async () => {})
  const permission = vi.fn(async () => {})
  const load = vi.fn(async (providerId: string, id: string, options: AgentSessionOptions) => {
    sessions.set(providerId, [id])
    return { id, providerId, cwd: options.cwd, createdAt: new Date().toISOString() }
  })
  const provider = (id: string) => ({
    snapshot: () => ({ id, label: id, protocol: 'acp', activeSessionIds: sessions.get(id) ?? [] }),
    createSession: async (options: AgentSessionOptions) => load(id, `${id}-session`, options),
    loadSession: (sessionId: string, options: AgentSessionOptions) => load(id, sessionId, options),
    prompt, steer, stopTask, resolvePermission: permission, setPermissionMode: vi.fn(),
  }) as unknown as AgentProvider
  const agents = { provider, cancel: vi.fn() } as unknown as AgentRegistry
  const changed = vi.fn()
  const chats = new AgentChats(agents, directory, changed)
  cleanup.push(() => chats.dispose())
  await chats.load()
  return { chats, agents, directory, sessions, prompt, steer, stopTask, permission, load, changed }
}

describe('saved ACP chats', () => {
  it('retains an entire streamed answer and resumes with the same provider identity', async () => {
    const f = await fixture()
    const chat = await f.chats.create('pi', '/tmp/project', 'ask')
    await f.chats.send(chat.summary.id, [{ type: 'text', text: 'Hello Pi' }], 'ask')
    const event = { providerId: 'pi', sessionId: 'pi-session', turnId: 'turn', occurredAt: new Date().toISOString() }
    f.chats.event({ ...event, type: 'turn.started' })
    for (let i = 0; i < 250; i++) f.chats.event({ ...event, type: 'message.delta', role: 'agent', content: { type: 'text', text: 'word ' } })
    f.chats.event({ ...event, type: 'turn.completed', stopReason: 'end_turn' })
    expect(chat.activities.filter((item) => item.kind === 'agent')).toHaveLength(1)
    expect(chat.activities.at(-1)?.content).toBe('word '.repeat(250))
    await f.chats.dispose()
    f.sessions.clear()
    const restored = new AgentChats(f.agents, f.directory, vi.fn())
    cleanup.push(() => restored.dispose())
    await restored.load()
    const saved = await restored.open(chat.summary.id)
    expect(saved.activities.at(-1)?.content).toBe('word '.repeat(250))
    expect(saved.summary).toMatchObject({ providerId: 'pi', providerSessionId: 'pi-session', cwd: '/tmp/project' })
    await restored.send(saved.summary.id, [{ type: 'text', text: 'Continue' }], 'ask')
    expect(f.load).toHaveBeenLastCalledWith('pi', 'pi-session', { cwd: '/tmp/project', permissionMode: 'ask', mcpServers: [] })
    expect(f.prompt).toHaveBeenLastCalledWith('pi-session', [{ type: 'text', text: 'Continue' }])
  })

  it('routes only matching provider events and exact permission requests to a chat', async () => {
    const f = await fixture()
    const pi = await f.chats.create('pi', '/tmp/pi-project', 'ask')
    const claude = await f.chats.create('claude', '/tmp/claude-project', 'ask')
    const event = { providerId: 'claude', sessionId: 'claude-session', turnId: 'turn', occurredAt: new Date().toISOString() }
    const permission: AgentEvent = { ...event, type: 'permission.requested', requestId: 'request', toolCallId: 'tool',
      title: 'Run a command', options: [{ id: 'allow', label: 'Allow once', kind: 'allow_once' }] }
    f.chats.event(permission)
    expect(pi.requests).toEqual([])
    expect(claude.requests).toHaveLength(1)
    await expect(f.chats.approve(pi.summary.id, 'request', 'allow')).rejects.toThrow('no longer pending')
    expect(f.permission).not.toHaveBeenCalled()
    await f.chats.approve(claude.summary.id, 'request', 'allow')
    expect(f.permission).toHaveBeenCalledWith('request', 'allow')
    f.chats.event({ ...event, type: 'permission.resolved', requestId: 'request', toolCallId: 'tool', optionId: 'allow' })
    expect(claude.requests).toEqual([])
  })

  it('keeps text separated by tool calls and ends streaming on failure', async () => {
    const f = await fixture()
    const chat = await f.chats.create('pi', '/tmp/project', 'ask')
    const event = { providerId: 'pi', sessionId: 'pi-session', turnId: 'turn', occurredAt: new Date().toISOString() }
    f.chats.event({ ...event, type: 'turn.started' })
    f.chats.event({ ...event, type: 'message.delta', role: 'agent', content: { type: 'text', text: 'Before' } })
    f.chats.event({ ...event, type: 'tool.started', toolCallId: 'tool', title: 'Read file' })
    f.chats.event({ ...event, type: 'message.delta', role: 'agent', content: { type: 'text', text: 'After' } })
    f.chats.event({ ...event, type: 'turn.failed', message: 'Agent exited' })
    expect(chat.activities.map((item) => item.content)).toEqual(['Before', '', 'After'])
    expect(chat.activities.map((item) => item.status)).toEqual(['completed', 'failed', 'failed'])
    expect(chat.turn).toBe('idle')
    expect(chat.problem).toBe('Agent exited')
  })

  it('finishes text segments once later work starts', async () => {
    const f = await fixture()
    const chat = await f.chats.create('pi', '/tmp/project', 'ask')
    const event = { providerId: 'pi', sessionId: 'pi-session', turnId: 'turn', occurredAt: new Date().toISOString() }
    f.chats.event({ ...event, type: 'turn.started' })
    f.chats.event({ ...event, type: 'message.delta', role: 'thought', content: { type: 'text', text: 'Planning' } })
    f.chats.event({ ...event, type: 'tool.started', toolCallId: 'wakeup', title: 'ScheduleWakeup' })
    f.chats.event({ ...event, type: 'message.delta', role: 'thought', content: { type: 'text', text: 'Waiting' } })
    expect(chat.activities.map((item) => item.status)).toEqual(['completed', 'in_progress', 'streaming'])
    f.chats.event({ ...event, type: 'tool.updated', toolCallId: 'wakeup', title: 'ScheduleWakeup', status: 'completed' })
    f.chats.event({ ...event, type: 'message.delta', role: 'thought', content: { type: 'text', text: ' for agents' } })
    f.chats.event({ ...event, type: 'message.delta', role: 'agent', content: { type: 'text', text: 'Still running' } })
    expect(chat.activities.map((item) => [item.content, item.status])).toEqual([
      ['Planning', 'completed'],
      ['', 'completed'],
      ['Waiting for agents', 'completed'],
      ['Still running', 'streaming'],
    ])
  })

  it('rejects overlapping prompts and refuses path-like chat IDs', async () => {
    const f = await fixture()
    const chat = await f.chats.create('pi', '/tmp/project', 'ask')
    let finish!: () => void
    f.prompt.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ id: 'turn', providerId: 'pi', sessionId: 'pi-session', startedAt: '' }) }))
    const first = f.chats.send(chat.summary.id, [{ type: 'text', text: 'First' }], 'ask')
    await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledOnce())
    await expect(f.chats.send(chat.summary.id, [{ type: 'text', text: 'Second' }], 'ask')).rejects.toThrow('active turn')
    finish()
    await first
    await expect(f.chats.open('../other-chat')).rejects.toThrow('not found')
  })
  it('saves queued messages, edits their order, and sends the next prompt after completion', async () => {
    const f = await fixture()
    const chat = await f.chats.create('pi', '/tmp/project', 'ask')
    const event = { providerId: 'pi', sessionId: 'pi-session', turnId: 'first', occurredAt: new Date().toISOString() }
    f.chats.event({ ...event, type: 'turn.started' })
    const draft = (text: string) => ({ text, images: [], attachments: [], skills: [] })
    await f.chats.queue(chat.summary.id, 'add', { draft: draft('second') })
    await f.chats.queue(chat.summary.id, 'add', { draft: draft('third') })
    expect(f.prompt).not.toHaveBeenCalled()
    const [second, third] = chat.queue!
    await f.chats.queue(chat.summary.id, 'update', { queuedSubmissionId: third!.id, draft: draft('third edited') })
    await f.chats.queue(chat.summary.id, 'reorder', { queuedSubmissionIds: [third!.id, second!.id] })
    f.chats.event({ ...event, type: 'turn.completed', stopReason: 'end_turn' })
    await vi.waitFor(() => expect(chat.queue).toHaveLength(1))
    expect(f.prompt).toHaveBeenCalledExactlyOnceWith('pi-session', [{ type: 'text', text: 'third edited' }])
    expect(chat.activities.some((item) => item.kind === 'user' && item.content === 'third edited')).toBe(true)
    await f.chats.dispose()
    const restored = new AgentChats(f.agents, f.directory, () => {})
    cleanup.push(() => restored.dispose())
    await restored.load()
    const saved = await restored.open(chat.summary.id)
    expect(saved.queue?.[0]?.draft.text).toBe('second')
    expect(saved.queuePaused).toBe(true)
  })

  it('does not drain queued messages after interruption or provider failure', async () => {
    const f = await fixture()
    const chat = await f.chats.create('pi', '/tmp/project', 'ask')
    const event = { providerId: 'pi', sessionId: 'pi-session', turnId: 'turn', occurredAt: new Date().toISOString() }
    f.chats.event({ ...event, type: 'turn.started' })
    await f.chats.queue(chat.summary.id, 'add', { draft: { text: 'later', images: [], attachments: [], skills: [] } })
    await f.chats.cancel(chat.summary.id)
    f.chats.event({ ...event, type: 'turn.completed', stopReason: 'cancelled' })
    expect(chat.queue).toHaveLength(1)
    expect(chat.queuePaused).toBe(true)
    expect(f.prompt).not.toHaveBeenCalled()
  })

  it('keeps actual changed lines, agent images, plans, configuration, and context usage', async () => {
    const f = await fixture()
    const chat = await f.chats.create('pi', '/tmp/project', 'ask')
    const event = { providerId: 'pi', sessionId: 'pi-session', turnId: 'turn', occurredAt: new Date().toISOString() }
    f.chats.event({ ...event, type: 'turn.started' })
    f.chats.event({ ...event, type: 'tool.started', toolCallId: 'edit', title: 'Edit readme', kind: 'edit',
      files: [{ path: '/tmp/project/README.md', oldText: 'same\nold\n', newText: 'same\nnew\n' }] })
    f.chats.event({ ...event, type: 'tool.updated', toolCallId: 'edit', title: 'Edit readme', status: 'completed' })
    expect(chat.activities[0]).toMatchObject({ kind: 'file', files: [{ additions: 1, deletions: 1, diff: expect.stringContaining('-old\n+new') }] })
    f.chats.event({ ...event, type: 'message.delta', role: 'agent', content: { type: 'image', mimeType: 'image/png', data: 'YWJj' } })
    expect(chat.activities[1]?.images?.[0]?.url).toBe('data:image/png;base64,YWJj')
    f.chats.event({ ...event, type: 'plan.updated', entries: [{ content: 'Edit readme', status: 'completed' }] })
    f.chats.event({ ...event, type: 'usage.updated', used: 500, size: 200000 })
    expect(chat.plan?.[0]?.status).toBe('completed')
    expect(chat.usage).toEqual({ used: 500, size: 200000 })
  })

  it('binds the prompt to its turn and marks the last response as the completed answer', async () => {
    const f = await fixture()
    const chat = await f.chats.create('pi', '/tmp/project', 'ask')
    await f.chats.send(chat.summary.id, [{ type: 'text', text: 'Hello' }], 'ask')
    const event = { providerId: 'pi', sessionId: 'pi-session', turnId: 'turn', occurredAt: '2026-09-24T12:00:00.000Z' }
    f.chats.event({ ...event, type: 'turn.started' })
    f.chats.event({ ...event, type: 'message.delta', role: 'agent', content: { type: 'text', text: 'Done' } })
    f.chats.event({ ...event, type: 'turn.completed', stopReason: 'end_turn', occurredAt: '2026-09-24T12:00:02.000Z' })
    expect(chat.activities[0]?.turnId).toBe('turn')
    expect(chat.activities[1]).toMatchObject({ phase: 'final_answer', durationMs: 2000, status: 'completed' })
  })

})

it('places live steering once in the active turn and falls back to a new turn when it finishes', async () => {
  const f = await fixture()
  const chat = await f.chats.create('claude', '/tmp/project', 'ask')
  const base = { providerId: 'claude', sessionId: chat.summary.providerSessionId, occurredAt: new Date().toISOString() }
  await f.chats.send(chat.summary.id, [{ type: 'text', text: 'Start' }], 'ask')
  f.chats.event({ ...base, type: 'turn.started', turnId: 'one' })
  await f.chats.steer(chat.summary.id, [{ type: 'text', text: 'Change direction' }])
  expect(chat.activities.filter((item) => item.content === 'Change direction')).toMatchObject([{ kind: 'user', turnId: 'one', continuesTurn: true }])
  expect(f.chats.toolContext(chat.summary.id)).toEqual({ threadId: chat.summary.id, turnId: 'one', permissionMode: 'ask' })
  f.steer.mockImplementationOnce(async () => {
    f.chats.event({ ...base, type: 'turn.completed', turnId: 'one', stopReason: 'end_turn' })
    return 'promptRequired'
  })
  await f.chats.steer(chat.summary.id, [{ type: 'text', text: 'Next turn' }])
  expect(chat.activities.filter((item) => item.content === 'Next turn')).toHaveLength(1)
  expect(chat.activities.at(-1)?.continuesTurn).toBeUndefined()
  expect(f.prompt).toHaveBeenCalledTimes(2)
})

it('keeps nested agent history separate, routes approvals to its parent, and stops only the selected task', async () => {
  const f = await fixture()
  const chat = await f.chats.create('claude', '/tmp/project', 'ask')
  const base = { providerId: 'claude', sessionId: chat.summary.providerSessionId, occurredAt: new Date().toISOString() }
  f.chats.event({ ...base, type: 'turn.started', turnId: 'one' })
  f.chats.event({ ...base, type: 'task.started', taskId: 'child', parentSessionId: base.sessionId, title: 'Review', prompt: 'Review code', canStop: false, taskKind: 'subagent' })
  f.chats.event({ ...base, type: 'task.started', taskId: 'nested', parentSessionId: 'child', title: 'Nested', prompt: 'Inspect', canStop: true, taskKind: 'subagent' })
  f.chats.event({ ...base, sessionId: 'nested', type: 'message.delta', turnId: 'one', role: 'agent', content: { type: 'text', text: 'Nested output' } })
  f.chats.event({ ...base, sessionId: 'nested', type: 'permission.requested', requestId: 'approve-child', toolCallId: 'tool', title: 'Write', options: [{ id: 'yes', label: 'Yes', kind: 'allow_once' }] })
  const nested = f.chats.tasks().find((task) => task.title === 'Nested')!
  expect(nested.status).toBe('waiting')
  expect(nested.ancestorThreadIds).toEqual([`${chat.summary.id}:child`])
  expect(chat.activities).toEqual([])
  expect(chat.requests[0]?.params).toMatchObject({ title: 'Nested: Write' })
  await f.chats.approve(chat.summary.id, 'approve-child', 'yes')
  expect(f.permission).toHaveBeenCalledWith('approve-child', 'yes')
  expect((await f.chats.taskHistory(chat.summary.id, nested.id)).messages.at(-1)?.text).toBe('Nested output')
  await f.chats.stopTask(chat.summary.id, nested.id)
  expect(f.stopTask).toHaveBeenCalledWith(base.sessionId, 'nested')
  await expect(f.chats.stopTask(chat.summary.id, `${chat.summary.id}:child`)).rejects.toThrow('parent turn')
  await expect(f.chats.taskHistory(chat.summary.id, 'other-child')).rejects.toThrow('not found')
  f.chats.event({ ...base, type: 'turn.failed', turnId: 'one', message: 'Connection lost' })
  expect(f.chats.tasks().every((task) => task.status === 'failed')).toBe(true)
  expect(f.chats.toolContext(chat.summary.id)).toBeUndefined()
})

it('atomically removes a steered queue item before a finishing turn can drain it again', async () => {
  const f = await fixture()
  const chat = await f.chats.create('claude', '/tmp/project', 'ask')
  const base = { providerId: 'claude', sessionId: chat.summary.providerSessionId, occurredAt: new Date().toISOString() }
  await f.chats.send(chat.summary.id, [{ type: 'text', text: 'Start' }], 'ask')
  f.chats.event({ ...base, type: 'turn.started', turnId: 'one' })
  const entry = await f.chats.queue(chat.summary.id, 'add', { draft: { text: 'Steer this once', images: [], attachments: [], skills: [] } }) as { id: string }
  f.steer.mockImplementationOnce(async () => {
    f.chats.event({ ...base, type: 'turn.completed', turnId: 'one', stopReason: 'end_turn' })
    return 'injected'
  })
  await f.chats.queue(chat.summary.id, 'steer', { queuedSubmissionId: entry.id })
  expect(chat.queue).toEqual([])
  expect(f.prompt).toHaveBeenCalledTimes(1)
  expect(chat.activities.filter((item) => item.content === 'Steer this once')).toHaveLength(1)
})

it('keeps a background child approval visible and prevents it inheriting a later full-access turn', async () => {
  const f = await fixture()
  const chat = await f.chats.create('claude', '/tmp/project', 'ask')
  const base = { providerId: 'claude', sessionId: chat.summary.providerSessionId, occurredAt: new Date().toISOString() }
  await f.chats.send(chat.summary.id, [{ type: 'text', text: 'Start' }], 'ask')
  f.chats.event({ ...base, type: 'turn.started', turnId: 'one' })
  f.chats.event({ ...base, type: 'task.started', taskId: 'child', parentSessionId: base.sessionId, title: 'Review', prompt: 'Review', canStop: false, taskKind: 'subagent' })
  f.chats.event({ ...base, sessionId: 'child', type: 'permission.requested', requestId: 'pending-child', toolCallId: 'tool', title: 'Write', options: [] })
  f.chats.event({ ...base, type: 'turn.completed', turnId: 'one', stopReason: 'end_turn' })
  expect(chat.requests.map((request) => request.id)).toEqual(['pending-child'])
  await f.chats.send(chat.summary.id, [{ type: 'text', text: 'Next' }], 'full')
  f.chats.event({ ...base, type: 'turn.started', turnId: 'two' })
  expect(f.chats.toolContext(chat.summary.id)?.permissionMode).toBe('ask')
  f.chats.event({ ...base, type: 'task.updated', taskId: 'child', status: 'done' })
  expect(f.chats.toolContext(chat.summary.id)?.permissionMode).toBe('full')
})

it('merges a child stream using its own turn while the parent starts another turn', async () => {
  const f = await fixture()
  const chat = await f.chats.create('claude', '/tmp/project', 'ask')
  const base = { providerId: 'claude', sessionId: chat.summary.providerSessionId, occurredAt: new Date().toISOString() }
  f.chats.event({ ...base, type: 'turn.started', turnId: 'parent-one' })
  f.chats.event({ ...base, type: 'task.started', taskId: 'child', parentSessionId: base.sessionId,
    turnId: 'parent-one', title: 'Review', prompt: 'Review code', canStop: true, taskKind: 'background' })
  f.chats.event({ ...base, type: 'turn.completed', turnId: 'parent-one', stopReason: 'end_turn' })
  f.chats.event({ ...base, type: 'turn.started', turnId: 'parent-two' })
  for (const text of ['First ', 'second ', 'third']) {
    f.chats.event({ ...base, sessionId: 'child', turnId: 'child-turn', type: 'message.delta', role: 'agent', content: { type: 'text', text } })
  }
  const task = f.chats.tasks()[0]!
  expect((await f.chats.taskHistory(chat.summary.id, task.id)).messages).toMatchObject([
    { role: 'user', text: 'Review code' }, { role: 'agent', text: 'First second third' },
  ])
  expect(chat.activities).toEqual([])
  expect(chat.turn).toBe('running')
  expect(chat.turnId).toBe('parent-two')
  f.chats.event({ ...base, type: 'task.updated', taskId: 'child', status: 'done' })
  expect(chat.children?.[0]?.activities.at(-1)?.status).toBe('completed')
  expect(chat.turn).toBe('running')
})

it('accepts updates without a turn ID and keeps a background child on its original turn', async () => {
  const f = await fixture()
  const chat = await f.chats.create('claude', '/tmp/project', 'ask')
  const base = { providerId: 'claude', sessionId: chat.summary.providerSessionId, occurredAt: new Date().toISOString() }
  f.chats.event({ ...base, type: 'plan.updated', entries: [{ content: 'Ready', status: 'pending' }] })
  expect(chat.plan).toEqual([{ content: 'Ready', status: 'pending' }])
  f.chats.event({ ...base, type: 'turn.started', turnId: 'original' })
  f.chats.event({ ...base, type: 'task.started', taskId: 'child', parentSessionId: base.sessionId,
    title: 'Review', prompt: 'Review code', canStop: true, taskKind: 'background' })
  f.chats.event({ ...base, type: 'turn.started', turnId: 'later' })
  for (const text of ['One ', 'answer']) {
    f.chats.event({ ...base, sessionId: 'child', type: 'message.delta', role: 'agent', content: { type: 'text', text } })
  }
  expect(chat.children?.[0]?.activities).toHaveLength(2)
  expect(chat.children?.[0]?.activities.at(-1)).toMatchObject({ content: 'One answer', turnId: 'original' })
})
