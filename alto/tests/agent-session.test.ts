import { describe, expect, it, vi } from 'vitest'
import { AgentSessionService } from '../program/plugins/agent-session.client.js'
import { initialAgentConfig } from '../program/plugins/agent-model-options.js'
import type { AgentChat } from '../program/plugins/agent-chats-api.js'
import type { ClientSessionService, ClientSessionSnapshot } from '../program/plugins/session-api.js'
import type { ClientHostService } from '../src/client/plugin-api.js'
import type { HarnessSnapshot, JsonValue } from '../src/shared/protocol.js'
import type { AgentConfigOption } from '../src/server/services/agent-registry.js'

const id = 'acp-11111111-1111-1111-1111-111111111111'
const chat: AgentChat = { summary: { id, providerId: 'pi', providerSessionId: 'pi-session', cwd: '/tmp/project',
  title: 'Pi chat', preview: '', createdAt: 1, updatedAt: 1 }, permissionMode: 'ask', turn: 'idle', activities: [], requests: [] }
const draft = { text: 'Hello', images: [], attachments: [], skills: [] }

function fixture() {
  const listeners = new Set<() => void>()
  const extensions: Record<string, JsonValue> = { 'agent-chats': { providers: [{ id: 'pi', label: 'Pi', capabilities: { images: true } }, { id: 'claude', label: 'Claude', capabilities: { images: true, steering: true } }], threads: [chat.summary as unknown as JsonValue] } }
  const harness = { codex: { status: 'failed', models: [] }, extensions, pendingRequests: [] } as unknown as HarnessSnapshot
  const snapshot = { revision: 0, connected: true, harness, session: { workspace: '/tmp/project', permissionMode: 'ask' },
    turn: { tag: 'idle' }, agentStatus: { state: 'idle', label: 'Ready' }, activities: [],
    hasEarlierActivities: false, loadingEarlierActivities: false, history: { tag: 'ready', entries: [] },
    threads: [], projects: [], skills: [] } as ClientSessionSnapshot
  const native = { subscribe: () => () => {}, snapshot: () => snapshot, send: vi.fn(), openThread: vi.fn(),
    newThread: vi.fn(), setPermissionMode: vi.fn(), refreshHistory: vi.fn() } as unknown as ClientSessionService
  const call = vi.fn(async (method: string, payload?: unknown): Promise<JsonValue> => {
    if (method === 'agent-chats.send') return { ...structuredClone(chat), turn: 'running', activities: [{ id: 'user', kind: 'user', title: 'You', content: 'Hello', timestamp: '' }] } as unknown as JsonValue
    if (method === 'agent-chats.create' || method === 'agent-chats.open') {
      const providerId = (payload as { providerId?: string })?.providerId ?? 'pi'
      return { ...structuredClone(chat), summary: { ...chat.summary, providerId, id: providerId === 'pi' ? id : 'acp-22222222-2222-2222-2222-222222222222' } } as unknown as JsonValue
    }
    return { ok: true }
  })
  const host = { call, snapshot: () => ({ connected: true, snapshot: harness }), subscribe: (listener: () => void) => {
    listeners.add(listener); return () => listeners.delete(listener)
  } } as unknown as ClientHostService
  const session = new AgentSessionService(native, host)
  return { session, native, call, extensions, update: () => listeners.forEach((listener) => listener()) }
}

