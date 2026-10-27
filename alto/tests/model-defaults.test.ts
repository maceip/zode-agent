import { Context, type Plugin } from 'cordis'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import modelDefaultsPlugin from '../program/plugins/model-defaults.js'
import {
  MODEL_DEFAULTS_DISCOVER,
  MODEL_DEFAULTS_SET,
  MODEL_DEFAULTS_STATE,
  MODEL_DEFAULTS_STATUS,
  modelDefaults,
  type ModelDefaultsPreferences,
} from '../program/plugins/model-defaults-api.js'
import * as preferenceStore from '../program/plugins/model-defaults-store.js'
import {
  AgentRegistry,
  type AgentConfigOption,
  type AgentEventListener,
  type AgentProvider,
  type AgentProviderSnapshot,
  type AgentSession,
  type AgentSessionOptions,
} from '../src/server/services/agent-registry.js'
import { ClientExtensionRegistry } from '../src/server/services/client-extension-registry.js'
import type { CodexService } from '../src/server/services/codex-service.js'
import type { ProgramRuntime } from '../src/server/services/program-runtime.js'
import { DynamicToolRegistry } from '../src/server/services/tool-registry.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
})

function config(model: string): AgentConfigOption[] {
  return [{ id: 'model', name: 'Model', category: 'model', currentValue: model,
    options: [{ value: model, name: model }] }]
}

class Provider implements AgentProvider {
  private readonly sessions = new Set(['existing-chat'])
  readonly base: AgentProviderSnapshot
  readonly discovered = config('gemini-4-argon')
  readonly createSession = vi.fn(async (options: AgentSessionOptions): Promise<AgentSession> => {
    this.sessions.add('temporary')
    return { id: 'temporary', providerId: this.base.id, cwd: options.cwd,
      createdAt: new Date(0).toISOString(), configOptions: structuredClone(this.discovered) }
  })
  readonly closeSession = vi.fn(async (id: string) => { this.sessions.delete(id) })
  readonly prompt = vi.fn(async (sessionId: string) => ({ id: 'turn', providerId: this.base.id,
    sessionId, startedAt: new Date(0).toISOString() }))
  readonly cancel = vi.fn(async () => {})
  readonly stop = vi.fn(async () => {})

  constructor(overrides: Partial<AgentProviderSnapshot> = {}) {
    this.base = { id: 'gemini', label: 'Gemini', protocol: 'acp', status: 'ready',
      capabilities: { images: false, resources: false, mcpServers: false, sessionHistory: false, sessionModes: false },
      activeSessionIds: [], configOptions: config('fallback'), ...overrides }
  }
  snapshot(): AgentProviderSnapshot {
    return structuredClone({ ...this.base, activeSessionIds: [...this.sessions] })
  }
  subscribe(_listener: AgentEventListener): () => void { return () => {} }
}

async function fixture(options: {
  saved?: string
  providers?: Provider[]
  configRead?: Promise<unknown>
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alto-model-defaults-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, '.codex-cordis', 'model-defaults.json')
  if (options.saved !== undefined) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, options.saved)
  }
  const codex = {
    readConfig: vi.fn(() => options.configRead ?? Promise.resolve({ model: 'native-model', model_reasoning_effort: 'high' })),
    snapshot: vi.fn(() => ({ status: 'ready', activeThreadIds: ['native-chat'], models: [
      { id: 'native-model', displayName: 'Native', isDefault: true, defaultReasoningEffort: 'medium' },
    ], threadStates: {}, threadSettings: {} })),
  }
  const ctx = new Context()
  const services: Plugin = (owner) => {
    owner.provide('clientExtensions', new ClientExtensionRegistry(owner.root))
    owner.provide('agents', new AgentRegistry(owner.root))
    owner.provide('tools', new DynamicToolRegistry(owner.root))
    owner.provide('codex', codex as unknown as CodexService)
    owner.provide('program', { projectRoot: directory } as ProgramRuntime)
  }
  services.provide = ['clientExtensions', 'agents', 'tools', 'codex', 'program']
  const servicesFiber = await ctx.plugin(services)
  cleanup.push(() => servicesFiber.dispose())
  const providers = options.providers ?? [new Provider(), new Provider({ id: 'claude', label: 'Claude' })]
  for (const provider of providers) {
    const register: Plugin = (owner) => { owner.agents.register(owner, provider) }
    register.inject = ['agents']
    const fiber = await ctx.plugin(register)
    cleanup.push(() => fiber.dispose())
  }
  const mount = async () => {
    const fiber = await ctx.plugin(modelDefaultsPlugin)
    cleanup.push(() => fiber.dispose())
    return fiber
  }
  const fiber = await mount()
  const preferences = () => modelDefaults(ctx.clientExtensions.snapshot()[MODEL_DEFAULTS_STATE])
  return { ctx, codex, providers, file, fiber, mount, preferences }
}

