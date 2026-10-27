import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import agentChatsPlugin from '../program/plugins/agent-chats.js'
import { agentChatStateKey, type AgentChat } from '../program/plugins/agent-chats-api.js'
import orchestratorPlugin from '../program/plugins/orchestrator.js'
import type { OrchestratorSnapshot } from '../program/plugins/orchestrator-api.js'
import type { AgentProvider } from '../src/server/services/agent-registry.js'
import { agentRegistryPlugin } from '../src/server/services/agent-registry.js'
import { CodexService } from '../src/server/services/codex-service.js'
import { clientExtensionRegistryPlugin } from '../src/server/services/client-extension-registry.js'
import { WebGateway } from '../src/server/services/web-gateway.js'
import { turnProgramPlugin } from '../src/server/services/turn-program.js'
import type { HarnessEvent, JsonValue, ThreadHistoryPage } from '../src/shared/protocol.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'alto-agent-transport-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  const registry = await ctx.plugin(clientExtensionRegistryPlugin)
  cleanup.push(() => registry.dispose())
  const agents = await ctx.plugin(agentRegistryPlugin)
  cleanup.push(() => agents.dispose())
  const turns = await ctx.plugin(turnProgramPlugin)
  cleanup.push(() => turns.dispose())
  ctx.provide('program', {
    projectRoot: root, isActivating: () => false, commandRevision: () => 1,
    setClientActivator: () => () => {}, snapshot: () => ({ revision: 1 }),
  } as unknown as Context['program'])
  ctx.provide('projects', { snapshot: () => ({ projects: [] }) } as unknown as Context['projects'])
  ctx.provide('ui', { snapshot: () => ({}), register: () => ({}) } as unknown as Context['ui'])
  const createCodexProcess = vi.fn(() => {
    throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
  })
  const codex = new CodexService(ctx, { projectRoot: root, createProcess: createCodexProcess })
  ctx.provide('codex', codex)
  cleanup.push(async () => {
    await codex.stop()
    expect(createCodexProcess, 'ACP conversations must not start Codex').not.toHaveBeenCalled()
  })
  ctx.provide('tools', {} as Context['tools'])
  const steer = vi.fn(async () => 'injected' as const)
  const provider: AgentProvider = {
    snapshot: () => ({ id: 'claude', label: 'Claude', protocol: 'acp', status: 'ready', activeSessionIds: ['session'],
      capabilities: { images: false, resources: false, mcpServers: true, sessionHistory: true, sessionModes: false, steering: true } }),
    createSession: async () => ({ id: 'session', providerId: 'claude', cwd: root, createdAt: new Date().toISOString() }),
    prompt: async () => ({ id: 'turn', providerId: 'claude', sessionId: 'session', startedAt: new Date().toISOString() }),
    cancel: async () => {},
    steer,
    closeSession: async () => {},
    subscribe: () => () => {},
    stop: async () => {},
  }
  const registration = ctx.agents.register(ctx, provider)
  cleanup.push(() => registration.dispose())
  const chats = await ctx.plugin(agentChatsPlugin)
  cleanup.push(() => chats.dispose())
  const orchestrator = await ctx.plugin(orchestratorPlugin)
  cleanup.push(() => orchestrator.dispose())
  const gateway = new WebGateway(ctx, { projectRoot: root, controlSecret: 'test-secret', port: 0, development: false })
  cleanup.push(await gateway.start())
  const origin = `http://127.0.0.1:${gateway.port}`
  const bootstrap = await fetch(`${origin}/__cordis/session`, { headers: { Authorization: 'Bearer test-secret' } })
  const { protocol } = await bootstrap.json() as { protocol: string }
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', protocol, { origin })
  cleanup.push(() => { socket.terminate() })
  const events: HarnessEvent[] = []
  let bytes = 0
  socket.on('message', (data) => { bytes += data.toString().length; events.push(JSON.parse(data.toString()) as HarnessEvent) })
  await once(socket, 'open')
  await vi.waitFor(() => expect(events.some((event) => event.type === 'snapshot')).toBe(true))
  let commandId = 0
  const call = async (method: string, payload: JsonValue): Promise<unknown> => {
    const requestId = `test-${++commandId}`
    socket.send(JSON.stringify({ type: 'extension.call', requestId, programRevision: 1, payload: { method, payload } }))
    const result = await vi.waitFor(() => {
      const event = events.find((event) => event.type === 'command.result' && event.requestId === requestId)
      expect(event?.type).toBe('command.result')
      return event as Extract<HarnessEvent, { type: 'command.result' }>
    })
    expect(result.error).toBeUndefined()
    return result.payload
  }
  return { ctx, root, socket, events, steer, call, bytes: () => bytes }
}

