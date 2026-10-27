import { readFileSync } from 'node:fs'
import * as acp from '@agentclientprotocol/sdk'
import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import acpPlugin, { AcpProcessProvider, type AcpProcessProviderOptions } from '../program/plugins/acp-provider.js'
import { configOptions } from '../program/plugins/acp-format.js'
import { initialAgentConfig } from '../program/plugins/agent-model-options.js'
import { entriesOf, parseProgramProfile } from '../src/server/program-profile.js'
import { agentRegistryPlugin, type AgentEvent } from '../src/server/services/agent-registry.js'

const models = {
  currentModelId: 'auto',
  availableModels: [
    { modelId: 'auto', name: 'Auto', description: 'Let Gemini choose' },
    { modelId: 'gemini-test-flash', name: 'Flash' },
  ],
}
const modes = {
  currentModeId: 'default',
  availableModes: [{ id: 'default', name: 'Default', description: 'Prompts for approval' }, { id: 'plan', name: 'Plan' }],
}
const setupHint = 'Run `gemini` in a terminal to sign in, then select Gemini again.'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function fixture(agent: acp.AgentApp) {
  const provider = new AcpProcessProvider({
    id: 'gemini', label: 'Gemini', command: 'unused', setupHint,
    openConnection: client => {
      const connection = client.connect(agent)
      return { connection, close: () => connection.close() }
    },
  })
  cleanup.push(() => provider.stop())
  const events: AgentEvent[] = []
  provider.subscribe(event => events.push(event))
  return { provider, events }
}

function gemini() {
  return acp.agent({ name: 'gemini-cli' })
    .onRequest('initialize', () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: true } },
    }))
}