describe('model defaults preferences', () => {
  it('distinguishes missing state from saved defaults and rejects malformed fields', () => {
    expect(modelDefaults(undefined)).toBeUndefined()
    expect(modelDefaults(null)).toBeUndefined()
    expect(modelDefaults({ providerId: 'gemini', choices: { gemini: { model: 123 } } })).toBeUndefined()
    expect(modelDefaults({ providerId: '../gemini', choices: {} })).toBeUndefined()
    expect(modelDefaults({ providerId: 'gemini', choices: { gemini: { model: 'argon', effort: 'high' } } }))
      .toEqual({ providerId: 'gemini', choices: { gemini: { model: 'argon', effort: 'high' } } })
  })

  it('registers and saves defaults without starting an ACP provider', async () => {
    const f = await fixture({ configRead: new Promise(() => {}) })
    expect(f.ctx.clientExtensions.describe().methods.map((method) => method.name)).toContain(MODEL_DEFAULTS_SET)
    await f.ctx.clientExtensions.call(MODEL_DEFAULTS_SET, { providerId: 'gemini', model: 'gemini-4-argon' })
    expect(f.preferences()).toEqual({ providerId: 'gemini', choices: { gemini: { model: 'gemini-4-argon' } } })
    for (const provider of f.providers) expect(provider.createSession).not.toHaveBeenCalled()
  })

  it('queues saves behind restoration, preserves per-provider choices, and only clears explicit null fields', async () => {
    const f = await fixture({ saved: JSON.stringify({ version: 1, providerId: 'gemini',
      choices: { gemini: { model: 'old', effort: 'high' }, claude: { model: 'opus', effort: 'medium' } } }) })
    await Promise.all([
      f.ctx.clientExtensions.call(MODEL_DEFAULTS_SET, { providerId: 'gemini', model: 'gemini-4-argon' }),
      f.ctx.clientExtensions.call(MODEL_DEFAULTS_SET, { providerId: 'claude', effort: 'max' }),
      f.ctx.clientExtensions.call(MODEL_DEFAULTS_SET, { providerId: 'gemini', model: null }),
    ])
    const expected: ModelDefaultsPreferences = { providerId: 'gemini', choices: {
      gemini: { effort: 'high' }, claude: { model: 'opus', effort: 'max' },
    } }
    expect(f.preferences()).toEqual(expected)
    expect(JSON.parse(await readFile(f.file, 'utf8'))).toEqual({ version: 1, ...expected })
    expect((await stat(f.file)).mode & 0o777).toBe(0o600)
    expect(await readdir(path.dirname(f.file))).toEqual(['model-defaults.json'])
    await f.fiber.dispose()
    await f.mount()
    await vi.waitFor(() => expect(f.preferences()).toEqual(expected))
  })

  it.each(['{broken json', JSON.stringify({ version: 1, providerId: 'gemini', choices: { gemini: { effort: [] } } })])(
    'uses safe defaults when saved preferences are invalid: %s', async (saved) => {
      const f = await fixture({ saved })
      await vi.waitFor(() => expect(f.preferences()).toEqual({ providerId: 'codex', choices: {} }))
    },
  )

  it('falls back from a disabled saved provider and refuses selecting an unregistered provider', async () => {
    const f = await fixture({ saved: JSON.stringify({ version: 1, providerId: 'disabled',
      choices: { disabled: { model: 'remembered' } } }) })
    await vi.waitFor(() => expect(f.preferences()).toEqual({ providerId: 'codex', choices: { disabled: { model: 'remembered' } } }))
    await expect(f.ctx.clientExtensions.call(MODEL_DEFAULTS_SET, { providerId: 'disabled' })).rejects.toThrow('no longer enabled')
    await expect(f.ctx.clientExtensions.call(MODEL_DEFAULTS_SET, { providerId: 'gemini', model: '' })).rejects.toThrow('nonempty')
    await f.ctx.clientExtensions.call(MODEL_DEFAULTS_SET, { providerId: 'codex', model: 'native-model' })
    expect(f.preferences()?.providerId).toBe('codex')
  })

  it('does not publish failed writes, and later saves still succeed', async () => {
    const f = await fixture()
    await vi.waitFor(() => expect(f.preferences()?.providerId).toBe('codex'))
    vi.spyOn(preferenceStore, 'writeModelDefaults').mockRejectedValueOnce(new Error('Disk full'))
    await expect(f.ctx.clientExtensions.call(MODEL_DEFAULTS_SET, { providerId: 'gemini', model: 'failed' })).rejects.toThrow('Disk full')
    expect(f.preferences()).toEqual({ providerId: 'codex', choices: {} })
    await f.ctx.clientExtensions.call(MODEL_DEFAULTS_SET, { providerId: 'gemini', model: 'works' })
    expect(f.preferences()).toEqual({ providerId: 'gemini', choices: { gemini: { model: 'works' } } })
  })

  it('waits for an in-flight save on disposal without updating inactive state', async () => {
    const f = await fixture()
    const write = preferenceStore.writeModelDefaults
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const spy = vi.spyOn(preferenceStore, 'writeModelDefaults').mockImplementation(async (...args) => {
      await pending
      await write(...args)
    })
    const save = f.ctx.clientExtensions.call(MODEL_DEFAULTS_SET, { providerId: 'gemini', model: 'saved-during-reload' })
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
    const disposing = f.fiber.dispose()
    await vi.waitFor(() => expect(f.ctx.clientExtensions.snapshot()[MODEL_DEFAULTS_STATE]).toBeUndefined())
    finish()
    await save
    await disposing
    spy.mockRestore()
    await f.mount()
    await vi.waitFor(() => expect(f.preferences()?.choices.gemini?.model).toBe('saved-during-reload'))
  })

  it('ignores saved preferences arriving after disposal', async () => {
    let load!: (saved: ModelDefaultsPreferences) => void
    const loading = new Promise<ModelDefaultsPreferences>((resolve) => { load = resolve })
    vi.spyOn(preferenceStore, 'readModelDefaults').mockReturnValueOnce(loading)
    const f = await fixture()
    const disposing = f.fiber.dispose()
    await vi.waitFor(() => expect(f.ctx.clientExtensions.snapshot()[MODEL_DEFAULTS_STATE]).toBeUndefined())
    load({ providerId: 'gemini', choices: {} })
    await disposing
    expect(f.ctx.clientExtensions.snapshot()).toEqual({})
    expect(f.ctx.tools.list()).toEqual([])
  })
})

