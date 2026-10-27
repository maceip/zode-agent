import type { AgentConfigOption, AgentProviderSnapshot } from '../../src/server/services/agent-registry.js'
import type { ClientDraft, ClientHostService } from '../../src/client/plugin-api.js'
import { isRecord, type LocalProject, type LocalProjectInput, type PermissionMode, type ThreadSummary } from '../../src/shared/protocol.js'
import type { ClientSessionService, ClientSessionSnapshot } from './session-api.js'
import { AGENT_CHATS_STATE, agentChatStateKey, isAgentChatId, type AgentChat, type AgentChatCatalog, agentPromptInput } from './agent-chats-api.js'
import { configuredDefaults } from './session-defaults.js'
import { MODEL_DEFAULTS_STATE, modelDefaults } from './model-defaults-api.js'
import { draftAgentConfig, resolveDraftConfigValue } from './agent-model-options.js'
import { projectForWorkspace } from './ui/history-model.js'
import type { ActivityItem } from './ui/transcript.js'

export class AgentSessionService implements ClientSessionService {
  private configurationKey = ''
  private draftConfig = new Map<string, string>()
  private configuration: NonNullable<AgentChat['configOptions']> = []
  private models: NonNullable<ClientSessionSnapshot['models']> = []
  private workspaceNameKey = ''
  private workspaceName: string | undefined
  private providersKey = ''
  private providers: NonNullable<ClientSessionSnapshot['providers']> = []
  private state!: ClientSessionSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly cleanup: Array<() => void>
  private providerId = 'codex'
  private providerSelectionChanged = false
  private permissionMode: PermissionMode | undefined
  private threadId: string | undefined
  private chat: AgentChat | undefined
  private creating: Promise<string> | undefined
  private sending = false
  private startupPrompt: ActivityItem | undefined
  private generation = 0
  private disposed = false
  private pendingRestore: string | undefined
  private problem: string | undefined
  private revision = 0
  private configuring: Promise<void> = Promise.resolve()
  private requestedState: string | undefined