describe('Gemini ACP integration', () => {
  it('registers Gemini lazily in the default profile and unloads only its provider', async () => {
    const profile = parseProgramProfile(readFileSync(new URL('../program/cordis.json', import.meta.url), 'utf8'))
    const entry = entriesOf(profile).find(({ entry }) => entry.id === 'gemini-acp')!.entry
    expect(entry).toMatchObject({ enabled: true, module: 'plugins/acp-provider.ts', config: {
      id: 'gemini', label: 'Gemini', command: 'gemini', args: ['--acp'], env: { GEMINI_CLI_NO_RELAUNCH: 'true' },
    } })
    const root = new Context()
    const registry = await root.plugin(agentRegistryPlugin)
    cleanup.push(() => registry.dispose())
    const fiber = await root.plugin(acpPlugin, entry.config as unknown as AcpProcessProviderOptions)
    cleanup.push(() => fiber.dispose())
    const provider = root.agents.provider('gemini').snapshot()
    expect(provider).toMatchObject({
      label: 'Gemini', protocol: 'acp', status: 'stopped', activeSessionIds: [],
    })
    expect(provider.configOptions).toEqual(initialAgentConfig('gemini'))
    await fiber.dispose()
    expect(() => root.agents.provider('gemini')).toThrow()
  })

  it('uses Gemini defaults without exposing the legacy model API, and streams through the shared provider', async () => {
    const agent = gemini()
      .onRequest('session/new', ctx => {
        expect(ctx.params.mcpServers).toEqual([{ type: 'http', name: 'alto', url: 'http://127.0.0.1:1234/mcp', headers: [] }])
        return { sessionId: 'gemini-session', models, modes }
      })
      .onRequest('session/prompt', async ctx => {
        expect(ctx.params.prompt).toEqual([{ type: 'text', text: 'Hello Gemini' }])
        await ctx.client.notify('session/update', { sessionId: ctx.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from Gemini' } } })
        return { stopReason: 'end_turn' }
      })
    const { provider, events } = fixture(agent)
    const session = await provider.createSession({ cwd: '/tmp', permissionMode: 'ask',
      mcpServers: [{ type: 'http', name: 'alto', url: 'http://127.0.0.1:1234/mcp' }] })
    expect(session.configOptions?.some(option => option.category === 'model')).toBe(false)
    await expect(provider.configure(session.id, '__model', 'gemini-test-flash')).rejects.toThrow('Invalid agent configuration')
    await provider.prompt(session.id, [{ type: 'text', text: 'Hello Gemini' }])
    await vi.waitFor(() => expect(events.some(event => event.type === 'turn.completed')).toBe(true))
    expect(events).toContainEqual(expect.objectContaining({ type: 'message.delta', providerId: 'gemini',
      content: { type: 'text', text: 'Hello from Gemini' } }))
    expect(provider.snapshot().capabilities).toMatchObject({ images: true, mcpServers: true, steering: false })
  })

  it('resumes the exact saved session with Gemini defaults', async () => {
    const load = vi.fn()
    const { provider } = fixture(gemini().onRequest('session/load', ctx => {
      load(ctx.params)
      return { models, modes }
    }))
    const session = await provider.loadSession('saved-gemini', { cwd: '/tmp', permissionMode: 'ask' })
    expect(load).toHaveBeenCalledWith({ sessionId: 'saved-gemini', cwd: '/tmp', mcpServers: [] })
    expect(session).toMatchObject({ id: 'saved-gemini', providerId: 'gemini' })
    expect(session.configOptions?.some(option => option.category === 'model')).toBe(false)
  })

  it('does not publish a configuration change after its session is closed', async () => {
    let finish!: () => void
    const options = (value: string): acp.SessionConfigOption[] => [{ id: 'model', name: 'Model', type: 'select', category: 'model',
      currentValue: value, options: [{ value: 'auto', name: 'Auto' }, { value: 'flash', name: 'Flash' }] }]
    const { provider, events } = fixture(gemini()
      .onRequest('session/new', () => ({ sessionId: 'session', configOptions: options('auto') }))
      .onRequest('session/set_config_option', () => new Promise(resolve => { finish = () => resolve({ configOptions: options('flash') }) })))
    await provider.createSession({ cwd: '/tmp', permissionMode: 'ask' })
    const change = provider.configure('session', 'model', 'flash')
    const rejected = expect(change).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await provider.closeSession('session')
    finish()
    await rejected
    expect(events.some(event => event.type === 'config.updated')).toBe(false)
  })

  it.each(['create', 'load'])('gives sign-in guidance when authentication fails during %s', async operation => {
    const { provider } = fixture(gemini()
      .onRequest('session/new', () => { throw acp.RequestError.authRequired() })
      .onRequest('session/load', () => { throw acp.RequestError.authRequired() }))
    const options = { cwd: '/tmp', permissionMode: 'ask' as const }
    await expect(operation === 'create' ? provider.createSession(options) : provider.loadSession('saved', options)).rejects.toThrow(setupHint)
    expect(provider.snapshot().activeSessionIds).toEqual([])
  })

  it('retains protocol failures without presenting them as authentication failures', async () => {
    const { provider } = fixture(gemini().onRequest('session/new', () => { throw acp.RequestError.invalidParams() }))
    await expect(provider.createSession({ cwd: '/tmp', permissionMode: 'ask' })).rejects.toMatchObject({ code: -32602 })
  })

  it('includes setup guidance when the Gemini executable is missing', async () => {
    const provider = new AcpProcessProvider({ id: 'gemini', label: 'Gemini', command: '/missing/alto-gemini-cli', setupHint })
    cleanup.push(() => provider.stop())
    await expect(provider.createSession({ cwd: '/tmp', permissionMode: 'ask' })).rejects.toThrow(setupHint)
    expect(provider.snapshot()).toMatchObject({ status: 'failed', error: expect.stringContaining('ENOENT') })
  })
})

it('uses standard ACP configuration and ignores the legacy model catalog', () => {
  const response = { models, configOptions: [{ id: 'model', name: 'Model', type: 'select' as const, category: 'model',
    currentValue: 'new', options: [{ value: 'new', name: 'New model' }] }] }
  expect(configOptions(response)).toEqual([{ id: 'model', name: 'Model', category: 'model', currentValue: 'new',
    options: [{ value: 'new', name: 'New model' }] }])
  expect(configOptions({ ...response, configOptions: [] })).toEqual([])
})
