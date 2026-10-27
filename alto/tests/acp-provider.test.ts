import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  AcpProcessProvider,
  type AcpConnectionFactory,
} from '../program/plugins/acp-provider.js'
import type { AgentEvent } from '../src/server/services/agent-registry.js'

function directConnection(agent: acp.AgentApp): AcpConnectionFactory {
  return (client) => {
    const connection = client.connect(agent)
    return { connection, close: () => connection.close() }
  }
}

function completedEvent(events: AgentEvent[]): Promise<AgentEvent> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const event = events.find((candidate) => candidate.type === 'turn.completed')
      if (!event) return
      clearInterval(interval)
      resolve(event)
    }, 1)
  })
}

describe('ACP process provider', () => {
  it('offers Claude model aliases before opening an agent connection', async () => {
    const openConnection = vi.fn<AcpConnectionFactory>()
    const provider = new AcpProcessProvider({ id: 'claude', label: 'Claude', command: 'unused', openConnection })
    expect(provider.snapshot().configOptions?.[0]?.options.map((option) => option.value)).toEqual(['default', 'claude-opus-5-5', 'opus', 'sonnet', 'haiku'])
    expect(provider.snapshot().configOptions?.find((option) => option.category === 'thought_level')?.options.map((option) => option.value)).toContain('max')
    expect(provider.snapshot().activeSessionIds).toEqual([])
    expect(openConnection).not.toHaveBeenCalled()
    await provider.stop()
  })

  it('negotiates stable ACP, normalizes updates, and applies the captured permission mode', async () => {
    let permissionOutcome: acp.RequestPermissionResponse | undefined
    const agent = acp.agent({ name: 'test-agent' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          mcpCapabilities: { http: true },
          sessionCapabilities: { close: {} },
        },
        agentInfo: { name: 'Test ACP Agent', version: '1.2.3' },
      }))
      .onRequest(acp.methods.agent.session.new, (ctx) => ({
        sessionId: `session:${ctx.params.cwd}`,
        modes: {
          currentModeId: 'default',
          availableModes: [{ id: 'default', name: 'Default' }],
        },
      }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        permissionOutcome = await ctx.client.request(
          acp.methods.client.session.requestPermission,
          {
            sessionId: ctx.params.sessionId,
            toolCall: {
              toolCallId: 'tool-1',
              title: 'Read package metadata',
              kind: 'read',
              status: 'pending',
            },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        )
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Read package metadata',
            kind: 'read',
            status: 'in_progress',
          },
        })
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'message-1',
            content: { type: 'text', text: 'Done.' },
          },
        })
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'plan',
            entries: [{ content: 'Inspect metadata', priority: 'high', status: 'completed' }],
          },
        })
        return { stopReason: 'end_turn' }
      })
      .onRequest(acp.methods.agent.session.close, () => ({}))

    const provider = new AcpProcessProvider({
      id: 'test-acp',
      label: 'Test ACP',
      command: 'unused-in-test',
      openConnection: directConnection(agent),
    })
    const events: AgentEvent[] = []
    provider.subscribe((event) => events.push(event))

    const session = await provider.createSession({
      cwd: '/tmp/acp-project',
      permissionMode: 'full',
    })
    const completion = completedEvent(events)
    const turn = await provider.prompt(session.id, [{ type: 'text', text: 'Inspect it.' }])
    await completion

    expect(turn.providerId).toBe('test-acp')
    expect(permissionOutcome).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })
    expect(provider.snapshot()).toMatchObject({
      status: 'ready',
      version: '1.2.3',
      capabilities: {
        images: true,
        resources: true,
        mcpServers: true,
        sessionHistory: true,
        sessionModes: true,
      },
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'permission.requested', toolCallId: 'tool-1' }),
      expect.objectContaining({ type: 'tool.started', title: 'Read package metadata' }),
      expect.objectContaining({
        type: 'message.delta',
        role: 'agent',
        content: { type: 'text', text: 'Done.' },
      }),
      expect.objectContaining({
        type: 'plan.updated',
        entries: [{ content: 'Inspect metadata', priority: 'high', status: 'completed' }],
      }),
      expect.objectContaining({ type: 'turn.completed', stopReason: 'end_turn' }),
    ]))

    await provider.closeSession(session.id)
    expect(provider.snapshot().activeSessionIds).toEqual([])
    await provider.stop()
  })

  it('waits for the user to resolve an ACP permission request outside full access', async () => {
    let permissionOutcome: acp.RequestPermissionResponse | undefined
    const agent = acp.agent({ name: 'permission-test-agent' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({
        protocolVersion: ctx.params.protocolVersion,
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'ask-session' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        permissionOutcome = await ctx.client.request(
          acp.methods.client.session.requestPermission,
          {
            sessionId: ctx.params.sessionId,
            toolCall: { toolCallId: 'tool-2', title: 'Write a file' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        )
        return { stopReason: 'end_turn' }
      })

    const provider = new AcpProcessProvider({
      id: 'ask-acp',
      label: 'Ask ACP',
      command: 'unused-in-test',
      openConnection: directConnection(agent),
    })
    const events: AgentEvent[] = []
    provider.subscribe((event) => events.push(event))
    const session = await provider.createSession({ cwd: '/tmp/acp-project', permissionMode: 'ask' })
    const completion = completedEvent(events)
    await provider.prompt(session.id, [{ type: 'text', text: 'Try it.' }])
    await vi.waitFor(() => expect(events.some((event) => event.type === 'permission.requested')).toBe(true))
    const request = events.find((event) => event.type === 'permission.requested')!
    if (request.type !== 'permission.requested') throw new Error('Missing permission request')
    expect(permissionOutcome).toBeUndefined()
    await expect(provider.resolvePermission(request.requestId, 'invalid-option')).rejects.toThrow('Invalid permission option')
    await provider.resolvePermission(request.requestId, 'allow')
    await completion

    expect(permissionOutcome).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })
    await expect(provider.resolvePermission(request.requestId, 'reject')).rejects.toThrow('no longer pending')
    await provider.stop()
  })

  it('cancels a pending permission when the turn is stopped', async () => {
    let outcome: acp.RequestPermissionResponse | undefined
    const agent = acp.agent({ name: 'cancel-test' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({ protocolVersion: ctx.params.protocolVersion }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'cancel-session' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        outcome = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId, toolCall: { toolCallId: 'write-file', title: 'Write a file' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        })
        return { stopReason: 'cancelled' }
      })
      .onNotification(acp.methods.agent.session.cancel, () => {})
    const provider = new AcpProcessProvider({ id: 'cancel', label: 'Cancel', command: 'unused', openConnection: directConnection(agent) })
    const events: AgentEvent[] = []
    provider.subscribe((event) => events.push(event))
    try {
      const session = await provider.createSession({ cwd: '/tmp/acp-project', permissionMode: 'ask' })
      await provider.prompt(session.id, [{ type: 'text', text: 'Write it' }])
      await vi.waitFor(() => expect(events.some((event) => event.type === 'permission.requested')).toBe(true))
      await provider.cancel(session.id)
      await vi.waitFor(() => expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } }))
      await vi.waitFor(() => expect(events.some((event) => event.type === 'turn.completed')).toBe(true))
    } finally { await provider.stop() }
  })

  it('reloads the same provider session and working directory after restart', async () => {
    const loaded = vi.fn()
    const agent = acp.agent({ name: 'resume-test' })
      .onRequest(acp.methods.agent.initialize, (ctx) => ({ protocolVersion: ctx.params.protocolVersion, agentCapabilities: { loadSession: true } }))
      .onRequest(acp.methods.agent.session.load, (ctx) => { loaded(ctx.params); return {} })
    const provider = new AcpProcessProvider({ id: 'resume', label: 'Resume', command: 'unused', openConnection: directConnection(agent) })
    try {
      const session = await provider.loadSession('saved-session', { cwd: '/tmp/acp-project', permissionMode: 'ask' })
      expect(session.id).toBe('saved-session')
      expect(loaded).toHaveBeenCalledWith({ sessionId: 'saved-session', cwd: '/tmp/acp-project', mcpServers: [] })
      expect(provider.snapshot().activeSessionIds).toEqual(['saved-session'])
    } finally { await provider.stop() }
  })
  it('negotiates form questions, waits for answers even in full mode, and applies configuration', async () => {
    let answer: acp.CreateElicitationResponse | undefined
    const config = (value: string): acp.SessionConfigOption[] => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: value,
      options: [{ group: 'models', name: 'Models', options: [{ value: 'a', name: 'Model A' }, { value: 'b', name: 'Model B' }] }] }]
    const agent = acp.agent({ name: 'questions' })
      .onRequest(acp.methods.agent.initialize, (ctx) => {
        expect(ctx.params.clientCapabilities?.elicitation?.form).toEqual({})
        return { protocolVersion: ctx.params.protocolVersion }
      })
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'questions', configOptions: config('a') }))
      .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => ({ configOptions: config(String(ctx.params.value)) }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        answer = await ctx.client.request(acp.methods.client.elicitation.create, { sessionId: 'questions', mode: 'form', message: 'Choose a color',
          requestedSchema: { type: 'object', properties: { color: { type: 'string', enum: ['red', 'blue'] } }, required: ['color'] } })
        return { stopReason: 'end_turn' }
      })
    const provider = new AcpProcessProvider({ id: 'questions', label: 'Questions', command: 'unused', openConnection: directConnection(agent) })
    const events: AgentEvent[] = []
    provider.subscribe((event) => events.push(event))
    try {
      const session = await provider.createSession({ cwd: '/tmp', permissionMode: 'full' })
      expect(session.configOptions?.[0]?.options).toHaveLength(2)
      await expect(provider.configure(session.id, 'model', 'unknown')).rejects.toThrow('Invalid agent configuration')
      expect((await provider.configure(session.id, 'model', 'b'))[0]?.currentValue).toBe('b')
      await provider.prompt(session.id, [{ type: 'text', text: 'Ask me' }])
      await vi.waitFor(() => expect(events.some((event) => event.type === 'input.requested')).toBe(true))
      const request = events.find((event) => event.type === 'input.requested')!
      if (request.type !== 'input.requested') throw new Error('Missing question')
      expect(answer).toBeUndefined()
      await expect(provider.resolveInput(request.requestId, { action: 'accept', content: { color: 'green' } })).rejects.toThrow('offered value')
      await provider.resolveInput(request.requestId, { action: 'accept', content: { color: 'blue' } })
      await vi.waitFor(() => expect(answer).toEqual({ action: 'accept', content: { color: 'blue' } }))
      await expect(provider.resolveInput(request.requestId, { action: 'decline' })).rejects.toThrow('no longer pending')
    } finally { await provider.stop() }
  })

})

