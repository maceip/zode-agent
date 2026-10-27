import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClientHostService,
  ClientHostSnapshot,
} from '../src/client/plugin-api.js'
import type {
  HarnessEvent,
  HarnessSnapshot,
  ThreadSummary,
  ThreadView,
} from '../src/shared/protocol.js'
import { SessionResources, SessionService } from '../program/plugins/session.client.js'
import { AgentSessionService } from '../program/plugins/agent-session.client.js'

function harness(activeThreadIds: string[] = [], status: HarnessSnapshot['codex']['status'] = 'starting'): HarnessSnapshot {
  return {
    codex: { status, models: [], activeThreadIds, threadStates: {}, threadSettings: {} },
    program: { revision: 0, profileText: '', plugins: [], files: [], tools: [], proposals: [] },
    projects: { revision: 0, projects: [] },
    ui: { regions: [], surfaces: [], contributions: [] },
    extensions: { 'session.workspace': '/tmp/alto-scratch' },
    pendingRequests: [],
    server: { port: 4317, host: '127.0.0.1', projectRoot: '/tmp/project' },
  }
}

function summary(id = 'thread-a'): ThreadSummary {
  return {
    id,
    title: id,
    preview: id,
    cwd: '/tmp/project',
    createdAt: 1,
    updatedAt: 2,
  }
}

function view(messages: ThreadView['messages'], id = 'thread-a'): ThreadView {
  return { summary: summary(id), messages }
}