it('keeps the harness connected while many subagents publish large transcripts', async () => {
  const f = await fixture()
  const chat = await f.ctx.agentChats.create('claude', process.cwd(), 'ask')
  const base = { providerId: 'claude', sessionId: 'session', turnId: 'turn', occurredAt: new Date().toISOString() }
  f.ctx.agentChats.event({ ...base, type: 'turn.started' })
  const output = 'Subagent output. '.repeat(20_000)
  for (let index = 0; index < 21; index += 1) {
    const taskId = `child-${index}`
    f.ctx.agentChats.event({ ...base, type: 'task.started', taskId, parentSessionId: 'session', title: `Agent ${index}`, prompt: '', taskKind: 'subagent', canStop: true })
    f.ctx.agentChats.event({ ...base, sessionId: taskId, type: 'message.delta', role: 'agent', content: { type: 'text', text: output } })
  }
  await vi.waitFor(() => expect(f.ctx.clientExtensions.snapshot()[agentChatStateKey(chat.summary.id)]).toBeDefined())
  // Unrelated UI state must not amplify child history into a disconnect burst.
  const progress = f.ctx.clientExtensions.registerState(f.ctx, 'test-progress', 0)
  for (let index = 1; index <= 3; index += 1) progress.update(index)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(f.socket.readyState, 'The harness dropped the socket during the subagent update burst').toBe(WebSocket.OPEN)
  await vi.waitFor(() => expect(f.events.some((event) => event.type === 'extensions.updated' && event.payload['test-progress'] === 3)).toBe(true))
  expect(f.socket.readyState).toBe(WebSocket.OPEN)
  expect(f.bytes()).toBeLessThan(8 * 1024 * 1024)
  const state = f.ctx.clientExtensions.snapshot()[agentChatStateKey(chat.summary.id)] as Record<string, JsonValue>
  expect(state.turn).toBe('running')
  expect((state.children as JsonValue[])).toHaveLength(21)
  const tasks = f.ctx.clientExtensions.snapshot().orchestrator as unknown as OrchestratorSnapshot
  expect(tasks.tasks).toHaveLength(21)
  expect(tasks.tasks.every((task) => task.status === 'working' && task.result.length <= 16_000)).toBe(true)
  const opened = await f.call('agent-chats.open', { id: chat.summary.id }) as AgentChat
  expect(opened.children?.every((child) => child.activities.length === 0 && child.task.result.length <= 16_000)).toBe(true)
  const steered = await f.call('agent-chats.steer', { id: chat.summary.id, input: [{ type: 'text', text: 'Focus on the remaining work' }] }) as AgentChat
  expect(f.steer).toHaveBeenCalledWith('session', [{ type: 'text', text: 'Focus on the remaining work' }], { additionalContext: {} })
  expect(steered.turn).toBe('running')
  expect(steered.children?.every((child) => child.activities.length === 0)).toBe(true)
  const history = await f.call('orchestrator.open', { parentThreadId: chat.summary.id, id: chat.children![0]!.task.id }) as ThreadHistoryPage
  expect(history.messages.at(-1)?.text).toBe(output)
  expect(f.socket.readyState).toBe(WebSocket.OPEN)
  await f.ctx.agentChats.rename(chat.summary.id, 'Large chat')
  const saved = JSON.parse(await readFile(path.join(f.root, '.codex-cordis', 'agent-chats', `${chat.summary.id}.json`), 'utf8')) as AgentChat
  expect(saved.children?.[0]?.activities.at(-1)?.content).toBe(output)
  expect(saved.children?.[0]?.task.result).toBe(output)
})