describe('Claude ACP extensions', () => {
  it('injects steering and waits for the original turn to settle before idle fallback', async () => {
    const { z } = await import('zod')
    let finish!: (value: acp.PromptResponse) => void
    let running = true
    const requests: unknown[] = []
    const agent = acp.agent().onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, _meta: { steering: { supported: true } } }))
      .onRequest('session/new', () => ({ sessionId: 'root' }))
      .onRequest('session/prompt', () => new Promise<acp.PromptResponse>((resolve) => { finish = resolve }))
      .onRequest('_session/steering', z.unknown(), (ctx) => { requests.push(ctx.params); return { outcome: running ? 'injected' : 'promptRequired' } })
    const provider = new AcpProcessProvider({ id: 'claude', label: 'Claude', command: 'unused', openConnection: directConnection(agent) })
    const events: AgentEvent[] = []
    provider.subscribe((event) => events.push(event))
    try {
      await provider.createSession({ cwd: '/tmp', permissionMode: 'ask' })
      expect(provider.snapshot().capabilities.steering).toBe(true)
      await provider.prompt('root', [{ type: 'text', text: 'Start' }])
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      expect(await provider.steer('root', [{ type: 'text', text: 'Change direction' }])).toBe('injected')
      expect(requests[0]).toMatchObject({ sessionId: 'root', prompt: [{ type: 'text', text: 'Change direction' }], _meta: { steering: { idleBehavior: 'promptRequired' } } })
      running = false
      let settled = false
      const fallback = provider.steer('root', [{ type: 'text', text: 'Next' }]).then((value) => { settled = true; return value })
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      expect(settled).toBe(false)
      finish({ stopReason: 'end_turn' })
      expect(await fallback).toBe('promptRequired')
      expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    } finally { await provider.stop() }
  })

  it('negotiates children, routes nested transcripts and approvals, and scopes stopping', async () => {
    const { z } = await import('zod')
    const { childCapabilities, withChildUpdates } = await import('../program/plugins/acp-extensions.js')
    let peer!: acp.AgentContext
    let finish!: (response: acp.PromptResponse) => void
    const stopped: unknown[] = []
    const agent = acp.agent().onRequest('initialize', (ctx) => {
      expect(ctx.params.clientCapabilities?._meta).toEqual(childCapabilities)
      return { protocolVersion: acp.PROTOCOL_VERSION, _meta: childCapabilities }
    }).onRequest('session/new', () => ({ sessionId: 'root' }))
      .onRequest('session/prompt', (ctx) => { peer = ctx.client; return new Promise<acp.PromptResponse>((resolve) => { finish = resolve }) })
      .onRequest('_session/async_task/stop', z.unknown(), (ctx) => { stopped.push(ctx.params); return { stopped: true } })
    const provider = new AcpProcessProvider({ id: 'claude', label: 'Claude', command: 'unused', openConnection: (client) => {
      const toAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
      const toClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
      const remote = agent.connect({ writable: toClient.writable, readable: toAgent.readable })
      const connection = client.connect(withChildUpdates({ writable: toAgent.writable, readable: toClient.readable }))
      return { connection, close: () => { connection.close(); remote.close() } }
    } })
    const events: AgentEvent[] = []
    provider.subscribe((event) => events.push(event))
    const update = async (sessionId: string, update: Record<string, unknown>) => peer.notify('session/update' as string, { sessionId, update })
    try {
      await provider.createSession({ cwd: '/tmp', permissionMode: 'ask' })
      await provider.prompt('root', [{ type: 'text', text: 'Delegate' }])
      await vi.waitFor(() => expect(peer).toBeDefined())
      await update('root', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'Review', task: 'Review code', capabilities: {} })
      await update('child', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Child output' } })
      await update('child', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'grandchild', name: 'Nested', task: 'Inspect', capabilities: {} })
      await update('root', { sessionUpdate: 'async_task_spawned', asyncTaskId: 'background', name: 'Build', description: 'Build', canStop: true })
      await vi.waitFor(() => expect(events.filter((event) => event.type === 'task.started')).toHaveLength(3))
      expect(events).toContainEqual(expect.objectContaining({ type: 'message.delta', sessionId: 'child', content: { type: 'text', text: 'Child output' } }))
      provider.setPermissionMode('root', 'full')
      const decision = peer.request('session/request_permission', { sessionId: 'grandchild', toolCall: { toolCallId: 'write', title: 'Write' }, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] })
      await vi.waitFor(() => expect(events.some((event) => event.type === 'permission.requested')).toBe(true))
      const request = events.find((event) => event.type === 'permission.requested')!
      if (request.type !== 'permission.requested') throw new Error('Missing request')
      expect(request.sessionId).toBe('grandchild')
      await provider.resolvePermission(request.requestId, 'yes')
      expect(await decision).toMatchObject({ outcome: { optionId: 'yes' } })
      await expect(provider.stopTask('other-root', 'background')).rejects.toThrow('no longer running')
      await expect(provider.stopTask('root', 'child')).rejects.toThrow('cannot stop this child separately')
      await provider.stopTask('root', 'background')
      expect(stopped).toEqual([{ sessionId: 'root', asyncTaskId: 'background' }])
      await update('child', { sessionUpdate: 'subagent_state_update', subagentSessionId: 'grandchild', state: 'completed' })
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'task.updated', taskId: 'grandchild', status: 'done' })))
      finish({ stopReason: 'end_turn' })
    } finally { await provider.stop() }
  })
})