describe('explicit agent model discovery', () => {
  it.each([{}, { location: { id: 'local', label: 'Local' } }])(
    'discovers actual local options despite a fallback catalog and closes only its temporary session without prompting: %j',
    async (metadata) => {
      const provider = new Provider(metadata)
      const f = await fixture({ providers: [provider] })
      const result = await f.ctx.clientExtensions.call(MODEL_DEFAULTS_DISCOVER, { providerId: 'gemini', cwd: '/tmp/project' })
      expect(result).toMatchObject({ configOptions: provider.discovered,
        provider: { id: 'gemini', activeSessionIds: ['existing-chat'] } })
      expect(provider.createSession).toHaveBeenCalledExactlyOnceWith({ cwd: '/tmp/project', permissionMode: 'ask', mcpServers: [] })
      expect(provider.closeSession).toHaveBeenCalledExactlyOnceWith('temporary')
      expect(provider.prompt).not.toHaveBeenCalled()
      expect(provider.cancel).not.toHaveBeenCalled()
    },
  )

  it.each([
    { protocol: 'remote' as const },
    { protocol: 'codex-app-server' as const },
    { remoteLocation: 'remote-workstation' },
    { location: { id: 'cloud', label: 'Cloud' } },
    { capabilities: { images: false, resources: false, mcpServers: false, sessionHistory: true, sessionModes: false, durableSession: true } },
  ])('returns existing options without provisioning a nonlocal provider: %j', async (override) => {
    const provider = new Provider(override)
    const f = await fixture({ providers: [provider] })
    expect(await f.ctx.clientExtensions.call(MODEL_DEFAULTS_DISCOVER, { providerId: 'gemini', cwd: '/tmp/project' }))
      .toMatchObject({ configOptions: provider.base.configOptions })
    expect(provider.createSession).not.toHaveBeenCalled()
    expect(provider.closeSession).not.toHaveBeenCalled()
    expect(provider.prompt).not.toHaveBeenCalled()
  })

  it('returns native status without creating a Codex thread', async () => {
    const f = await fixture()
    expect(await f.ctx.clientExtensions.call(MODEL_DEFAULTS_DISCOVER, { providerId: 'codex', cwd: '/tmp/project' }))
      .toMatchObject({ provider: { id: 'codex', protocol: 'codex-app-server', activeSessionIds: ['native-chat'] }, configOptions: [] })
    expect(f.providers.every((provider) => provider.createSession.mock.calls.length === 0)).toBe(true)
  })

  it('closes a session that finishes opening after the defaults plugin is disposed', async () => {
    const f = await fixture()
    const provider = f.providers[0]!
    let opened!: (session: AgentSession) => void
    provider.createSession.mockReturnValueOnce(new Promise((resolve) => { opened = resolve }))
    const discover = f.ctx.clientExtensions.call(MODEL_DEFAULTS_DISCOVER, { providerId: 'gemini', cwd: '/tmp/project' })
    await vi.waitFor(() => expect(provider.createSession).toHaveBeenCalledOnce())
    await f.fiber.dispose()
    opened({ id: 'late-session', providerId: 'gemini', cwd: '/tmp/project', createdAt: '', configOptions: provider.discovered })
    await expect(discover).rejects.toThrow('unavailable')
    expect(provider.closeSession).toHaveBeenCalledExactlyOnceWith('late-session')
  })

  it('provides read-only active-session diagnostics through the client extension and Cordis dispatcher', async () => {
    const f = await fixture()
    const result = await f.ctx.clientExtensions.call(MODEL_DEFAULTS_STATUS, {})
    expect(result).toMatchObject({ preferences: { providerId: 'codex', choices: {} },
      providers: [{ activeSessionIds: ['existing-chat'] }, { activeSessionIds: ['existing-chat'] }],
      nativeCodex: { status: 'ready', activeSessionIds: ['native-chat'] } })
    const tool = await f.ctx.tools.execute({ tool: 'cordis', callId: 'status', turnId: 'turn', threadId: 'thread',
      arguments: { operation: 'invoke', tool: 'model-defaults/status', arguments: {} } })
    expect(tool.success).toBe(true)
    expect(JSON.parse(tool.contentItems[0]!.text!)).toEqual(result)
    for (const provider of f.providers) {
      expect(provider.createSession).not.toHaveBeenCalled()
      expect(provider.prompt).not.toHaveBeenCalled()
    }
  })
})