class ControllableHost implements ClientHostService {
  programActivated(_revision: number): void {}
  private state: ClientHostSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: HarnessEvent) => void>()
  readonly command = vi.fn()
  readonly call = vi.fn()

  constructor(snapshot: HarnessSnapshot = harness()) {
    this.state = {
      revision: 0,
      connectionEpoch: 1,
      connection: 'online',
      connected: true,
      snapshot,
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientHostSnapshot => this.state
  journal = (): readonly HarnessEvent[] => []

  onEvent = (listener: (event: HarnessEvent) => void): (() => void) => {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  emit(event: HarnessEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }

  reconnect(snapshot: HarnessSnapshot): void {
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      connectionEpoch: this.state.connectionEpoch + 1,
      snapshot,
    }
    for (const listener of this.listeners) listener()
    this.emit({ type: 'snapshot', payload: snapshot })
  }
}

describe('session transport projection', () => {
  it('leaves Codex stopped until its models or a Codex message are requested', async () => {
    const snapshot = harness([], 'stopped')
    snapshot.extensions['agent-chats'] = { providers: [{ id: 'claude', agentId: 'claude', label: 'Claude', capabilities: {} }], threads: [] }
    const host = new ControllableHost(snapshot)
    const native = new SessionService(host, { restoreActiveThread: false })
    const session = new AgentSessionService(native, host)
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(session.snapshot().harness?.codex.models).toEqual([])
      expect(session.snapshot().projectScope).toBe('unscoped')
      expect(host.call).not.toHaveBeenCalled()
      expect(host.command).not.toHaveBeenCalled()
      session.setProvider('claude')
      await session.loadModels()
      expect(host.call).not.toHaveBeenCalled()

      session.setProvider('codex')
      await session.loadModels()
      expect(host.call).toHaveBeenCalledExactlyOnceWith('session.codex.start', {})
      host.command.mockImplementation(async (type: string) => {
        if (type === 'thread.new') return { thread: { id: 'new-codex-chat' } }
        if (type === 'chat.send') return { threadId: 'new-codex-chat' }
        return []
      })
      await session.send({ text: 'Hello', images: [], attachments: [], skills: [] })
      expect(host.command).toHaveBeenCalledWith('thread.new', expect.objectContaining({ workspace: '/tmp/alto-scratch' }))
      expect(host.command).toHaveBeenCalledWith('chat.send', expect.objectContaining({ text: 'Hello', workspace: '/tmp/alto-scratch' }))
      expect(host.call).toHaveBeenCalledWith('workspace-layout.unassign-thread', { threadId: 'new-codex-chat' })
    } finally { session.dispose(); native.dispose() }
  })

  it('allows a failed cold Codex send to be retried', async () => {
    const host = new ControllableHost(harness([], 'stopped'))
    const session = new SessionService(host, { restoreActiveThread: false })
    const draft = { text: 'Hello', images: [], attachments: [], skills: [] }
    try {
      host.command.mockRejectedValueOnce(new Error('Codex CLI is not installed'))
      await expect(session.send(draft)).rejects.toThrow('Codex CLI is not installed')
      expect(session.snapshot().turn.tag).toBe('idle')
      host.command.mockImplementation(async (type: string) => type === 'thread.new'
        ? { thread: { id: 'new-codex-chat' } } : { threadId: 'new-codex-chat' })
      await session.send(draft)
      expect(session.snapshot().threadId).toBe('new-codex-chat')
    } finally { session.dispose() }
  })

  it('lets a remote Codex draft choose a model from the real native session before starting', async () => {
    const snapshot = harness([], 'ready')
    snapshot.codex.models = [
      { id: 'first', displayName: 'First', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      { id: 'second', displayName: 'Second', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ]
    snapshot.extensions['session.defaults'] = { model: 'second', effort: 'high', permissionMode: 'full' }
    snapshot.extensions['agent-chats'] = { providers: [{ id: 'cloud-codex', agentId: 'codex', label: 'Codex', capabilities: {} }], threads: [] }
    const host = new ControllableHost(snapshot)
    const native = new SessionService(host, { restoreActiveThread: false })
    const session = new AgentSessionService(native, host)
    try {
      expect(native.snapshot().models).toBeUndefined()
      expect(native.snapshot().session).toMatchObject({ model: 'second', effort: 'high' })
      native.setModel('first')
      session.setProvider('cloud-codex')
      expect(session.snapshot().models?.map((model) => model.id)).toContain('second')
      expect(session.snapshot().session).toMatchObject({ model: 'second', effort: 'high' })
      session.setModel('second')
      session.setEffort('high')
      expect(session.snapshot().session).toMatchObject({ model: 'second', effort: 'high' })
      expect(session.snapshot().threadId).toBeUndefined()
      expect(host.call).not.toHaveBeenCalled()
      expect(host.command).not.toHaveBeenCalledWith('thread.new', expect.anything())
    } finally { session.dispose() }
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('waits for a scratch workspace without falling back to the Alto runtime', async () => {
    const unavailable = harness([], 'stopped')
    delete unavailable.extensions['session.workspace']
    const host = new ControllableHost(unavailable)
    const session = new SessionService(host, { restoreActiveThread: false })
    try {
      expect(session.snapshot().session.workspace).toBe('')
      await expect(session.send({ text: 'Hello', images: [], attachments: [], skills: [] }))
        .rejects.toThrow('scratch workspace')
      await expect(session.ensureThread()).rejects.toThrow('scratch workspace')
      expect(host.command).not.toHaveBeenCalled()

      host.reconnect(harness([], 'stopped'))
      expect(session.snapshot().session.workspace).toBe('/tmp/alto-scratch')
      host.reconnect(harness([], 'stopped'))
      expect(session.snapshot().session.workspace).toBe('/tmp/alto-scratch')
    } finally { session.dispose() }
  })

  it('preserves an explicitly selected directory when scratch defaults arrive or reconnect', () => {
    const unavailable = harness([], 'stopped')
    delete unavailable.extensions['session.workspace']
    const host = new ControllableHost(unavailable)
    const session = new SessionService(host, { initialWorkspace: '/work/selected', restoreActiveThread: false })
    try {
      host.reconnect(harness([], 'stopped'))
      expect(session.snapshot().session.workspace).toBe('/work/selected')
      host.reconnect(harness([], 'stopped'))
      expect(session.snapshot().session.workspace).toBe('/work/selected')

      session.newThread(null)
      expect(session.snapshot().session.workspace).toBe('/tmp/alto-scratch')
    } finally { session.dispose() }
  })

  it('keeps the working directory of an existing projectless conversation', async () => {
    const host = new ControllableHost(harness([], 'stopped'))
    host.command.mockResolvedValue(view([]))
    const session = new SessionService(host, { restoreActiveThread: false })
    try {
      await session.openThread(summary())
      expect(session.snapshot().session.workspace).toBe('/tmp/project')
      host.reconnect(harness([], 'stopped'))
      expect(session.snapshot().session.workspace).toBe('/tmp/project')

      session.newThread(null)
      expect(session.snapshot().session.workspace).toBe('/tmp/alto-scratch')
    } finally { session.dispose() }
  })

  it('starts projectless ACP chats in scratch without starting Codex', async () => {
    const snapshot = harness([], 'stopped')
    snapshot.extensions['agent-chats'] = { providers: [{ id: 'claude', label: 'Claude', capabilities: {} }], threads: [] }
    const host = new ControllableHost(snapshot)
    const native = new SessionService(host, { restoreActiveThread: false })
    const session = new AgentSessionService(native, host)
    host.call.mockImplementation(async (method: string) => {
      if (method === 'agent-chats.create') return {
        summary: { ...summary('acp-11111111-1111-1111-1111-111111111111'), cwd: '/tmp/alto-scratch', providerId: 'claude', providerSessionId: 'claude-session' },
        permissionMode: 'ask', turn: 'idle', activities: [], requests: [],
      }
      return null
    })
    try {
      session.setProvider('claude')
      await session.ensureThread()
      expect(host.call).toHaveBeenCalledWith('agent-chats.create', {
        providerId: 'claude', cwd: '/tmp/alto-scratch', permissionMode: 'ask',
      })
      expect(host.command).not.toHaveBeenCalled()
      expect(host.call).not.toHaveBeenCalledWith('session.codex.start', expect.anything())
    } finally { session.dispose(); native.dispose() }
  })

  it('adopts effective Codex defaults once they become available', () => {
    const host = new ControllableHost(harness([], 'starting'))
    const session = new SessionService(host)
    const ready = harness([], 'ready')
    ready.codex.models = [{
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'max' },
      ],
    }]
    ready.extensions['session.defaults'] = {
      model: 'gpt-5.6-sol',
      effort: 'max',
      permissionMode: 'full',
    }

    try {
      expect(session.snapshot().session.permissionMode).toBe('ask')

      host.reconnect(ready)

      expect(session.snapshot().session).toEqual({
        workspace: '/tmp/alto-scratch',
        model: 'gpt-5.6-sol',
        effort: 'max',
        permissionMode: 'full',
      })

      session.setEffort('medium')
      session.setPermissionMode('ask')
      host.reconnect(ready)

      expect(session.snapshot().session.effort).toBe('medium')
      expect(session.snapshot().session.permissionMode).toBe('ask')
    } finally {
      session.dispose()
    }
  })

  it('preserves preferences chosen before Codex defaults arrive', () => {
    const host = new ControllableHost(harness([], 'stopped'))
    const session = new SessionService(host)
    try {
      session.setModel('chosen-model')
      session.setEffort('high')
      session.setPermissionMode('ask')
      const ready = harness([], 'ready')
      ready.codex.defaults = { model: 'default-model', effort: 'low', permissionMode: 'full' }
      host.reconnect(ready)
      expect(session.snapshot().session).toMatchObject({ model: 'chosen-model', effort: 'high', permissionMode: 'ask' })
    } finally { session.dispose() }
  })

  it('renames a chat through the canonical session extension', async () => {
    const host = new ControllableHost(harness([], 'ready'))
    host.call.mockResolvedValue({ threadId: 'thread-a', name: 'Renamed chat' })
    const session = new SessionService(host)

    try {
      await session.renameThread('thread-a', '  Renamed chat  ')
      expect(host.call).toHaveBeenCalledWith('session.thread.rename', {
        threadId: 'thread-a',
        name: 'Renamed chat',
      })
    } finally {
      session.dispose()
    }
  })

  it('coalesces shared history and skill requests across pane sessions', async () => {
    const host = new ControllableHost(harness([], 'ready'))
    host.command.mockImplementation((type: string) => {
      if (type === 'thread.list' || type === 'skill.list') return Promise.resolve([])
      throw new Error(`unexpected command: ${type}`)
    })
    const resources = new SessionResources(host)
    const sessions = Array.from({ length: 6 }, () => new SessionService(host, {
      restoreActiveThread: false,
      persistActiveThread: false,
    }, resources))

    try {
      await vi.advanceTimersByTimeAsync(80)
      expect(host.command.mock.calls.filter(([type]) => type === 'thread.list')).toHaveLength(1)
      expect(host.command.mock.calls.filter(([type]) => type === 'skill.list')).toHaveLength(1)
      host.command.mockClear()

      host.emit({
        type: 'codex.notification',
        payload: { method: 'turn/completed', params: { threadId: 'background-thread' } },
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(host.command.mock.calls.filter(([type]) => type === 'thread.list')).toHaveLength(1)
    } finally {
      for (const session of sessions) session.dispose()
      resources.clear()
    }
  })

  it('ignores conversation events belonging to a background thread', async () => {
    const host = new ControllableHost()
    host.command.mockResolvedValue(view([{ id: 'prompt-a', role: 'user', text: 'Selected chat' }]))
    const session = new SessionService(host)

    try {
      await session.openThread(summary())
      host.emit({
        type: 'codex.notification',
        payload: { method: 'turn/started', params: { threadId: 'thread-b' } },
      })
      host.emit({
        type: 'codex.notification',
        payload: {
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-b', itemId: 'agent-b', delta: 'Background reply' },
        },
      })

      expect(session.snapshot().threadId).toBe('thread-a')
      expect(session.snapshot().turn.tag).toBe('idle')
      expect(session.snapshot().activities.map((activity) => activity.content)).toEqual(['Selected chat'])
    } finally {
      session.dispose()
    }
  })

  it('coalesces streamed transcript notifications to one subscriber update per frame', async () => {
    const host = new ControllableHost()
    host.command.mockResolvedValue(view([{ id: 'prompt-a', role: 'user', text: 'Selected chat' }]))
    const session = new SessionService(host)

    try {
      await session.openThread(summary())
      let emissions = 0
      const unsubscribe = session.subscribe(() => { emissions += 1 })
      for (const delta of ['One', ' two', ' three']) {
        host.emit({
          type: 'codex.notification',
          payload: {
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-a', itemId: 'agent-a', delta },
          },
        })
      }

      expect(session.snapshot().activities.at(-1)?.content).toBe('One two three')
      expect(emissions).toBe(0)

      await vi.advanceTimersByTimeAsync(16)
      expect(emissions).toBe(1)
      unsubscribe()
    } finally {
      session.dispose()
    }
  })

  it('keeps a new submission isolated from another chat that is already running', async () => {
    const host = new ControllableHost()
    let finishCreate: ((value: unknown) => void) | undefined
    let finishSend: ((value: unknown) => void) | undefined
    host.command.mockImplementation((type: string, payload: { threadId?: string }) => {
      if (type === 'thread.open') {
        return Promise.resolve(view([
          { id: 'prompt-running', role: 'user', text: 'Existing work' },
        ], payload.threadId))
      }
      if (type === 'thread.new') return new Promise((resolve) => { finishCreate = resolve })
      if (type === 'chat.send') return new Promise((resolve) => { finishSend = resolve })
      return Promise.resolve([])
    })
    const ready = harness([], 'ready')
    host.reconnect(ready)
    const running = new SessionService(host)
    const session = new SessionService(host, {
      restoreActiveThread: false,
      persistActiveThread: false,
    })

    try {
      await running.openThread(summary('thread-running'))
      host.emit({
        type: 'codex.notification',
        payload: { method: 'turn/started', params: { threadId: 'thread-running' } },
      })
      const sent = session.send({ text: 'Start', images: [], attachments: [], skills: [] })
      expect(session.snapshot().threadId).toBeUndefined()
      expect(session.snapshot().turn.tag).toBe('sending')

      host.emit({
        type: 'codex.notification',
        payload: {
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-running', itemId: 'agent-running', delta: 'Unrelated output' },
        },
      })
      expect(session.snapshot().threadId).toBeUndefined()
      expect(session.snapshot().activities.map((activity) => activity.content)).toEqual(['Start'])

      finishCreate?.({ thread: { id: 'thread-new' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(host.command).toHaveBeenCalledWith('chat.send', expect.objectContaining({
        threadId: 'thread-new',
        text: 'Start',
      }))

      host.emit({
        type: 'codex.notification',
        payload: { method: 'turn/started', params: { threadId: 'thread-new' } },
      })
      host.emit({
        type: 'codex.notification',
        payload: {
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-new', itemId: 'agent-new', delta: 'Working' },
        },
      })
      finishSend?.({ threadId: 'thread-new' })
      await sent

      expect(session.snapshot().threadId).toBe('thread-new')
      expect(session.snapshot().activities.at(-1)?.content).toBe('Working')
      expect(session.snapshot().history.entries[0]).toMatchObject({
        id: 'thread-new',
        title: 'New chat',
        preview: 'Start',
        cwd: '/tmp/alto-scratch',
      })
      expect(session.snapshot().threads[0]?.id).toBe('thread-new')
    } finally {
      running.dispose()
      session.dispose()
    }
  })

  it('keeps an unscoped new chat out of workspace groups after its first message', async () => {
    const ready = harness([], 'ready')
    ready.projects.projects = [{
      id: 'project',
      name: 'Project',
      primaryRoot: '/tmp/project',
      roots: ['/tmp/project'],
    }]
    const host = new ControllableHost(ready)
    host.command.mockImplementation((type: string) => {
      if (type === 'thread.new') return Promise.resolve({ thread: { id: 'thread-recent' } })
      if (type === 'chat.send') return Promise.resolve({ threadId: 'thread-recent' })
      return Promise.resolve(undefined)
    })
    const session = new SessionService(host, { initialProjectId: null })

    try {
      expect(session.snapshot().activeProjectId).toBeUndefined()
      expect(session.snapshot().projectScope).toBe('unscoped')

      await session.send({ text: 'A projectless chat', images: [], attachments: [], skills: [] })

      expect(host.call).toHaveBeenCalledWith('workspace-layout.unassign-thread', {
        threadId: 'thread-recent',
      })
      expect(session.snapshot().history.entries[0]?.id).toBe('thread-recent')
      expect(session.snapshot().history.entries[0]?.projectId).toBeUndefined()
      expect(session.snapshot().projectScope).toBe('unscoped')
    } finally {
      session.dispose()
    }
  })

  it('keeps an early semantic title when accepting a new thread', async () => {
    const host = new ControllableHost()
    let finishSend: ((value: unknown) => void) | undefined
    host.command.mockImplementation((type: string) => {
      if (type === 'thread.new') return Promise.resolve({ thread: { id: 'thread-new' } })
      if (type === 'chat.send') return new Promise((resolve) => { finishSend = resolve })
      return Promise.resolve([])
    })
    host.reconnect(harness([], 'ready'))
    const session = new SessionService(host)

    try {
      const sent = session.send({ text: 'Inspect the pane lifecycle', images: [], attachments: [], skills: [] })
      await vi.advanceTimersByTimeAsync(0)
      host.emit({
        type: 'codex.notification',
        payload: { method: 'turn/started', params: { threadId: 'thread-new' } },
      })
      host.emit({
        type: 'codex.notification',
        payload: {
          method: 'thread/name/updated',
          params: { threadId: 'thread-new', threadName: 'Pane lifecycle' },
        },
      })
      finishSend?.({ threadId: 'thread-new' })
      await sent

      expect(session.snapshot().history.entries[0]).toMatchObject({
        id: 'thread-new',
        title: 'Pane lifecycle',
        preview: 'Inspect the pane lifecycle',
      })
    } finally {
      session.dispose()
    }
  })

  it('uses resumed thread settings and honors direct-input capability', async () => {
    const ready = harness([], 'ready')
    ready.codex.threadStates = {
      'thread-a': { status: { type: 'idle' }, canAcceptDirectInput: false },
    }
    ready.codex.threadSettings = {
      'thread-a': {
        workspace: '/tmp/effective-worktree',
        permissionMode: 'full',
        model: 'gpt-effective',
        effort: 'high',
        modelProvider: 'openai',
        canAcceptDirectInput: false,
      },
    }
    const host = new ControllableHost(ready)
    host.command.mockImplementation((type: string) => {
      if (type === 'thread.open') return Promise.resolve({
        ...view([{ id: 'prompt-a', role: 'user', text: 'Existing prompt' }]),
        session: ready.codex.threadSettings?.['thread-a'],
      })
      return Promise.resolve([])
    })
    const session = new SessionService(host)

    try {
      await session.openThread(summary())

      expect(session.snapshot()).toMatchObject({
        session: {
          workspace: '/tmp/effective-worktree',
          permissionMode: 'full',
          model: 'gpt-effective',
          effort: 'high',
        },
        canAcceptDirectInput: false,
        turn: { tag: 'idle' },
      })

      await session.send({ text: 'Must not send', images: [], attachments: [], skills: [] })
      expect(host.command.mock.calls.filter(([type]) => type === 'chat.send')).toHaveLength(0)
    } finally {
      session.dispose()
    }
  })

  it('renders steering input before app-server acknowledges it', async () => {
    const host = new ControllableHost()
    let finishSteer: (() => void) | undefined
    host.command.mockImplementation((type: string) => {
      if (type === 'thread.open') {
        return Promise.resolve(view([{ id: 'prompt-a', role: 'user', text: 'Initial prompt' }]))
      }
      if (type === 'turn.steer') {
        return new Promise<void>((resolve) => { finishSteer = resolve })
      }
      return Promise.resolve([])
    })
    const session = new SessionService(host)

    try {
      await session.openThread(summary())
      host.emit({
        type: 'codex.notification',
        payload: { method: 'turn/started', params: { threadId: 'thread-a' } },
      })

      const steering = session.steer({ text: '  Change course  ', images: [], attachments: [], skills: [] })
      expect(session.snapshot().activities.map((activity) => activity.content)).toEqual([
        'Initial prompt',
        'Change course',
      ])
      expect(session.snapshot().activities[1]?.continuesTurn).toBe(true)

      host.emit({
        type: 'codex.notification',
        payload: {
          method: 'item/started',
          params: {
            threadId: 'thread-a',
            item: { id: 'steer-1', type: 'userMessage', content: [{ type: 'text', text: 'Change course' }] },
          },
        },
      })
      expect(session.snapshot().activities.filter((activity) => (
        activity.kind === 'user' && activity.content === 'Change course'
      ))).toHaveLength(1)

      finishSteer?.()
      await steering
    } finally {
      session.dispose()
    }
  })

  it('shows a queued submission started by App Server without a local send callback', async () => {
    const host = new ControllableHost()
    host.command.mockImplementation((type: string) => {
      if (type === 'thread.open') {
        return Promise.resolve(view([{ id: 'prompt-a', role: 'user', text: 'Initial prompt' }]))
      }
      return Promise.resolve([])
    })
    const session = new SessionService(host)

    try {
      await session.openThread(summary())
      host.emit({
        type: 'codex.notification',
        payload: { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-2' } } },
      })

      for (const method of ['item/started', 'item/completed']) host.emit({
        type: 'codex.notification',
        payload: { method, params: {
          threadId: 'thread-a', turnId: 'turn-2',
          item: { id: 'queued-input', type: 'userMessage', content: [{ type: 'text', text: 'Pick this up next' }] },
        } },
      })

      expect(session.snapshot().activities.filter((activity) => (
        activity.kind === 'user' && activity.content === 'Pick this up next'
      ))).toHaveLength(1)
      expect(session.snapshot().activities.at(-1)).toMatchObject({
        threadId: 'thread-a',
        turnId: 'turn-2',
        kind: 'user',
        content: 'Pick this up next',
      })
      expect(session.snapshot().activities.at(-1)?.continuesTurn).toBeUndefined()
      expect(session.snapshot().activities[0]?.turnId).toBeUndefined()
    } finally {
      session.dispose()
    }
  })

  it('shows queued input from turn snapshots and keeps messages isolated by pane', async () => {
    const host = new ControllableHost()
    host.command.mockImplementation((type: string) => type === 'thread.open'
      ? Promise.resolve(view([])) : Promise.resolve([]))
    const session = new SessionService(host)
    try {
      await session.openThread(summary())
      const item = { id: 'input', type: 'userMessage', content: [
        { type: 'text', text: 'Follow-up' },
        { type: 'mention', name: 'plan.md', path: '/tmp/plan.md' },
        { type: 'image', url: 'data:image/png;base64,AAAA' },
      ] }
      const emit = (threadId: string, turnId: string, method: string): void => host.emit({
        type: 'codex.notification', payload: { method, params: { threadId, turn: { id: turnId, items: [item] } } },
      })
      emit('thread-b', 'other-turn', 'turn/started')
      expect(session.snapshot().activities).toEqual([])
      emit('thread-a', 'turn-1', 'turn/started')
      emit('thread-a', 'turn-1', 'turn/completed')
      expect(session.snapshot().activities).toMatchObject([{
        id: 'user:thread-a:turn-1:input', content: 'Follow-up',
        images: [{ url: 'data:image/png;base64,AAAA' }],
        attachments: [{ name: 'plan.md', path: '/tmp/plan.md' }],
      }])
      emit('thread-a', 'turn-2', 'turn/started')
      expect(session.snapshot().activities.filter((activity) => activity.kind === 'user')).toHaveLength(2)
    } finally { session.dispose() }
  })

  it('switches to another chat immediately while the current chat is running', async () => {
    const host = new ControllableHost()
    let finishOpen: ((value: ThreadView) => void) | undefined
    host.command.mockImplementation((type: string, payload: { threadId?: string }) => {
      if (type !== 'thread.open') return Promise.resolve([])
      if (payload.threadId === 'thread-a') {
        return Promise.resolve(view([{ id: 'prompt-a', role: 'user', text: 'Chat A' }], 'thread-a'))
      }
      return new Promise((resolve) => { finishOpen = resolve })
    })
    const session = new SessionService(host)

    try {
      await session.openThread(summary('thread-a'))
      host.emit({
        type: 'codex.notification',
        payload: { method: 'turn/started', params: { threadId: 'thread-a' } },
      })
      expect(session.snapshot().turn.tag).toBe('running')

      const opening = session.openThread(summary('thread-b'))
      expect(session.snapshot()).toMatchObject({ threadId: 'thread-b', turn: { tag: 'idle' } })
      expect(session.snapshot().activities).toEqual([])

      finishOpen?.(view([{ id: 'prompt-b', role: 'user', text: 'Chat B' }], 'thread-b'))
      await opening
      expect(session.snapshot().activities.map((activity) => activity.content)).toEqual(['Chat B'])
    } finally {
      session.dispose()
    }
  })

  it('does not jump back when a submitted turn is accepted after navigation', async () => {
    const host = new ControllableHost()
    let finishSend: ((value: unknown) => void) | undefined
    host.command.mockImplementation((type: string, payload: { threadId?: string }) => {
      if (type === 'chat.send') return new Promise((resolve) => { finishSend = resolve })
      if (type === 'thread.open') {
        const id = payload.threadId ?? 'thread-a'
        return Promise.resolve(view([{ id: `prompt-${id}`, role: 'user', text: id }], id))
      }
      return Promise.resolve([])
    })
    const session = new SessionService(host)

    try {
      await session.openThread(summary('thread-a'))
      const sent = session.send({ text: 'Run in A', images: [], attachments: [], skills: [] })
      expect(session.snapshot().turn.tag).toBe('sending')

      await session.openThread(summary('thread-b'))
      expect(session.snapshot()).toMatchObject({ threadId: 'thread-b', turn: { tag: 'idle' } })

      finishSend?.({ threadId: 'thread-a' })
      await sent
      expect(session.snapshot()).toMatchObject({ threadId: 'thread-b', turn: { tag: 'idle' } })
      expect(session.snapshot().activities.map((activity) => activity.content)).toEqual(['thread-b'])
    } finally {
      session.dispose()
    }
  })

  it('reloads an inactive selected thread after reconnecting', async () => {
    const host = new ControllableHost()
    let current = view([{ id: 'prompt-a', role: 'user', text: 'Before disconnect' }])
    host.command.mockImplementation((type: string) => {
      if (type === 'thread.open') return Promise.resolve(current)
      if (type === 'thread.list') return Promise.resolve([summary()])
      if (type === 'skill.list') return Promise.resolve([])
      throw new Error(`unexpected command: ${type}`)
    })
    const session = new SessionService(host)

    try {
      await session.openThread(summary())
      host.emit({
        type: 'codex.notification',
        payload: { method: 'turn/started', params: { threadId: 'thread-a' } },
      })
      expect(session.snapshot().turn.tag).toBe('running')

      current = view([
        { id: 'prompt-a', role: 'user', text: 'Before disconnect' },
        { id: 'reply-a', role: 'agent', text: 'Finished while disconnected' },
      ])
      host.reconnect(harness([], 'ready'))
      await vi.advanceTimersByTimeAsync(0)

      expect(session.snapshot().turn.tag).toBe('idle')
      expect(session.snapshot().activities.at(-1)?.content).toBe('Finished while disconnected')
      expect(host.command.mock.calls.filter(([type]) => type === 'thread.open')).toHaveLength(2)
    } finally {
      session.dispose()
    }
  })
})