describe('provider-aware browser sessions', () => {
  it('offers local workspace skills to ACP chats and forwards the selected skill', async () => {
    const f = fixture()
    const skill = { name: 'canvas', description: 'Build a Canvas page.', path: '/tmp/project/.agents/skills/canvas/SKILL.md', scope: 'repo' as const }
    f.native.snapshot().skills = [skill]
    try {
      f.session.setProvider('claude')
      expect(f.session.snapshot().skills).toEqual([skill])
      await f.session.send({ ...draft, skills: [skill] })
      expect(f.call).toHaveBeenCalledWith('agent-chats.send', expect.objectContaining({
        input: expect.arrayContaining([{ type: 'text', text: `Use the canvas skill at ${skill.path}.` }]),
      }))
      f.native.snapshot().session.workspace = '/tmp/different-project'
      f.update()
      expect(f.session.snapshot().skills).toEqual([])
    } finally { f.session.dispose() }
  })

  it('keeps the first remote prompt and startup state visible until the journal accepts it', async () => {
    const f = fixture()
    f.extensions['agent-chats'] = { providers: [{ id: 'cloud', label: 'Claude', remoteLocation: 'Cloud', capabilities: {} }], threads: [] }
    f.update()
    let created!: (value: JsonValue) => void
    let sent!: (value: JsonValue) => void
    f.call.mockImplementation(async (method) => {
      if (method === 'agent-chats.create') return new Promise((resolve) => { created = resolve })
      if (method === 'agent-chats.send') return new Promise((resolve) => { sent = resolve })
      return {}
    })
    const remoteChat = { ...structuredClone(chat), summary: { ...chat.summary, providerId: 'cloud' }, remote: { state: 'connected' as const } }
    try {
      f.session.setProvider('cloud')
      const pending = f.session.send(draft)
      const initial = f.session.snapshot()
      expect(initial.remoteStarting).toBe(true)
      expect(initial.activities).toHaveLength(1)
      expect(initial.activities[0]).toMatchObject({ kind: 'user', content: 'Hello' })
      created(remoteChat as unknown as JsonValue)
      await vi.waitFor(() => expect(sent).toBeTypeOf('function'))
      expect(f.session.snapshot()).toMatchObject({ threadId: id, remoteStarting: true, activities: initial.activities })

      f.extensions[`agent-chats.${id}`] = { ...remoteChat, turn: 'sending' } as unknown as JsonValue
      f.update()
      expect(f.session.snapshot().activities).toEqual(initial.activities)
      const accepted = { ...remoteChat, turn: 'running', activities: [
        { id: 'user:recorded-input', turnId: 'remote-turn', kind: 'user', title: 'You', content: 'Hello', timestamp: 'later' },
      ] }
      f.extensions[`agent-chats.${id}`] = accepted as unknown as JsonValue
      f.update()
      expect(f.session.snapshot().remoteStarting).toBeFalsy()
      expect(f.session.snapshot().activities).toHaveLength(1)
      expect(f.session.snapshot().activities[0]).toMatchObject({ ...initial.activities[0], turnId: 'remote-turn' })
      sent(accepted as unknown as JsonValue)
      await pending
      expect(f.session.snapshot().activities[0]?.id).toBe(initial.activities[0]?.id)
      f.extensions[`agent-chats.${id}`] = { ...accepted, activities: [...accepted.activities,
        { ...accepted.activities[0], id: 'user:second-input', turnId: 'second-turn' },
      ] } as unknown as JsonValue
      f.update()
      expect(f.session.snapshot().activities.map((item) => item.id)).toEqual([initial.activities[0]?.id, 'user:second-input'])
    } finally { f.session.dispose() }
  })

  it('clears an unaccepted remote prompt after failure so retry does not duplicate it', async () => {
    const f = fixture()
    f.extensions['agent-chats'] = { providers: [{ id: 'cloud', label: 'Claude', remoteLocation: 'Cloud', capabilities: {} }], threads: [] }
    f.update()
    f.session.setProvider('cloud')
    f.call.mockRejectedValueOnce(new Error('Could not start workstation'))
    try {
      await expect(f.session.send(draft)).rejects.toThrow('Could not start workstation')
      expect(f.session.snapshot().remoteStarting).toBeFalsy()
      expect(f.session.snapshot().activities.some((item) => item.kind === 'user')).toBe(false)
      await f.session.send(draft)
      expect(f.session.snapshot().activities.filter((item) => item.kind === 'user')).toHaveLength(1)
      f.session.newThread()
      expect(f.session.snapshot().activities).toEqual([])
      expect(f.session.snapshot().remoteStarting).toBeFalsy()
    } finally { f.session.dispose() }
  })

  function codexDefaultsFixture() {
    const f = fixture()
    f.native.snapshot().harness!.codex.models = [
      { id: 'first', displayName: 'First', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
      { id: 'second', displayName: 'Second', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }] },
    ]
    f.native.snapshot().harness!.codex.defaults = { model: 'first', effort: 'low', permissionMode: 'ask' }
    f.extensions['session.defaults'] = { model: 'second', effort: 'xhigh', permissionMode: 'full' }
    const configOptions: AgentConfigOption[] = [
      { id: 'model', name: 'Model', category: 'model', currentValue: 'first', options: [{ value: 'first', name: 'First' }, { value: 'second', name: 'Second' }] },
      { id: 'effort', name: 'Reasoning', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'xhigh', name: 'Extra high' }] },
    ]
    f.extensions['agent-chats'] = { providers: [{ id: 'cloud-codex', agentId: 'codex', label: 'Codex', capabilities: {}, configOptions: configOptions as unknown as JsonValue }], threads: [] }
    const created = { ...structuredClone(chat), summary: { ...chat.summary, providerId: 'cloud-codex' }, configOptions: structuredClone(configOptions) }
    f.call.mockImplementation(async (method, payload) => {
      if (method === 'agent-chats.configure') {
        const { configId, value } = payload as { configId: string; value: string }
        created.configOptions.find((option) => option.id === configId)!.currentValue = value
        return { configOptions: structuredClone(created.configOptions) } as unknown as JsonValue
      }
      return structuredClone(created) as unknown as JsonValue
    })
    f.update()
    f.session.setProvider('cloud-codex')
    return { ...f, created }
  }

  it('applies Alto defaults before the first remote Codex prompt without requiring picker changes', async () => {
    const f = codexDefaultsFixture()
    try {
      expect(f.session.snapshot().session).toMatchObject({ model: 'second', effort: 'xhigh' })
      expect(f.call).not.toHaveBeenCalled()
      await f.session.send(draft)
      expect(f.call.mock.calls.map(([method]) => method)).toEqual([
        'agent-chats.create', 'agent-chats.configure', 'agent-chats.configure', 'agent-chats.send',
      ])
      expect(f.call.mock.calls[1]).toEqual(['agent-chats.configure', { id, configId: 'model', value: 'second' }])
      expect(f.call.mock.calls[2]).toEqual(['agent-chats.configure', { id, configId: 'effort', value: 'xhigh' }])
      f.extensions['session.defaults'] = { model: 'first', effort: 'low', permissionMode: 'ask' }
      f.update()
      expect(f.session.snapshot().session).toMatchObject({ model: 'second', effort: 'xhigh' })
    } finally { f.session.dispose() }
  })

  it('updates inherited defaults in a draft while preserving explicit choices', () => {
    const f = codexDefaultsFixture()
    try {
      delete f.extensions['session.defaults']
      f.update()
      expect(f.session.snapshot().session).toMatchObject({ model: 'first', effort: 'low' })
      f.extensions['session.defaults'] = { model: 'second', effort: 'xhigh', permissionMode: 'full' }
      f.update()
      expect(f.session.snapshot().session).toMatchObject({ model: 'second', effort: 'xhigh' })
      f.session.setModel('second')
      f.session.setEffort('low')
      f.extensions['session.defaults'] = { model: 'first', effort: 'xhigh', permissionMode: 'full' }
      f.update()
      expect(f.session.snapshot().session).toMatchObject({ model: 'second', effort: 'low' })
      expect(f.call).not.toHaveBeenCalled()
    } finally { f.session.dispose() }
  })

  it('uses the selected model default when Alto\'s reasoning default is unsupported', () => {
    const f = codexDefaultsFixture()
    try {
      f.session.setModel('first')
      expect(f.session.snapshot().session).toMatchObject({ model: 'first', effort: 'low' })
      expect(f.session.snapshot().models?.[0]?.supportedReasoningEfforts).toEqual([{ reasoningEffort: 'low', description: 'low' }])
    } finally { f.session.dispose() }
  })

  const modelConfig: AgentConfigOption[] = [{ id: 'model', name: 'Model', category: 'model', currentValue: 'default',
    options: [{ value: 'default', name: 'Agent default' }, { value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }] },
  { id: 'effort', name: 'Reasoning', category: 'thought_level', currentValue: 'medium',
    options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }]

  function draftFixture() {
    const f = fixture()
    f.extensions['agent-chats'] = { providers: [{ id: 'cloud-claude', agentId: 'claude', label: 'Claude',
      capabilities: {}, configOptions: modelConfig as unknown as JsonValue }], threads: [] }
    const created = { ...structuredClone(chat), summary: { ...chat.summary, providerId: 'cloud-claude' }, configOptions: structuredClone(modelConfig) }
    f.call.mockImplementation(async (method, payload) => {
      if (method === 'agent-chats.create') return structuredClone(created) as unknown as JsonValue
      if (method === 'agent-chats.configure') {
        const { configId, value } = payload as { configId: string; value: string }
        created.configOptions.find((option) => option.id === configId)!.currentValue = value
        return { configOptions: structuredClone(created.configOptions) } as unknown as JsonValue
      }
      return created as unknown as JsonValue
    })
    f.update()
    f.session.setProvider('cloud-claude')
    return { ...f, created }
  }

  it('applies draft model and reasoning choices before sending the first prompt', async () => {
    const f = draftFixture()
    try {
      f.session.setModel('opus')
      f.session.setEffort('high')
      expect(f.session.snapshot().session).toMatchObject({ model: 'opus', effort: 'high' })
      expect(f.session.snapshot().threadId).toBeUndefined()
      expect(f.call).not.toHaveBeenCalled()
      const models = f.session.snapshot().models
      f.update()
      expect(f.session.snapshot().models).toBe(models)
      await f.session.send(draft)
      expect(f.call.mock.calls.map(([method]) => method)).toEqual([
        'agent-chats.create', 'agent-chats.configure', 'agent-chats.configure', 'agent-chats.send',
      ])
      expect(f.call.mock.calls[1]).toEqual(['agent-chats.configure', { id, configId: 'model', value: 'opus' }])
      expect(f.call.mock.calls[2]).toEqual(['agent-chats.configure', { id, configId: 'effort', value: 'high' }])
    } finally { f.session.dispose() }
  })

  it.each(['claude', 'cloud-claude'])('applies Opus 5.5 and its effort before sending with %s', async (providerId) => {
    const f = fixture()
    f.extensions['agent-chats'] = { providers: [{ id: providerId, agentId: 'claude', label: 'Claude', capabilities: {},
      configOptions: initialAgentConfig('claude') as unknown as JsonValue }], threads: [] }
    const config: AgentConfigOption[] = [
      { id: 'model', name: 'Model', category: 'model', currentValue: 'sonnet', options: [
        { value: 'opus[1m]', name: 'Opus 5.5' }, { value: 'sonnet', name: 'Sonnet 5' },
      ] },
      { id: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] },
    ]
    const created = { ...structuredClone(chat), summary: { ...chat.summary, providerId }, configOptions: config }
    f.call.mockImplementation(async (method, payload) => {
      if (method === 'agent-chats.configure') {
        const { configId, value } = payload as { configId: string; value: string }
        config.find(option => option.id === configId)!.currentValue = value
        if (configId === 'model') config[1]!.options.push({ value: 'max', name: 'Max' })
      }
      return structuredClone(created) as unknown as JsonValue
    })
    f.update()
    try {
      f.session.setProvider(providerId)
      f.session.setModel('claude-opus-5-5')
      f.session.setEffort('max')
      expect(f.session.snapshot().session).toMatchObject({ model: 'claude-opus-5-5', effort: 'max' })
      expect(f.call).not.toHaveBeenCalled()
      await f.session.send(draft)
      expect(f.call.mock.calls.map(([method]) => method)).toEqual([
        'agent-chats.create', 'agent-chats.configure', 'agent-chats.configure', 'agent-chats.send',
      ])
      expect(f.call.mock.calls[1]).toEqual(['agent-chats.configure', { id, configId: 'model', value: 'opus[1m]' }])
      expect(f.call.mock.calls[2]).toEqual(['agent-chats.configure', { id, configId: 'effort', value: 'max' }])
      expect(f.session.snapshot().session).toMatchObject({ model: 'opus[1m]', effort: 'max' })
    } finally { f.session.dispose() }
  })

  it('does not send with an older Opus when the draft explicitly selected Opus 5.5', async () => {
    const f = draftFixture()
    f.extensions['agent-chats'] = { providers: [{ id: 'cloud-claude', agentId: 'claude', label: 'Claude', capabilities: {},
      configOptions: initialAgentConfig('claude') as unknown as JsonValue }], threads: [] }
    f.created.configOptions[0]!.options = [{ value: 'opus[1m]', name: 'Opus 4.6' }]
    f.created.configOptions[0]!.currentValue = 'opus[1m]'
    f.update()
    try {
      f.session.setModel('claude-opus-5-5')
      await expect(f.session.send(draft)).rejects.toThrow('Model "Opus 5.5" is unavailable')
      expect(f.call.mock.calls.map(([method]) => method)).toEqual(['agent-chats.create'])
    } finally { f.session.dispose() }
  })

  it('keeps the prompt unsent when the actual remote catalog rejects the draft model', async () => {
    const f = draftFixture()
    try {
      f.session.setModel('opus')
      f.created.configOptions[0]!.options = [{ value: 'sonnet', name: 'Sonnet' }]
      f.created.configOptions[0]!.currentValue = 'sonnet'
      await expect(f.session.send(draft)).rejects.toThrow('Model "Opus" is unavailable')
      expect(f.call.mock.calls.map(([method]) => method)).toEqual(['agent-chats.create'])
      expect(f.session.snapshot().threadId).toBe(id)
      expect(f.session.snapshot().models?.map((option) => option.id)).toEqual(['sonnet'])
      expect(f.session.snapshot().turn.tag).toBe('idle')
      await f.session.send(draft)
      expect(f.call).toHaveBeenLastCalledWith('agent-chats.send', expect.objectContaining({ id }))
    } finally { f.session.dispose() }
  })

  it('waits for configuration acknowledgement and does not send on a configuration error', async () => {
    const f = draftFixture()
    let reject!: (reason: Error) => void
    try {
      f.session.setModel('opus')
      f.call.mockImplementation(async (method) => {
        if (method === 'agent-chats.create') return f.created as unknown as JsonValue
        return new Promise((_, fail) => { reject = fail })
      })
      const sent = f.session.send(draft)
      const rejected = expect(sent).rejects.toThrow('Model access denied')
      await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(2))
      expect(f.call.mock.calls.map(([method]) => method)).toEqual(['agent-chats.create', 'agent-chats.configure'])
      reject(new Error('Model access denied'))
      await rejected
      expect(f.session.snapshot().turn.tag).toBe('idle')
    } finally { f.session.dispose() }
  })

  it('clears draft model choices when changing provider or starting a different chat', async () => {
    const f = draftFixture()
    try {
      f.session.setModel('opus')
      f.session.setProvider('codex')
      f.session.setProvider('cloud-claude')
      expect(f.session.snapshot().session.model).toBe('default')
      f.session.setModel('sonnet')
      f.session.newThread()
      expect(f.session.snapshot().session.model).toBe('default')
      expect(f.call).not.toHaveBeenCalled()
    } finally { f.session.dispose() }
  })

  it.each(['models', 'harness'] as const)('uses known Codex models from %s without inheriting the local chat selection', async (source) => {
    const f = fixture()
    const models = [
      { id: 'first', displayName: 'First', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }] },
      { id: 'second', displayName: 'Second', isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }] },
    ]
    if (source === 'models') f.native.snapshot().models = models
    else f.native.snapshot().harness!.codex.models = models
    f.native.snapshot().session.model = 'second'
    f.extensions['agent-chats'] = { providers: [{ id: 'cloud-codex', agentId: 'codex', label: 'Codex', capabilities: {} }], threads: [] }
    f.update()
    try {
      f.session.setProvider('cloud-codex')
      expect(f.session.snapshot().session.model).toBe('first')
      f.session.setEffort('medium')
      f.session.setModel('second')
      expect(f.session.snapshot().session).toMatchObject({ model: 'second', effort: 'high' })
      expect(f.session.snapshot().models?.[1]?.supportedReasoningEfforts).toEqual([{ reasoningEffort: 'high', description: 'High' }])
      expect(f.call).not.toHaveBeenCalled()
    } finally { f.session.dispose() }
  })

  it('ignores stale workspace-name lookups without starting an agent', async () => {
    const f = fixture()
    const pending = new Map<string, (value: JsonValue) => void>()
    f.extensions['agent-chats'] = { providers: [
      { id: 'cloud-claude', label: 'Claude', remoteLocation: 'Cloud', capabilities: {} },
    ], threads: [] }
    f.call.mockImplementation(async (method, payload) => {
      if (method !== 'agent-chats.workspace-name') throw new Error('Unexpected agent startup')
      return new Promise((resolve) => pending.set((payload as { cwd: string }).cwd, resolve))
    })
    f.update()
    try {
      f.session.setProvider('cloud-claude')
      f.native.snapshot().session.workspace = '/tmp/other'
      f.update()
      pending.get('/tmp/project')!({ name: 'old-workstation' })
      await Promise.resolve()
      expect(f.session.snapshot().remoteWorkspaceName).toBeUndefined()
      pending.get('/tmp/other')!({ name: 'new-workstation' })
      await vi.waitFor(() => expect(f.session.snapshot().remoteWorkspaceName).toBe('new-workstation'))
      expect(f.session.snapshot().turn.tag).toBe('idle')
      expect(f.session.snapshot().threadId).toBeUndefined()
      f.update()
      expect(f.call).toHaveBeenCalledTimes(2)
      f.session.setProvider('codex')
      expect(f.session.snapshot().remoteWorkspaceName).toBeUndefined()
    } finally { f.session.dispose() }
  })

  it('shows the saved remote workspace instead of deriving it from the current local checkout', async () => {
    const f = fixture()
    const remoteChat: AgentChat = { ...structuredClone(chat),
      summary: { ...chat.summary, providerId: 'cloud-claude' },
      remote: { state: 'connected', workspaceName: 'original-workstation', workspace: {
        name: 'original-workstation', url: 'https://remote.example/terminal', cwd: '/remote/repo',
        branch: 'feature/remote', repository: 'https://github.com/example/remote',
      } },
    }
    f.extensions['agent-chats'] = { providers: [
      { id: 'cloud-claude', label: 'Claude', remoteLocation: 'Cloud', capabilities: {} },
    ], threads: [remoteChat.summary as unknown as JsonValue] }
    f.call.mockResolvedValue(remoteChat as unknown as JsonValue)
    f.update()
    try {
      await f.session.openThread(remoteChat.summary)
      expect(f.session.snapshot().remoteWorkspaceName).toBe('original-workstation')
      expect(f.session.snapshot().remoteWorkspace).toEqual(remoteChat.remote?.workspace)
      expect(f.call).not.toHaveBeenCalledWith('agent-chats.workspace-name', expect.anything())
      f.session.setProvider('codex')
      expect(f.session.snapshot().remoteWorkspace).toBeUndefined()
    } finally { f.session.dispose() }
  })

  it('keeps remote setup editable and creates only the final selection on first send', async () => {
    const f = fixture()
    f.extensions['agent-chats'] = { providers: [
      { id: 'cloud-codex', label: 'Codex', agentId: 'codex', location: { id: 'cloud', label: 'Cloud' }, remoteLocation: 'Cloud', capabilities: {} },
      { id: 'cloud-claude', label: 'Claude', agentId: 'claude', location: { id: 'cloud', label: 'Cloud' }, remoteLocation: 'Cloud', capabilities: {} },
    ], threads: [] }
    f.native.retargetNewThread = vi.fn((project) => {
      f.native.snapshot().session.workspace = project.primaryRoot
      return true
    })
    f.update()
    try {
      f.session.setProvider('cloud-codex')
      expect(f.session.snapshot()).toMatchObject({ providerId: 'cloud-codex', turn: { tag: 'idle' }, connected: true })
      expect(f.session.snapshot().threadId).toBeUndefined()
      f.session.setProvider('cloud-claude')
      f.session.setPermissionMode('full')
      expect(f.session.retargetNewThread({ id: 'other', name: 'Other', primaryRoot: '/tmp/other', roots: ['/tmp/other'] })).toBe(true)
      f.update()
      f.session.setProvider('codex')
      f.session.setProvider('cloud-claude')
      expect(f.call.mock.calls.every(([method]) => method === 'agent-chats.workspace-name')).toBe(true)
      expect(f.session.snapshot()).toMatchObject({ providerId: 'cloud-claude', turn: { tag: 'idle' }, session: { workspace: '/tmp/other', permissionMode: 'full' } })

      await f.session.send(draft)
      expect(f.call.mock.calls.filter(([method]) => method === 'agent-chats.create')).toEqual([
        ['agent-chats.create', { providerId: 'cloud-claude', cwd: '/tmp/other', permissionMode: 'full' }],
      ])
      expect(f.call).toHaveBeenLastCalledWith('agent-chats.send', {
        id: 'acp-22222222-2222-2222-2222-222222222222', input: [{ type: 'text', text: 'Hello' }], permissionMode: 'full',
      })
    } finally { f.session.dispose() }
  })

  it('does not start an agent for an empty prompt and allows setup changes after startup fails', async () => {
    const f = fixture()
    try {
      f.session.setProvider('pi')
      await f.session.send({ ...draft, text: ' ' })
      expect(f.call).not.toHaveBeenCalled()
      f.call.mockRejectedValueOnce(new Error('Remote workstation unavailable'))
      await expect(f.session.send(draft)).rejects.toThrow('Remote workstation unavailable')
      expect(f.session.snapshot().turn.tag).toBe('idle')
      f.session.setProvider('claude')
      expect(f.session.snapshot().providerId).toBe('claude')
      expect(f.session.snapshot().threadId).toBeUndefined()
      expect(f.call).toHaveBeenCalledTimes(1)
      await f.session.send(draft)
      expect(f.call).toHaveBeenCalledWith('agent-chats.create', { providerId: 'claude', cwd: '/tmp/project', permissionMode: 'ask' })
    } finally { f.session.dispose() }
  })

  it('publishes separate agent and location choices without recreating them on every update', () => {
    const f = fixture()
    try {
      f.extensions['agent-chats'] = { providers: [
        { id: 'cloud-claude', label: 'Claude', agentId: 'claude', location: { id: 'cloud', label: 'Cloud' }, capabilities: {} },
      ], threads: [] }
      f.update()
      const providers = f.session.snapshot().providers
      expect(providers).toEqual([
        { id: 'codex', label: 'Codex' },
        { id: 'cloud-claude', label: 'Claude', agentId: 'claude', location: { id: 'cloud', label: 'Cloud' } },
      ])
      f.update()
      expect(f.session.snapshot().providers).toBe(providers)
      f.extensions['agent-chats'] = { providers: [
        { id: 'cloud-claude', label: 'Claude', agentId: 'claude', location: { id: 'cloud', label: 'Renamed cloud' }, capabilities: {} },
      ], threads: [] }
      f.update()
      expect(f.session.snapshot().providers?.[1]?.location?.label).toBe('Renamed cloud')
    } finally { f.session.dispose() }
  })

  it('sends a Pi chat through ACP even when Codex is unavailable', async () => {
    const f = fixture()
    try {
      f.session.setProvider('pi')
      expect(f.session.snapshot()).toMatchObject({ providerId: 'pi', models: [], connected: true })
      await f.session.send(draft)
      expect(f.call).toHaveBeenCalledWith('agent-chats.create', { providerId: 'pi', cwd: '/tmp/project', permissionMode: 'ask' })
      expect(f.call).toHaveBeenCalledWith('agent-chats.send', { id, input: [{ type: 'text', text: 'Hello' }], permissionMode: 'ask' })
      expect(f.native.send).not.toHaveBeenCalled()
      expect(f.session.snapshot().threadId).toBe(id)
      f.session.setProvider('claude')
      expect(f.session.snapshot().providerId).toBe('pi')
    } finally { f.session.dispose() }
  })

  it('keeps an in-flight new chat bound to its provider after navigation', async () => {
    const f = fixture()
    let created!: (value: JsonValue) => void
    f.call.mockImplementationOnce(() => new Promise((resolve) => { created = resolve }))
    try {
      f.session.setProvider('pi')
      const pending = f.session.send(draft)
      f.session.newThread()
      f.session.setProvider('claude')
      created(chat as unknown as JsonValue)
      await pending
      expect(f.session.snapshot().providerId).toBe('claude')
      expect(f.session.snapshot().threadId).toBeUndefined()
      expect(f.call.mock.calls.filter(([method]) => method === 'agent-chats.create')).toHaveLength(1)
      expect(f.call).toHaveBeenLastCalledWith('agent-chats.send', { id, input: [{ type: 'text', text: 'Hello' }], permissionMode: 'ask' })
    } finally { f.session.dispose() }
  })

  it('reopens saved ACP history and scopes approvals to the pane-owned chat', async () => {
    const f = fixture()
    try {
      await f.session.openThread(chat.summary)
      f.extensions[`agent-chats.${id}`] = { ...chat, turn: 'running', requests: [{ id: 'request', method: 'agent/requestApproval', receivedAt: '', params: { threadId: id } }] } as unknown as JsonValue
      f.update()
      expect(f.session.snapshot().agentStatus.label).toBe('Waiting for approval')
      await f.session.resolveRequest('request', { optionId: 'allow' })
      expect(f.call).toHaveBeenLastCalledWith('agent-chats.approve', { id, requestId: 'request', optionId: 'allow' })
      expect(f.native.openThread).not.toHaveBeenCalled()
    } finally { f.session.dispose() }
  })

  it('leaves native Codex sends on the existing transport', async () => {
    const f = fixture()
    try {
      await f.session.send(draft)
      expect(f.native.send).toHaveBeenCalledWith(draft)
      expect(f.call).not.toHaveBeenCalled()
    } finally { f.session.dispose() }
  })
  it('keeps ACP approval policy independent of late Codex defaults', async () => {
    const f = fixture()
    try {
      await f.session.openThread(chat.summary)
      f.native.snapshot().session.permissionMode = 'full'
      f.update()
      expect(f.session.snapshot().session.permissionMode).toBe('ask')
      f.session.setPermissionMode('auto')
      f.update()
      expect(f.session.snapshot().session.permissionMode).toBe('auto')
      expect(f.native.setPermissionMode).not.toHaveBeenCalled()
    } finally { f.session.dispose() }
  })

})