  constructor(
    private readonly native: ClientSessionService,
    private readonly host: ClientHostService,
    private readonly options: { restoreThreadId?: string; persist?: (id?: string) => void; useDefaults?: boolean } = {},
  ) {
    this.providerSelectionChanged = options.useDefaults === false
    this.pendingRestore = options.restoreThreadId
    this.cleanup = [native.subscribe(() => this.sync()), host.subscribe(() => this.sync())]
    this.sync()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  snapshot = (): ClientSessionSnapshot => this.state

  private catalog(): AgentChatCatalog {
    const value = this.host.snapshot().snapshot?.extensions[AGENT_CHATS_STATE]
    return isRecord(value) && Array.isArray(value.providers) && Array.isArray(value.threads)
      ? value as unknown as AgentChatCatalog : { providers: [], threads: [] }
  }

  private sync(): void {
    if (this.disposed) return
    const native = this.native.snapshot()
    const catalog = this.catalog()
    if (!this.providerSelectionChanged && !this.pendingRestore && !this.threadId && !native.threadId
      && !this.creating && !this.sending && native.turn.tag === 'idle' && !native.activities.length) {
      const defaults = modelDefaults(this.host.snapshot().snapshot?.extensions[MODEL_DEFAULTS_STATE])
      const preferred = defaults?.providerId ?? 'codex'
      const available = preferred === 'codex' || catalog.providers.some((provider) => provider.id === preferred)
      if (defaults && available && this.providerId !== preferred) {
        this.providerId = preferred
        this.draftConfig.clear()
        this.problem = undefined
      }
    }
    if (!this.host.snapshot().connected) this.requestedState = undefined
    const provider = catalog.providers.find((candidate) => candidate.id === this.providerId)
    const choices = catalog.providers.map(({ id, label, agentId, location }) => ({
      id, label, ...(agentId ? { agentId } : {}), ...(location ? { location } : {}),
    }))
    const providersKey = JSON.stringify(choices)
    if (!this.providers.length || providersKey !== this.providersKey) {
      this.providersKey = providersKey
      this.providers = [{ id: 'codex', label: 'Codex' }, ...choices]
    }
    const providers = this.providers
    const summaries = catalog.threads.map((thread) => {
      const project = projectForWorkspace(native.projects, thread.cwd)
      return project ? { ...thread, projectId: project.id } : thread
    })
    const threads = [...new Map([...native.threads, ...summaries].map((thread) => [thread.id, thread])).values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
    // Only connection, projects, and history are shared. Codex's active turn,
    // model, and project selection must not leak into an ACP conversation.
    const common = { revision: ++this.revision, providers, providerId: this.providerId,
      connected: native.connected, connectionError: native.connectionError, projects: native.projects,
      threads, history: { ...native.history, entries: threads } }
    if (this.providerId === 'codex') this.state = { ...native, ...common }
    else {
      this.syncChat(catalog, native.connected)
      const chat = this.chat
      const requests = chat?.requests ?? []
      const workspace = chat?.summary.cwd ?? native.session.workspace
      this.syncWorkspaceName(provider?.remoteLocation && !this.threadId && !chat ? workspace : undefined)
      const remoteWorkspaceName = chat?.remote?.workspaceName ?? this.workspaceName
      const project = projectForWorkspace(native.projects, workspace)
      const problem = this.problem ?? chat?.problem
      const turn = this.sending || this.creating ? 'sending' : chat?.turn ?? 'idle'
      let activities = chat?.activities ?? []
      const acceptedPrompt = activities.find((item) => item.kind === 'user')
      const remoteStarting = Boolean(this.startupPrompt && !acceptedPrompt && !problem && turn !== 'idle')
      if (this.startupPrompt) {
        // Provisioning and journal acknowledgement arrive separately. Keep the
        // submitted bubble (and its React key) in place throughout the handoff.
        const prompt = this.startupPrompt
        activities = acceptedPrompt
          ? activities.map((item) => item === acceptedPrompt ? { ...item, ...prompt } : item)
          : [prompt, ...activities]
      }
      this.syncConfiguration(chat, provider, native)
      const config = this.configuration
      const model = config.find((option) => option.category === 'model')
      const effort = config.find((option) => option.category === 'thought_level')
      this.state = {
        ...common, ...(provider?.remoteLocation ? { remoteLocation: provider.remoteLocation } : {}), ...(remoteWorkspaceName ? { remoteWorkspaceName } : {}), ...(chat?.remote?.workspace ? { remoteWorkspace: chat.remote.workspace } : {}), threadId: this.threadId, canAcceptDirectInput: true, models: this.models,
        connected: common.connected && (!chat?.remote || chat.remote.state === 'connected'),
        agentConfig: config, ...(chat?.plan ? { agentPlan: chat.plan } : {}), ...(chat?.usage ? { agentUsage: chat.usage } : {}), ...(chat?.commands ? { agentCommands: chat.commands } : {}),
        canSteer: provider?.capabilities.steering === true, acceptsImages: provider?.capabilities.images === true,
        session: { workspace, permissionMode: this.permissionMode ?? chat?.permissionMode ?? native.session.permissionMode, ...(model ? { model: model.currentValue } : {}), ...(effort ? { effort: effort.currentValue } : {}) },
        remoteStarting,
        activeProjectId: project?.id, projectScope: project ? 'workspace' : 'unscoped',
        turn: { tag: turn },
        agentStatus: { state: chat?.remote && chat.remote.state !== 'connected' ? 'waiting' : requests.length ? 'waiting' : turn === 'idle' ? 'idle' : 'running',
          label: chat?.remote && chat.remote.state !== 'connected' ? chat.remote.state === 'ended' ? 'Remote agent stopped' : 'Reconnecting to remote agent' : requests.length ? requests.some((request) => request.method === 'agent/requestUserInput') ? 'Waiting for your reply' : 'Waiting for approval' : turn === 'idle' ? provider?.label ?? 'Agent' : 'Working' },
        activities: [...activities, ...(problem ? [{ id: `agent-error:${this.threadId ?? 'new'}:${problem}`,
          kind: 'status' as const, title: 'Agent error', content: problem, status: 'failed', timestamp: '' }] : [])],
        hasEarlierActivities: false, loadingEarlierActivities: false,
        skills: !provider?.remoteLocation && workspace === native.session.workspace ? native.skills : [],
        ...(native.harness ? { harness: { ...native.harness, pendingRequests: requests } } : {}),
      }
    }
    for (const listener of this.listeners) listener()
    const restored = this.pendingRestore && summaries.find((thread) => thread.id === this.pendingRestore)
    if (restored) {
      this.pendingRestore = undefined
      void this.openThread(restored).catch((error: unknown) => { this.problem = String(error); this.sync() })
    }
  }

  private syncWorkspaceName(workspace: string | undefined): void {
    const key = workspace === undefined ? '' : `${this.providerId}:${workspace}`
    if (key === this.workspaceNameKey) return
    this.workspaceNameKey = key
    this.workspaceName = undefined
    if (workspace === undefined) return
    void this.host.call('agent-chats.workspace-name', { providerId: this.providerId, cwd: workspace }).then((value) => {
      if (this.disposed || this.workspaceNameKey !== key) return
      this.workspaceName = isRecord(value) && typeof value.name === 'string' ? value.name : undefined
      this.sync()
    }).catch(() => {
      // Workspace metadata is optional. A failed lookup must leave the draft
      // editable and must not start or reconnect an agent to obtain a name.
    })
  }

  private syncChat(catalog: AgentChatCatalog, connected: boolean): void {
    const current = this.threadId ? this.host.snapshot().snapshot?.extensions[agentChatStateKey(this.threadId)] : undefined
    if (isRecord(current) && isRecord(current.summary) && current.summary.id === this.threadId) {
      this.chat = current as unknown as AgentChat
      this.requestedState = undefined
    } else if (this.threadId && connected && this.requestedState !== this.threadId
      && catalog.threads.some((thread) => thread.id === this.threadId)) {
      const id = this.threadId
      const generation = this.generation
      this.requestedState = id
      // A server restart removes per-chat extension state. Reopen the saved
      // transcript once; never send an ACP identifier through Codex history.
      void this.host.call('agent-chats.open', { id }).then((value) => {
        if (this.disposed || generation !== this.generation) return
        this.chat = value as unknown as AgentChat
        this.sync()
      }, (error: unknown) => {
        if (this.disposed || generation !== this.generation) return
        this.problem = error instanceof Error ? error.message : String(error)
        this.sync()
      })
    }
  }

  private syncConfiguration(chat: AgentChat | undefined, provider: AgentProviderSnapshot | undefined, native: ClientSessionSnapshot): void {
    const remoteCodex = provider?.agentId === 'codex'
    const nativeModels = native.models ?? native.harness?.codex.models ?? []
    const inherited = remoteCodex ? structuredClone(configuredDefaults(native.harness)) : undefined
    if (inherited?.model && !nativeModels.some((model) => model.id === inherited.model)) {
      delete inherited.model
      delete inherited.effort
    }
    const saved = modelDefaults(this.host.snapshot().snapshot?.extensions[MODEL_DEFAULTS_STATE])?.choices[this.providerId]
    const defaults = { ...inherited, ...saved }
    const configurationKey = chat ? `${this.threadId}:${chat.configurationRevision ?? 0}`
      : JSON.stringify([this.providerId, this.threadId, provider?.configOptions, remoteCodex ? nativeModels : [], defaults, [...this.draftConfig]])
    if (configurationKey === this.configurationKey) return
    this.configurationKey = configurationKey
    let config = chat?.configOptions ?? []
    if (!chat && !this.threadId) {
      config = (provider?.configOptions ?? []).filter((option) => option.category === 'model' || option.category === 'thought_level')
      const modelId = config.find((option) => option.category === 'model')?.id
      config = draftAgentConfig(provider?.agentId ?? provider?.id ?? '', config, (modelId ? this.draftConfig.get(modelId) : undefined) ?? defaults.model)
      if (remoteCodex && nativeModels.length) {
        const selected = nativeModels.find((model) => model.id === this.draftConfig.get('model'))
          ?? nativeModels.find((model) => model.id === defaults?.model)
          ?? nativeModels.find((model) => model.isDefault) ?? nativeModels[0]!
        config = [{ id: 'model', name: 'Model', category: 'model', currentValue: selected.id,
          options: nativeModels.map((model) => ({ value: model.id, name: model.displayName })) },
        { id: 'effort', name: 'Reasoning', category: 'thought_level', currentValue: selected.defaultReasoningEffort ?? '',
          options: (selected.supportedReasoningEfforts ?? []).map((effort) => ({ value: effort.reasoningEffort, name: effort.description ?? effort.reasoningEffort })) }]
      }
      config = config.map((option) => {
        const agentDefault = modelId && this.draftConfig.get(modelId) === 'default'
          && config.find((candidate) => candidate.id === modelId)?.options.some((candidate) => candidate.value === 'default' && candidate.name === 'Agent default')
        const value = this.draftConfig.get(option.id)
          ?? (option.category === 'thought_level' && agentDefault ? undefined
            : option.category === 'model' ? defaults.model : defaults.effort)
        const selected = value && resolveDraftConfigValue(provider?.agentId ?? provider?.id ?? '', option, value)
        return selected ? { ...option, currentValue: selected } : option
      })
    }
    this.configuration = config
    const model = config.find((option) => option.category === 'model')
    const effort = config.find((option) => option.category === 'thought_level')
    this.models = model?.options.map((option) => ({ id: option.value, displayName: option.name,
      isDefault: option.value === model.currentValue, ...(effort ? { defaultReasoningEffort: effort.currentValue,
      supportedReasoningEfforts: effort.options.map((value) => ({ reasoningEffort: value.value, description: value.name })) } : {}) })) ?? []
  }

  // Provider selection only edits the draft. Creating a session can provision a
  // remote workstation, so send() starts it after the first prompt is submitted.
  setProvider(id: string): void {
    if ((this.state.threadId && this.state.activities.length > 0) || this.state.turn.tag !== 'idle' || !this.state.providers?.some((provider) => provider.id === id)) return
    this.generation++
    this.providerSelectionChanged = true
    this.threadId = undefined
    this.chat = undefined
    this.startupPrompt = undefined
    this.providerId = id
    this.draftConfig.clear()
    this.configuring = Promise.resolve()
    this.problem = undefined
    this.sync()
  }
  hasSurface(id: string): boolean { return this.native.hasSurface(id) }
  async loadModels(): Promise<void> {
    if (this.providerId === 'codex') await this.native.loadModels?.()
  }
  setModel(model: string | undefined): void {
    this.providerSelectionChanged = true
    if (this.providerId === 'codex') this.native.setModel(model)
    else { const option = this.configuration.find((option) => option.category === 'model'); if (option && model) this.setAgentConfig(option.id, model) }
  }
  setEffort(effort: string | undefined): void {
    this.providerSelectionChanged = true
    if (this.providerId === 'codex') this.native.setEffort(effort)
    else { const option = this.configuration.find((option) => option.category === 'thought_level'); if (option && effort) this.setAgentConfig(option.id, effort) }
  }
  setAgentConfig(configId: string, value: string): void {
    this.providerSelectionChanged = true
    const id = this.threadId
    if (!id) {
      if (this.creating || this.sending) return
      const option = this.configuration.find((option) => option.id === configId)
      if (!option?.options.some((candidate) => candidate.value === value)) return
      this.draftConfig.set(configId, value)
      this.sync()
      for (const option of this.configuration) {
        const selected = this.draftConfig.get(option.id)
        if (selected && !option.options.some((candidate) => candidate.value === selected)) this.draftConfig.delete(option.id)
      }
      return
    }
    const generation = this.generation
    this.configuring = this.configuring.catch(() => {}).then(async () => {
      await this.host.call('agent-chats.configure', { id, configId, value })
    }).catch((error: unknown) => {
      if (generation === this.generation) { this.problem = String(error); this.sync() }
      throw error
    })
    void this.configuring.catch(() => {})
  }
  setPermissionMode(mode: PermissionMode): void {
    if (this.providerId === 'codex') this.native.setPermissionMode(mode)
    else { this.permissionMode = mode; this.sync() }
  }

  async ensureThread(workspace?: string): Promise<string> {
    this.providerSelectionChanged = true
    if (this.providerId === 'codex') return this.native.ensureThread(workspace)
    if (this.threadId) return this.threadId
    if (this.creating) return this.creating
    const generation = this.generation
    const providerId = this.providerId
    const provider = this.catalog().providers.find((provider) => provider.id === providerId)
    const agentId = provider?.agentId ?? providerId
    const remoteCodex = agentId === 'codex'
    const saved = modelDefaults(this.host.snapshot().snapshot?.extensions[MODEL_DEFAULTS_STATE])?.choices[providerId]
    const modelOption = this.configuration.find((option) => option.category === 'model')
    const explicitModel = modelOption && this.draftConfig.has(modelOption.id)
    const defaultModel = modelOption?.currentValue === 'default'
      && modelOption?.options.some((choice) => choice.value === 'default' && choice.name === 'Agent default')
    const effortOption = this.configuration.find((option) => option.category === 'thought_level')
    const inheritEffort = !explicitModel || (!defaultModel && effortOption?.options.some((choice) => choice.value === saved?.effort))
    const selections = this.configuration.flatMap((option) => {
      const inherited = option.category === 'model' ? saved?.model
        : option.category === 'thought_level' && inheritEffort ? saved?.effort : undefined
      // Concrete values shown in a draft must also configure its first session.
      // Agent default leaves the CLI's model and unselected reasoning unchanged.
      const displayed = remoteCodex || option.category === 'model' || (modelOption && !defaultModel)
        ? option.currentValue || undefined : undefined
      const displayedDefault = displayed === 'default'
        && option.options.some((choice) => choice.value === displayed && choice.name === 'Agent default')
      const value = this.draftConfig.get(option.id) ?? inherited ?? (displayedDefault ? undefined : displayed)
      if (option.category === 'model' && value === 'default'
        && option.options.some((choice) => choice.value === value && choice.name === 'Agent default')) return []
      return value === undefined ? [] : [{ ...option, currentValue: value }]
    })
    for (const [category, name, value] of [
      ['model', 'Model', explicitModel ? undefined : saved?.model], ['thought_level', 'Reasoning', inheritEffort ? saved?.effort : undefined],
    ] as const) {
      if (value && !selections.some((option) => option.category === category)) {
        selections.push({ id: category, category, name, currentValue: value, options: [{ value, name: value }] })
      }
    }
    // A model change can replace its reasoning choices. Configure it first,
    // regardless of the order in which the agent advertises its controls.
    selections.sort((a, b) => Number(b.category === 'model') - Number(a.category === 'model'))
    const operation = this.host.call('agent-chats.create', { providerId,
      cwd: workspace ?? this.state.session.workspace, permissionMode: this.state.session.permissionMode,
    }).then(async (value) => {
      if (!isRecord(value) || !isRecord(value.summary) || typeof value.summary.id !== 'string') throw new Error('Agent did not create a chat')
      if (!this.disposed && generation === this.generation) {
        this.threadId = value.summary.id
        this.chat = value as unknown as AgentChat
        this.options.persist?.(this.threadId)
      }
      const id = value.summary.id
      let config = (value as unknown as AgentChat).configOptions ?? []
      // Apply explicit and inherited settings before
      // sending. A rejected choice leaves the prompt unsent and the actual options visible.
      for (const selection of selections) {
        const option = config.find((option) => option.category === selection.category)
        const selected = option && resolveDraftConfigValue(agentId, option, selection.currentValue)
        if (!option || selected === undefined) {
          throw new Error(`${selection.name} "${selection.options.find((option) => option.value === selection.currentValue)?.name ?? selection.currentValue}" is unavailable for this agent. Choose another option and send again.`)
        }
        if (option.currentValue === selected) continue
        const response = await this.host.call('agent-chats.configure', { id, configId: option.id, value: selected })
        if (isRecord(response) && Array.isArray(response.configOptions)) config = response.configOptions as unknown as AgentConfigOption[]
      }
      if (!this.disposed && generation === this.generation && this.chat) {
        this.chat = { ...this.chat, configOptions: config, configurationRevision: (this.chat.configurationRevision ?? 0) + 1 }
        this.draftConfig.clear()
      }
      return id
    }).finally(() => {
      if (this.creating === operation) this.creating = undefined
      this.sync()
    })
    this.creating = operation
    this.sync()
    return operation
  }

  async send(draft: ClientDraft): Promise<void> {
    this.providerSelectionChanged = true
    if (this.providerId === 'codex') return this.native.send(draft)
    if (this.sending || (!this.creating && this.state.turn.tag !== 'idle')) throw new Error('Wait for this agent to finish or stop the turn first')
    const input = agentPromptInput(draft)
    if (!input.length) return
    const generation = this.generation
    const permissionMode = this.state.session.permissionMode
    this.problem = undefined
    if (this.state.remoteLocation && !this.threadId) {
      const createdAtMs = Date.now()
      this.startupPrompt = { id: `user:local:${crypto.randomUUID()}`, kind: 'user', title: 'You', content: draft.text.trim(),
        images: draft.images, attachments: draft.attachments, createdAtMs,
        timestamp: new Date(createdAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
    }
    this.sending = true
    this.sync()
    try {
      const id = await this.ensureThread()
      await this.configuring
      const value = await this.host.call('agent-chats.send', { id, input, permissionMode })
      if (generation === this.generation && isRecord(value) && isRecord(value.summary)) this.chat = value as unknown as AgentChat
    } catch (error) {
      if (generation === this.generation) {
        this.problem = error instanceof Error ? error.message : String(error)
        if (!this.chat?.activities.some((item) => item.kind === 'user')) this.startupPrompt = undefined
      }
      throw error
    } finally {
      if (generation === this.generation) this.sending = false
      this.sync()
    }
  }
  steer(draft: ClientDraft): Promise<void> {
    if (this.providerId === 'codex') return this.native.steer(draft)
    if (!this.threadId) return this.send(draft)
    return this.host.call('agent-chats.steer', { id: this.threadId, input: agentPromptInput(draft) }).then(() => {})
  }
  async interrupt(): Promise<void> {
    if (this.providerId === 'codex') return this.native.interrupt()
    if (this.threadId) await this.host.call('agent-chats.cancel', { id: this.threadId })
  }
  newThread(project?: LocalProject | null): void {
    this.generation++
    this.threadId = undefined
    this.chat = undefined
    this.startupPrompt = undefined
    this.creating = undefined
    this.sending = false
    this.problem = undefined
    this.requestedState = undefined
    this.draftConfig.clear()
    this.providerSelectionChanged = false
    const defaults = modelDefaults(this.host.snapshot().snapshot?.extensions[MODEL_DEFAULTS_STATE])
    if (defaults) this.providerId = defaults.providerId === 'codex' || this.catalog().providers.some((provider) => provider.id === defaults.providerId)
      ? defaults.providerId : 'codex'
    this.configuring = Promise.resolve()
    this.native.newThread(project)
    this.options.persist?.()
    this.sync()
  }
  retargetNewThread(project: LocalProject): boolean {
    if (this.threadId || this.state.turn.tag !== 'idle') return false
    return this.native.retargetNewThread(project)
  }
  async openThread(thread: ThreadSummary): Promise<void> {
    this.providerSelectionChanged = true
    this.startupPrompt = undefined
    this.draftConfig.clear()
    this.configuring = Promise.resolve()
    this.generation++
    const generation = this.generation
    this.creating = undefined
    this.sending = false
    this.problem = undefined
    if (!isAgentChatId(thread.id)) {
      this.providerId = 'codex'
      this.threadId = undefined
      this.chat = undefined
      await this.native.openThread(thread)
      this.sync()
      return
    }
    this.providerId = thread.providerId ?? this.catalog().threads.find((candidate) => candidate.id === thread.id)?.providerId ?? 'unknown'
    this.threadId = thread.id
    this.requestedState = thread.id
    this.chat = undefined
    this.sync()
    const value = await this.host.call('agent-chats.open', { id: thread.id })
    if (this.disposed || generation !== this.generation) return
    this.chat = value as unknown as AgentChat
    this.providerId = this.chat.summary.providerId
    this.permissionMode = this.chat.permissionMode
    this.options.persist?.(thread.id)
    this.sync()
  }
  async renameThread(id: string, name: string): Promise<void> {
    if (!isAgentChatId(id)) return this.native.renameThread(id, name)
    await this.host.call('agent-chats.rename', { id, title: name })
  }
  prefetchThread(thread: ThreadSummary): Promise<void> {
    return isAgentChatId(thread.id) ? Promise.resolve() : this.native.prefetchThread(thread)
  }
  loadEarlierActivities(): Promise<void> { return this.providerId === 'codex' ? this.native.loadEarlierActivities() : Promise.resolve() }
  selectProject(project: LocalProject): void { this.newThread(project) }
  saveProject(project: LocalProjectInput): Promise<void> { return this.native.saveProject(project) }
  createWorkspace(project: LocalProjectInput): Promise<void> { return this.native.createWorkspace(project) }
  removeProject(id: string): Promise<void> { return this.native.removeProject(id) }
  async refreshHistory(limit?: number): Promise<void> {
    await Promise.all([this.native.refreshHistory(limit), this.host.call('agent-chats.refresh-history', {})])
  }
  async resolveRequest(id: string | number, result: unknown): Promise<void> {
    if (this.providerId === 'codex') return this.native.resolveRequest(id, result)
    if (this.threadId && this.chat?.requests.some((request) => request.id === id && request.method === 'agent/requestUserInput')) {
      await this.host.call('agent-chats.answer', { id: this.threadId, requestId: String(id), response: result } as import('../../src/shared/protocol.js').JsonValue); return
    }
    if (!this.threadId || !isRecord(result) || typeof result.optionId !== 'string') throw new Error('Choose a permission option')
    await this.host.call('agent-chats.approve', { id: this.threadId, requestId: String(id), optionId: result.optionId })
  }
  resolveProposal(id: string, decision: 'accept' | 'decline'): Promise<void> { return this.native.resolveProposal(id, decision) }
  dispose(): void { this.disposed = true; this.generation++; this.cleanup.forEach((cleanup) => cleanup()); this.listeners.clear() }
}
