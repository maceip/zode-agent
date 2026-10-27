import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentSessionService } from '../program/plugins/agent-session.client.js'
import { SessionService } from '../program/plugins/session.client.js'
import { initialAgentConfig } from '../program/plugins/agent-model-options.js'
import type { AgentChat } from '../program/plugins/agent-chats-api.js'
import type { ModelDefaultsPreferences } from '../program/plugins/model-defaults-api.js'
import type { ClientHostService, ClientHostSnapshot } from '../src/client/plugin-api.js'
import type { AgentConfigOption } from '../src/server/services/agent-registry.js'
import type { HarnessEvent, HarnessSnapshot, JsonValue } from '../src/shared/protocol.js'

const chatId = 'acp-11111111-1111-1111-1111-111111111111'
const nativeThread = { id: 'native-thread', title: 'Saved', preview: '', cwd: '/repo', createdAt: 1, updatedAt: 2 }
const geminiConfig: AgentConfigOption[] = [{ id: '__model', name: 'Model', category: 'model', currentValue: 'auto',
  options: [{ value: 'auto', name: 'Auto' }, { value: 'gemini-4-argon', name: 'Gemini 4 Argon' }] }]
const draft = { text: 'Hello', images: [], attachments: [], skills: [] }

function fixture(preferences?: ModelDefaultsPreferences, configured = true) {
  const listeners = new Set<() => void>()
  const events = new Set<(event: HarnessEvent) => void>()
  const snapshot: HarnessSnapshot = {
    codex: { status: 'ready', activeThreadIds: [], models: [
      { id: 'one', displayName: 'One', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
      { id: 'two', displayName: 'Two', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
    ] },
    program: { revision: 1, profileText: '', plugins: [], files: [], tools: [], proposals: [] },
    projects: { revision: 0, projects: [] }, ui: { regions: [], surfaces: [], contributions: [] }, pendingRequests: [],
    extensions: { ...(configured ? { 'session.defaults': { model: 'one', effort: 'low', permissionMode: 'ask' } } : {}),
      'agent-chats': { providers: [
        { id: 'gemini', label: 'Gemini', capabilities: {}, configOptions: initialAgentConfig('gemini') },
        { id: 'claude', label: 'Claude', capabilities: {}, configOptions: initialAgentConfig('claude') },
      ], threads: [] } as unknown as JsonValue,
      ...(preferences ? { 'model-defaults': preferences as unknown as JsonValue } : {}),
    },
    server: { host: '127.0.0.1', port: 0, projectRoot: '/repo' },
  }
  const chat: AgentChat = { summary: { id: chatId, providerId: 'gemini', providerSessionId: 'session', cwd: '/repo',
    title: 'New Gemini chat', preview: '', createdAt: 1, updatedAt: 1 },
    permissionMode: 'ask', turn: 'idle', activities: [], requests: [], configOptions: structuredClone(geminiConfig) }
  const state: ClientHostSnapshot = { revision: 0, connectionEpoch: 1, connected: true, connection: 'online', snapshot }
  const command = vi.fn(async (type: string) => {
    if (type === 'thread.list' || type === 'skill.list') return []
    if (type === 'thread.open') return { summary: nativeThread, session: { workspace: '/repo', permissionMode: 'ask', model: 'one', effort: 'low' }, messages: [{ id: 'saved', role: 'user', text: 'Saved message' }] }
    throw Error(type)
  })
  const call = vi.fn(async (method: string, payload?: { configId?: string; value?: string }) => {
    if (method === 'agent-chats.configure') {
      const option = chat.configOptions?.find((option) => option.id === payload?.configId)
      if (!option || !payload?.value) throw Error('Unknown configuration')
      option.currentValue = payload.value
      return { configOptions: structuredClone(chat.configOptions) }
    }
    if (method === 'agent-chats.create' || method === 'agent-chats.open' || method === 'agent-chats.send') return structuredClone(chat)
    throw Error(method)
  })
  const host = { snapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onEvent: (listener: (event: HarnessEvent) => void) => { events.add(listener); return () => events.delete(listener) },
    journal: () => [], programActivated: () => {}, command, call } as unknown as ClientHostService
  const native = new SessionService(host, { restoreActiveThread: false })
  const session = new AgentSessionService(native, host)
  const update = (next: ModelDefaultsPreferences) => {
    snapshot.extensions['model-defaults'] = next as unknown as JsonValue
    state.revision++
    for (const listener of listeners) listener()
  }
  return { session, native, call, command, chat, snapshot, update, close: () => { session.dispose(); native.dispose() } }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('starts fresh panes with saved Gemini Argon and configures it before the first message', async () => {
  const f = fixture({ providerId: 'gemini', choices: { gemini: { model: 'gemini-4-argon' } } })
  try {
    expect(f.session.snapshot()).toMatchObject({ providerId: 'gemini', session: { model: 'gemini-4-argon' } })
    expect(f.call).not.toHaveBeenCalled()
    await f.session.send(draft)
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['agent-chats.create', 'agent-chats.configure', 'agent-chats.send'])
    expect(f.call).toHaveBeenCalledWith('agent-chats.configure', { id: chatId, configId: '__model', value: 'gemini-4-argon' })
  } finally { f.close() }
})

it('inherits late preferences in an untouched draft while respecting explicit agent selection', () => {
  const f = fixture()
  try {
    f.update({ providerId: 'gemini', choices: { gemini: { model: 'gemini-4-argon' } } })
    expect(f.session.snapshot().providerId).toBe('gemini')
    f.session.setProvider('claude')
    f.update({ providerId: 'codex', choices: {} })
    expect(f.session.snapshot().providerId).toBe('claude')
  } finally { f.close() }
})

it('returns to saved global defaults for a new chat after a manual provider choice', () => {
  const f = fixture({ providerId: 'gemini', choices: { gemini: { model: 'gemini-4-argon' } } })
  try {
    f.session.setProvider('claude')
    f.session.newThread()
    expect(f.session.snapshot()).toMatchObject({ providerId: 'gemini', session: { model: 'gemini-4-argon' } })
    expect(f.call).not.toHaveBeenCalled()
  } finally { f.close() }
})

it('allows Agent default in a Gemini draft to override a saved Argon choice without sending a fake model ID', async () => {
  const f = fixture({ providerId: 'gemini', choices: { gemini: { model: 'gemini-4-argon' } } })
  try {
    f.session.setModel('default')
    await f.session.send(draft)
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['agent-chats.create', 'agent-chats.send'])
  } finally { f.close() }
})

it('applies remembered choices when manually selecting a provider that is not the global default', () => {
  const f = fixture({ providerId: 'codex', choices: { gemini: { model: 'gemini-4-argon' } } })
  try {
    f.session.setProvider('gemini')
    expect(f.session.snapshot().session.model).toBe('gemini-4-argon')
    expect(f.call).not.toHaveBeenCalled()
  } finally { f.close() }
})

it('applies late Codex defaults only to untouched drafts and resets explicit choices for a new chat', () => {
  const f = fixture()
  try {
    f.update({ providerId: 'codex', choices: { codex: { model: 'two', effort: 'high' } } })
    expect(f.session.snapshot().session).toMatchObject({ model: 'two', effort: 'high' })
    f.session.setModel('one')
    f.update({ providerId: 'codex', choices: { codex: { model: 'two', effort: 'medium' } } })
    expect(f.session.snapshot().session).toMatchObject({ model: 'one', effort: 'low' })
    f.session.newThread()
    expect(f.session.snapshot().session).toMatchObject({ model: 'two', effort: 'medium' })
  } finally { f.close() }
})

it('retains a reopened native chat and its model when global defaults change to Gemini', async () => {
  const f = fixture()
  try {
    await f.session.openThread(nativeThread)
    f.update({ providerId: 'gemini', choices: { gemini: { model: 'gemini-4-argon' }, codex: { model: 'two', effort: 'high' } } })
    expect(f.session.snapshot()).toMatchObject({ providerId: 'codex', threadId: nativeThread.id, session: { model: 'one', effort: 'low' } })
    expect(f.call).not.toHaveBeenCalled()
  } finally { f.close() }
})

it('retains restored native model and effort when the first defaults arrive after the chat opens', async () => {
  const f = fixture(undefined, false)
  try {
    f.command.mockImplementation(async (type: string) => {
      if (type === 'thread.list' || type === 'skill.list') return []
      if (type === 'thread.open') return { summary: nativeThread,
        session: { workspace: '/repo', permissionMode: 'ask', model: 'two', effort: 'high' },
        messages: [{ id: 'saved', role: 'user', text: 'Saved message' }] }
      throw Error(type)
    })
    await f.session.openThread(nativeThread)
    expect(f.session.snapshot().session).toMatchObject({ model: 'two', effort: 'high' })
    f.update({ providerId: 'codex', choices: { codex: { model: 'one', effort: 'low' } } })
    expect(f.session.snapshot()).toMatchObject({ providerId: 'codex', threadId: nativeThread.id,
      session: { model: 'two', effort: 'high' } })
  } finally { f.close() }
})

it('configures a saved model before validating its reasoning against the returned catalog', async () => {
  const f = fixture({ providerId: 'claude', choices: { claude: { model: 'opus', effort: 'max' } } })
  const model: AgentConfigOption = { id: 'model', name: 'Model', category: 'model', currentValue: 'opus',
    options: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }] }
  const effort: AgentConfigOption = { id: 'effort', name: 'Reasoning', category: 'thought_level', currentValue: 'max',
    options: [{ value: 'high', name: 'High' }, { value: 'max', name: 'Max' }] }
  try {
    const catalog = f.snapshot.extensions['agent-chats'] as unknown as { providers: { id: string; configOptions?: AgentConfigOption[] }[] }
    catalog.providers.find((provider) => provider.id === 'claude')!.configOptions = [effort, model]
    f.update({ providerId: 'claude', choices: { claude: { model: 'opus', effort: 'max' } } })
    f.chat.configOptions = [{ ...effort, currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
      { ...model, currentValue: 'sonnet' }]
    f.call.mockImplementation(async (method: string, payload?: { configId?: string; value?: string }) => {
      if (method === 'agent-chats.configure') {
        const option = f.chat.configOptions?.find((option) => option.id === payload?.configId)
        if (!option || !payload?.value || !option.options.some((choice) => choice.value === payload.value)) throw Error('Unavailable configuration')
        option.currentValue = payload.value
        if (payload.configId === 'model') f.chat.configOptions![0] = { ...effort, currentValue: 'high' }
        return { configOptions: structuredClone(f.chat.configOptions) }
      }
      if (method === 'agent-chats.create' || method === 'agent-chats.send') return structuredClone(f.chat)
      throw Error(method)
    })
    await f.session.send(draft)
    expect(f.call.mock.calls.map(([method, payload]) => [method, payload?.configId])).toEqual([
      ['agent-chats.create', undefined], ['agent-chats.configure', 'model'],
      ['agent-chats.configure', 'effort'], ['agent-chats.send', undefined],
    ])
  } finally { f.close() }
})

it('rejects an unavailable saved model before sending, leaving the actual choices visible', async () => {
  const f = fixture({ providerId: 'gemini', choices: { gemini: { model: 'unavailable-model' } } })
  try {
    await expect(f.session.send(draft)).rejects.toThrow('unavailable')
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['agent-chats.create'])
    expect(f.session.snapshot().threadId).toBe(chatId)
    expect(f.session.snapshot().models?.map((model) => model.id)).toContain('gemini-4-argon')
  } finally { f.close() }
})