it('enables and routes live steering only for an agent that advertises it', async () => {
  const f = fixture()
  try {
    f.session.setProvider('pi')
    await f.session.send(draft)
    expect(f.session.snapshot().canSteer).toBe(false)
    f.session.newThread()
    f.session.setProvider('claude')
    await f.session.send(draft)
    expect(f.session.snapshot().canSteer).toBe(true)
    await f.session.steer({ ...draft, text: 'Change direction' })
    expect(f.call).toHaveBeenLastCalledWith('agent-chats.steer', { id: 'acp-22222222-2222-2222-2222-222222222222', input: [{ type: 'text', text: 'Change direction' }] })
  } finally { f.session.dispose() }
})

it('keeps native turn and project state out of ACP while retaining shared history', async () => {
  const f = fixture()
  try {
    const native = f.native.snapshot()
    native.threadId = 'native-thread'
    native.activeProjectId = 'native-project'
    native.projectScope = 'workspace'
    native.models = [{ id: 'native-model', displayName: 'Native model', isDefault: true }]
    native.agentPlan = [{ content: 'Native plan', status: 'pending' }]
    native.turn = { tag: 'sending' }
    native.activities = [{ id: 'native-message', kind: 'agent', title: 'Assistant', content: 'Native message', timestamp: '' }]
    native.threads = [{ ...chat.summary, id: 'native-thread' }]
    await f.session.openThread(chat.summary)
    expect(f.session.snapshot()).toMatchObject({ providerId: 'pi', threadId: id, turn: { tag: 'idle' },
      activities: [], models: [], projectScope: 'unscoped', activeProjectId: undefined })
    expect(f.session.snapshot().agentPlan).toBeUndefined()
    expect(f.session.snapshot().threads.map((thread) => thread.id)).toEqual(expect.arrayContaining([id, 'native-thread']))
    await f.session.openThread(native.threads[0]!)
    expect(f.session.snapshot()).toMatchObject({ providerId: 'codex', threadId: 'native-thread',
      activeProjectId: 'native-project', activities: native.activities, models: native.models, turn: { tag: 'sending' } })
  } finally { f.session.dispose() }
})

it('keeps model choices stable during streaming and updates them when configuration changes', async () => {
  const f = fixture()
  try {
    const state = { ...structuredClone(chat), configurationRevision: 1, configOptions: [{ id: 'model', name: 'Model', category: 'model',
      currentValue: 'one', options: [{ value: 'one', name: 'One' }, { value: 'two', name: 'Two' }] }] }
    f.extensions[`agent-chats.${id}`] = state as unknown as JsonValue
    await f.session.openThread(chat.summary)
    const models = f.session.snapshot().models
    expect(f.session.snapshot().session.model).toBe('one')
    f.extensions[`agent-chats.${id}`] = { ...structuredClone(state), turn: 'running' } as unknown as JsonValue
    f.update()
    expect(f.session.snapshot().models).toBe(models)
    state.configOptions[0]!.currentValue = 'two'
    state.configurationRevision++
    f.extensions[`agent-chats.${id}`] = state as unknown as JsonValue
    f.update()
    expect(f.session.snapshot().session.model).toBe('two')
    expect(f.session.snapshot().models).not.toBe(models)
  } finally { f.session.dispose() }
})
