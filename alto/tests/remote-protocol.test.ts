import { describe, expect, it } from 'vitest'
import { RemoteAgentProtocol, type RemoteEvent } from '../program/plugins/remote-agent-protocol.js'
import type { RemoteRpcMessage } from '../src/server/services/remote-rpc.js'
import { activityFrom } from '../program/plugins/ui/activity-model.js'
import { applyAgentChatEvent } from '../program/plugins/agent-chat-events.js'
import type { AgentChat } from '../program/plugins/agent-chats-api.js'

const time = '2026-09-25T12:00:00Z'
describe('recorded App Server conversations', () => {
  it.each([
    { type: 'commandExecution', command: '/bin/zsh -lc "git status"', commandActions: [], title: 'Ran a command' },
    { type: 'commandExecution', command: 'cat README.md', commandActions: [{ type: 'read' }], title: 'Read files' },
    { type: 'commandExecution', command: 'ls src', commandActions: [{ type: 'listFiles' }], title: 'Read files' },
    { type: 'commandExecution', command: 'rg needle src', commandActions: [{ type: 'search' }], title: 'Searched files' },
    { type: 'webSearch', query: 'Alto', title: 'Searched the web' },
    { type: 'mcpToolCall', server: 'browser', tool: 'open_page', arguments: { url: 'https://example.com' }, title: 'Used the browser' },
    { type: 'dynamicToolCall', tool: 'view_image', arguments: { path: '/tmp/image.png' }, title: 'Viewed an image' },
    { type: 'fileChange', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '-old\n+new' }], title: 'Files' },
  ])('matches local tool labels for $title ($type)', ({ title, ...data }) => {
    const events: RemoteEvent[] = []
    const protocol = new RemoteAgentProtocol('codex-app-server', (event) => events.push(event))
    for (const method of ['item/started', 'item/completed']) {
      const item = { id: 'tool', ...data, status: method === 'item/started' ? 'inProgress' : 'completed' }
      const notification = { method, params: { item } }
      protocol.accept('output', notification, time)
      expect(events.at(-1)).toMatchObject({ title })
      expect(activityFrom(notification)?.title).toBe(title)
      if (data.type === 'webSearch' || data.type === 'mcpToolCall' || data.type === 'dynamicToolCall') {
        expect(events.at(-1)).toMatchObject({ content: JSON.stringify(item, null, 2) })
      }
    }
  })

  it('keeps command details through streaming, completion, and replay without expanding the summary', () => {
    const command = '/bin/zsh -lc "gh pr view 7224 --json number,title,body && git status --short"'
    const journal: RemoteRpcMessage[] = [
      { method: 'turn/started', params: { turn: { id: 'turn' } } },
      { method: 'item/started', params: { item: { id: 'command', type: 'commandExecution', command } } },
      { method: 'item/commandExecution/outputDelta', params: { itemId: 'command', delta: 'first\n' } },
      { method: 'item/commandExecution/outputDelta', params: { itemId: 'command', delta: 'second\n' } },
      { method: 'item/completed', params: { item: { id: 'command', type: 'commandExecution', command, aggregatedOutput: 'final\n', status: 'completed' } } },
    ]
    const chat: AgentChat = {
      summary: { id: 'chat', providerId: 'remote', providerSessionId: 'root', title: 'Test', preview: '', cwd: '/tmp', createdAt: 0, updatedAt: 0 },
      permissionMode: 'full', turn: 'idle', activities: [], requests: [],
    }
    const replay = () => new RemoteAgentProtocol('codex-app-server', (event, occurredAt) => {
      if (event.type === 'provider.status') return
      applyAgentChatEvent(chat, { ...event, providerId: 'remote', sessionId: 'root', occurredAt })
    })
    const protocol = replay()
    for (const message of journal.slice(0, 4)) protocol.accept('output', message, time)
    expect(chat.activities).toHaveLength(1)
    expect(chat.activities[0]).toMatchObject({ kind: 'command', title: 'Ran a command', content: `${command}\n\nfirst\nsecond\n` })
    protocol.accept('output', journal[4]!, time)
    expect(chat.activities).toHaveLength(1)
    expect(chat.activities[0]).toMatchObject({ title: 'Ran a command', content: `${command}\n\nfinal\n`, status: 'completed' })
    const completed = structuredClone(chat.activities)
    applyAgentChatEvent(chat, { type: 'session.replay', phase: 'started', providerId: 'remote', sessionId: 'root', occurredAt: time })
    const reconnected = replay()
    for (const message of journal) reconnected.accept('output', message, time)
    expect(chat.activities).toEqual(completed)
  })

  it('keeps command metadata scoped to each child and preserves failed results', () => {
    const routed: Array<{ event: RemoteEvent; childId?: string }> = []
    const protocol = new RemoteAgentProtocol('codex-app-server', (event, _time, childId) => routed.push({ event, ...(childId ? { childId } : {}) }))
    protocol.nativeId = 'root'
    const output = (method: string, params: Record<string, unknown>) => protocol.accept('output', { method, params }, time)
    output('thread/started', { thread: { id: 'child', parentThreadId: 'root', name: 'Reviewer' } })
    output('item/started', { threadId: 'root', item: { id: 'same-id', type: 'commandExecution', command: 'git status' } })
    output('item/started', { threadId: 'child', item: { id: 'same-id', type: 'commandExecution', command: 'cat missing.md', commandActions: [{ type: 'read' }] } })
    output('item/commandExecution/outputDelta', { threadId: 'child', itemId: 'same-id', delta: 'No such file' })
    expect(routed.at(-1)).toMatchObject({ childId: 'child', event: { title: 'Read files', content: 'cat missing.md\n\nNo such file' } })
    output('item/completed', { threadId: 'child', item: { id: 'same-id', type: 'commandExecution', commandActions: [{ type: 'read' }], status: 'failed' } })
    expect(routed.at(-1)).toMatchObject({ childId: 'child', event: { title: 'Read files', content: 'cat missing.md\n\nNo such file', status: 'failed' } })
    output('item/commandExecution/outputDelta', { threadId: 'root', itemId: 'same-id', delta: 'clean' })
    expect(routed.at(-1)).toEqual({ event: { type: 'tool.updated', toolCallId: 'same-id', title: 'Ran a command', content: 'git status\n\nclean', kind: 'execute' } })
  })

  it('replays a prompt before output, and does not resurrect a completed turn when its RPC response arrives late', () => {
    const events: RemoteEvent[] = []
    const protocol = new RemoteAgentProtocol('codex-app-server', (event) => events.push(event))
    const accept = (direction: 'input' | 'output', message: RemoteRpcMessage) => protocol.accept(direction, message, time)
    accept('input', { id: 'prompt-1', method: 'turn/start', params: { input: [{ type: 'text', text: 'Hello' }] } })
    accept('output', { method: 'turn/started', params: { turn: { id: 'turn-1' } } })
    accept('output', { method: 'item/agentMessage/delta', params: { itemId: 'reply-1', delta: 'Hi' } })
    accept('output', { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
    accept('output', { id: 'prompt-1', result: { turn: { id: 'turn-1' } } })
    expect(protocol.activeTurn).toBeUndefined()
    expect(events.map((event) => event.type)).toEqual(['message.submitted', 'turn.started', 'message.delta', 'turn.completed'])
    expect(protocol.requests.size).toBe(0)
  })

  it('restores native pending questions and their recorded answers', () => {
    const events: RemoteEvent[] = []
    const protocol = new RemoteAgentProtocol('codex-app-server', (event) => events.push(event))
    protocol.accept('output', { id: 13, method: 'item/tool/requestUserInput', params: {
      questions: [{ id: 'branch', question: 'Which branch?', options: [{ label: 'main' }, { label: 'feature' }] }],
    } }, time)
    expect(protocol.decisions.size).toBe(1)
    expect(events[0]).toMatchObject({ type: 'input.requested', schema: { required: ['branch'], properties: { branch: { enum: ['main', 'feature'] } } } })
    protocol.accept('input', { id: 13, result: { answers: { branch: { answers: ['feature'] } } } }, time)
    expect(protocol.decisions.size).toBe(0)
    expect(events[1]).toEqual({ type: 'input.resolved', requestId: '13', answer: { message: 'Which branch?', values: ['feature'] } })
  })

  it('discovers native children and keeps child turns, transcripts, usage, and requests off the parent', () => {
    const routed: Array<{ event: RemoteEvent; childId?: string }> = []
    const protocol = new RemoteAgentProtocol('codex-app-server', (event, _time, childId) => routed.push({ event, ...(childId ? { childId } : {}) }))
    const accept = (direction: 'input' | 'output', message: RemoteRpcMessage) => protocol.accept(direction, message, time)
    accept('input', { id: 'init', method: 'initialize', params: {} })
    accept('output', { id: 'init', result: {} })
    expect(protocol.capabilities.subagents).toBe(true)
    accept('input', { id: 'start', method: 'thread/start', params: {} })
    accept('output', { id: 'start', result: { thread: { id: 'root' } } })
    accept('input', { id: 'prompt', method: 'turn/start', params: { input: [{ type: 'text', text: 'Delegate' }] } })
    accept('output', { method: 'turn/started', params: { threadId: 'root', turn: { id: 'root-turn' } } })
    accept('output', { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root', name: 'Reviewer', preview: 'Review code' } } })
    accept('output', { method: 'thread/started', params: { thread: { id: 'nested', source: { subAgent: { thread_spawn: { parent_thread_id: 'child', depth: 2, agent_role: 'Researcher' } } }, preview: 'Check docs' } } })
    // Repeated discovery records must not duplicate shared child panels.
    accept('output', { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root', name: 'Reviewer' } } })
    accept('output', { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } })
    accept('output', { method: 'item/agentMessage/delta', params: { threadId: 'child', turnId: 'child-turn', itemId: 'child-reply', delta: 'Child result' } })
    accept('output', { method: 'thread/tokenUsage/updated', params: { threadId: 'child', tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 } } })
    accept('output', { id: 21, method: 'item/tool/requestUserInput', params: { threadId: 'child', questions: [{ id: 'choice', question: 'Continue?' }] } })
    accept('output', { id: 22, method: 'commandExecution/requestApproval', params: { threadId: 'nested', itemId: 'write', reason: 'Write file' } })

    expect(protocol.activeTurn).toBe('root-turn')
    expect(routed.filter(({ event }) => event.type === 'task.started')).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ taskId: 'child', parentSessionId: 'root', title: 'Reviewer', prompt: 'Review code' }) }),
      expect.objectContaining({ event: expect.objectContaining({ taskId: 'nested', parentSessionId: 'child', title: 'Researcher', prompt: 'Check docs' }) }),
    ])
    expect(routed).toContainEqual(expect.objectContaining({ childId: 'child', event: expect.objectContaining({ type: 'message.delta', content: { type: 'text', text: 'Child result' } }) }))
    expect(routed).toContainEqual(expect.objectContaining({ childId: 'child', event: expect.objectContaining({ type: 'input.requested', requestId: '21' }) }))
    expect(routed).toContainEqual(expect.objectContaining({ childId: 'nested', event: expect.objectContaining({ type: 'permission.requested', requestId: '22' }) }))
    expect(routed.filter(({ event, childId }) => !childId && ['message.delta', 'usage.updated', 'input.requested', 'permission.requested'].includes(event.type))).toHaveLength(0)

    accept('output', { method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } } })
    expect(protocol.activeTurn).toBe('root-turn')
    expect(routed).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: 'task.updated', taskId: 'child', status: 'done' }) }))
    accept('output', { method: 'turn/completed', params: { threadId: 'root', turn: { id: 'root-turn', status: 'completed' } } })
    expect(protocol.activeTurn).toBeUndefined()
  })

  it('uses collaboration state as child state instead of completing the parent turn', () => {
    const events: RemoteEvent[] = []
    const protocol = new RemoteAgentProtocol('codex-app-server', (event) => events.push(event))
    const output = (method: string, params: Record<string, unknown>) => protocol.accept('output', { method, params }, time)
    protocol.accept('input', { id: 'start', method: 'thread/start', params: {} }, time)
    protocol.accept('output', { id: 'start', result: { thread: { id: 'root' } } }, time)
    output('turn/started', { threadId: 'root', turn: { id: 'parent-turn' } })
    output('item/started', { threadId: 'root', item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'root', receiverThreadIds: ['child'], prompt: 'Investigate', model: 'codex-mini', reasoningEffort: 'high', status: 'inProgress', agentsStates: { child: { status: 'pendingInit' } } } })
    output('item/completed', { threadId: 'root', item: { id: 'wait', type: 'collabAgentToolCall', tool: 'wait', senderThreadId: 'root', receiverThreadIds: ['child'], status: 'completed', agentsStates: { child: { status: 'completed', message: 'All done' } } } })
    expect(protocol.activeTurn).toBe('parent-turn')
    expect(events).toContainEqual(expect.objectContaining({ type: 'task.started', taskId: 'child', prompt: 'Investigate', model: 'codex-mini', effort: 'high' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'task.updated', taskId: 'child', status: 'done', summary: 'All done' }))
    expect(events.some((event) => event.type === 'turn.completed')).toBe(false)
  })

  it('defers an early child question until that exact thread is discovered', () => {
    const routed: Array<{ event: RemoteEvent; childId?: string }> = []
    const protocol = new RemoteAgentProtocol('codex-app-server', (event, _time, childId) => routed.push({ event, ...(childId ? { childId } : {}) }))
    protocol.accept('input', { id: 'start', method: 'thread/start', params: {} }, time)
    protocol.accept('output', { id: 'start', result: { thread: { id: 'root' } } }, time)
    protocol.accept('output', { id: 'early', method: 'item/tool/requestUserInput', params: { threadId: 'child', questions: [{ id: 'answer', question: 'Answer?' }] } }, time)
    expect(routed.some(({ event }) => event.type === 'input.requested')).toBe(false)
    protocol.accept('output', { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root', name: 'Child' } } }, time)
    expect(routed).toContainEqual(expect.objectContaining({ childId: 'child', event: expect.objectContaining({ type: 'input.requested', requestId: 'early' }) }))
  })
})
