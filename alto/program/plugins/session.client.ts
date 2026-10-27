import type {
  HarnessEvent,
  HarnessSnapshot,
  LocalProject,
  LocalProjectInput,
  ModelOption,
  PermissionMode,
  SessionOptions,
  ThreadSummary,
} from '../../src/shared/protocol.js'
import { isRecord } from '../../src/shared/protocol.js'
import type {
  BrowserPlugin,
  ClientDraft,
  ClientHostService,
} from '../../src/client/plugin-api.js'
import { SESSION_CODEX_START, SESSION_THREAD_RENAME } from './session-api.js'
import { configuredDefaults, defaultWorkspace } from './session-defaults.js'
import { AgentSessionService } from './agent-session.client.js'
import { isAgentChatId } from './agent-chats-api.js'
import type {
  ClientSessionCreateOptions,
  ClientSessionFactoryService,
  ClientSessionHandle,
  ClientSessionRouterService,
  ClientSessionService,
  ClientSessionSnapshot,
} from './session-api.js'
import {
  activityFrom,
  completeLatestTurn,
  mergeActivity,
} from './ui/activity-model.js'
import {
  activitiesFromThread,
  historyEntries,
  projectForWorkspace,
  withThreadTitle,
} from './ui/history-model.js'
import {
  deriveAgentStatus,
  initialLink,
  initialTurn,
  stepLink,
  stepTurn,
  type LinkState,
  type TurnState,
} from './ui/machines.js'
import { now, recordAt, stringValue } from './ui/values.js'
import {
  activityScope,
  bindPendingTurn,
  reconcileTranscriptSnapshot,
  settleTranscriptTurn,
} from './ui/transcript.js'
import {
  cachedThreadIsFresh,
  ThreadActivityCache,
  type CachedThreadActivities,
} from './thread-cache.js'

const ASTRA_MODEL: ModelOption = {
  id: 'gpt-6-astra',
  displayName: 'GPT-6 Astra',
  defaultReasoningEffort: 'low',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
    { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
    { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
    { reasoningEffort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
    { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
  ],
}

function withAstraModel(harness: HarnessSnapshot | undefined): HarnessSnapshot | undefined {
  if (!harness || harness.codex.status !== 'ready' || harness.codex.models.some((model) => model.id === ASTRA_MODEL.id)) return harness
  return {
    ...harness,
    codex: {
      ...harness.codex,
      models: [ASTRA_MODEL, ...harness.codex.models],
    },
  }
}

function withModel(current: SessionOptions, model: string | undefined): SessionOptions {
  const next = { ...current }
  if (model) next.model = model
  else delete next.model
  return next
}

function withEffort(current: SessionOptions, effort: string | undefined): SessionOptions {
  const next = { ...current }
  if (effort) next.effort = effort
  else delete next.effort
  return next
}

function sessionDefaults(
  harness: HarnessSnapshot | undefined,
  workspace = '',
): SessionOptions {
  const defaults = configuredDefaults(harness)
  const model = defaults?.model
    ?? harness?.codex.models.find((candidate) => candidate.isDefault)?.id
  const selected = harness?.codex.models.find((candidate) => candidate.id === model)
    ?? harness?.codex.models.find((candidate) => candidate.isDefault)
  const effort = defaults?.effort ?? selected?.defaultReasoningEffort

  return {
    workspace: workspace || defaultWorkspace(harness),
    permissionMode: defaults?.permissionMode ?? 'ask',
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}

const THREAD_CACHE_LIMIT = 12
const THREAD_PAGE_SIZE = 24
const RECENT_THREAD_WARM_LIMIT = 8
const THREAD_TITLE_LIMIT = 72

const ACTIVE_THREAD_STORAGE_KEY = 'codex-cordis.session.active-thread'

const FRAME_COALESCED_ACTIVITY_METHODS = new Set([
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/fileChange/patchUpdated',
  'item/reasoning/summaryTextDelta',
])

function sameActivities(
  left: CachedThreadActivities['activities'],
  right: CachedThreadActivities['activities'],
): boolean {
  return left.length === right.length
    && left.every((activity, index) => JSON.stringify(activity) === JSON.stringify(right[index]))
}

function notificationThreadId(event: HarnessEvent & { type: 'codex.notification' }): string | undefined {
  const params = event.payload.params
  return stringValue(params?.threadId)
    ?? stringValue(recordAt(params, 'thread')?.id)
    ?? stringValue(recordAt(params, 'turn')?.threadId)
}

function upsertThread(
  entries: ThreadSummary[],
  summary: ThreadSummary,
): ThreadSummary[] {
  const existing = entries.find((thread) => thread.id === summary.id)
  const next = existing
    ? {
        ...existing,
        ...summary,
        updatedAt: Math.max(summary.updatedAt, existing.updatedAt),
        recencyAt: Math.max(
          summary.recencyAt ?? summary.updatedAt,
          existing.recencyAt ?? existing.updatedAt,
        ),
      }
    : summary
  return [next, ...entries.filter((thread) => thread.id !== summary.id)]
}

function updateThread(
  entries: ThreadSummary[],
  summary: ThreadSummary,
): ThreadSummary[] {
  const next = upsertThread(entries, summary)[0] ?? summary
  const index = entries.findIndex((thread) => thread.id === summary.id)
  if (index < 0) return [next, ...entries]
  return entries.map((thread, entryIndex) => entryIndex === index ? next : thread)
}

interface SessionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function browserStorage(): SessionStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

interface SharedRequest<Value> {
  token?: unknown
  value?: Value
  pending?: Promise<Value>
}

export class SessionResources {
  readonly threadCache: ThreadActivityCache
  private readonly histories = new Map<number, SharedRequest<ThreadSummary[]>>()
  private readonly skills = new Map<string, SharedRequest<ClientSessionSnapshot['skills']>>()
  private readonly threadLoads = new Map<string, Promise<CachedThreadActivities>>()
  private readonly threadPreviews = new Map<string, Promise<CachedThreadActivities>>()

  constructor(
    private readonly host: ClientHostService,
    threadCache = new ThreadActivityCache(THREAD_CACHE_LIMIT),
  ) {
    this.threadCache = threadCache
  }

  listThreads(limit: number, token?: unknown): Promise<ThreadSummary[]> {
    return this.request(this.histories, limit, token, () => (
      this.host.command('thread.list', { limit })
    ))
  }

  listSkills(
    workspace: string,
    token?: unknown,
  ): Promise<ClientSessionSnapshot['skills']> {
    return this.request(this.skills, workspace, token, () => (
      this.host.command('skill.list', { workspace })
    ))
  }

  openThread(
    thread: ThreadSummary,
    session: SessionOptions,
  ): Promise<CachedThreadActivities> {
    const workspace = thread.cwd || session.workspace
    const key = JSON.stringify({
      kind: 'resume',
      threadId: thread.id,
      updatedAt: thread.updatedAt,
      workspace,
    })
    const pending = this.threadLoads.get(key)
    if (pending) return pending
    const load = this.host.command('thread.open', {
      ...session,
      workspace,
      threadId: thread.id,
    }).then((view) => {
      const entry = {
        summary: view.summary,
        activities: activitiesFromThread(view, this.host.journal()),
        ...(view.olderCursor ? { olderCursor: view.olderCursor } : {}),
        ...(view.session ? { session: view.session } : {}),
        resumed: true,
      } satisfies CachedThreadActivities
      this.threadCache.put(entry)
      return entry
    }).finally(() => {
      if (this.threadLoads.get(key) === load) this.threadLoads.delete(key)
    })
    this.threadLoads.set(key, load)
    return load
  }

  previewThread(thread: ThreadSummary): Promise<CachedThreadActivities> {
    const key = `preview:${thread.id}:${thread.updatedAt}`
    const pending = this.threadPreviews.get(key)
    if (pending) return pending
    const load = this.host.command('thread.page', {
      threadId: thread.id,
      limit: THREAD_PAGE_SIZE,
    }).then((page) => {
      const entry = {
        summary: thread,
        activities: activitiesFromThread({ summary: thread, messages: page.messages }, this.host.journal()),
        ...(page.olderCursor ? { olderCursor: page.olderCursor } : {}),
        resumed: false,
      } satisfies CachedThreadActivities
      this.threadCache.put(entry)
      return entry
    }).finally(() => {
      if (this.threadPreviews.get(key) === load) this.threadPreviews.delete(key)
    })
    this.threadPreviews.set(key, load)
    return load
  }

  clear(): void {
    this.histories.clear()
    this.skills.clear()
    this.threadLoads.clear()
    this.threadPreviews.clear()
    this.threadCache.clear()
  }

  private request<Key, Value>(
    requests: Map<Key, SharedRequest<Value>>,
    key: Key,
    token: unknown,
    load: () => Promise<Value>,
  ): Promise<Value> {
    const current = requests.get(key)
    if (current?.pending) {
      if (token === undefined || current.token === token) return current.pending
      return current.pending.then(() => this.request(requests, key, token, load))
    }
    if (token !== undefined && current?.token === token && current.value !== undefined) {
      return Promise.resolve(current.value)
    }
    const pending = load().then((value) => {
      const live = requests.get(key)
      if (live?.pending === pending) requests.set(key, { token, value })
      return value
    }, (error: unknown) => {
      if (requests.get(key)?.pending === pending) requests.delete(key)
      throw error
    })
    requests.set(key, {
      token,
      ...(current?.value !== undefined ? { value: current.value } : {}),
      pending,
    })
    return pending
  }
}

export function readActiveThreadId(
  storage: SessionStorage | undefined = browserStorage(),
): string | undefined {
  try {
    const value = storage?.getItem(ACTIVE_THREAD_STORAGE_KEY)
    if (!value) return undefined
    const stored = JSON.parse(value) as unknown
    return isRecord(stored) && stored.version === 1 && typeof stored.threadId === 'string'
      ? stored.threadId
      : undefined
  } catch {
    return undefined
  }
}

export function writeActiveThreadId(
  threadId: string | undefined,
  storage: SessionStorage | undefined = browserStorage(),
): void {
  try {
    if (threadId) {
      storage?.setItem(ACTIVE_THREAD_STORAGE_KEY, JSON.stringify({ version: 1, threadId }))
    } else {
      storage?.removeItem(ACTIVE_THREAD_STORAGE_KEY)
    }
  } catch {
    // Navigation still works when storage is unavailable.
  }
}

export class SessionService implements ClientSessionService {
  private state: ClientSessionSnapshot
  private link: LinkState = initialLink
  private readonly listeners = new Set<() => void>()
  private readonly disposeHost: () => void
  private readonly disposeEvents: () => void
  private historyGeneration = 0
  private skillsGeneration = 0
  private threadOpenGeneration = 0
  private warmGeneration = 0
  private reconnectGeneration = 0
  private connectionEpoch: number
  private readonly resources: SessionResources
  private readonly ownsResources: boolean
  private pendingRestoreThreadId: string | undefined
  private activeOlderCursor?: string
  private activeThreadResumed = false
  private resourcesKey = ''
  private resourceTimer?: number
  private warmTimer?: number
  private optimisticUserSerial = 0
  private activeTurnId: string | undefined
  private threadCreation: Promise<string> | undefined
  private defaultsKey: string | undefined
  private modelSelectionChanged = false
  private effortSelectionChanged = false
  private permissionSelectionChanged = false
  private projectSelection: string | null | undefined
  private notificationFrame?: number
  private notificationFrameUsesTimeout = false
  private disposed = false

  constructor(
    private readonly host: ClientHostService,
    private readonly options: ClientSessionCreateOptions = {},
    resources?: SessionResources,
  ) {
    this.resources = resources ?? new SessionResources(host)
    this.ownsResources = resources === undefined
    const hostState = host.snapshot()
    this.connectionEpoch = hostState.connectionEpoch ?? 0
    const harness = withAstraModel(hostState.snapshot)
    const codexState = harness?.codex.status ?? 'starting'
    this.link = hostState.connected ? { tag: 'online' } : initialLink
    const session = sessionDefaults(harness, options.initialWorkspace)
    this.projectSelection = options.initialProjectId === undefined && !options.initialWorkspace
      ? null : options.initialProjectId
    this.pendingRestoreThreadId = options.restoreActiveThread === false
      ? undefined
      : readActiveThreadId()
    const configured = configuredDefaults(harness)
    this.defaultsKey = configured ? JSON.stringify(configured) : undefined
    this.state = {
      revision: 0,
      connected: hostState.connected,
      ...(hostState.problem ? { connectionError: hostState.problem } : {}),
      ...(harness ? { harness } : {}),
      session,
      turn: initialTurn,
      agentStatus: deriveAgentStatus(this.link, initialTurn, codexState),
      activities: [],
      hasEarlierActivities: false,
      loadingEarlierActivities: false,
      projectScope: this.projectSelection === null ? 'unscoped' : 'workspace',
      history: { tag: 'ready', entries: [] },
      threads: [],
      projects: harness?.projects.projects ?? [],
      skills: [],
    }
    this.disposeHost = host.subscribe(() => this.syncHost())
    this.disposeEvents = host.onEvent((event) => this.receive(event), true)
    this.syncHost()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientSessionSnapshot => this.state

  hasSurface(id: string): boolean {
    return this.state.harness?.ui.surfaces.some((surface) => surface.id === id) ?? false
  }

  async loadModels(): Promise<void> {
    await this.host.call(SESSION_CODEX_START, {})
  }

  setModel(model: string | undefined): void {
    const session = withModel(this.state.session, model)
    const selected = this.state.harness?.codex.models.find((candidate) => candidate.id === model)
      ?? this.state.harness?.codex.models.find((candidate) => candidate.isDefault)
    this.modelSelectionChanged = true
    this.effortSelectionChanged = true
    this.set({
      session: withEffort(session, selected?.defaultReasoningEffort),
    })
  }

  setEffort(effort: string | undefined): void {
    this.effortSelectionChanged = true
    this.set({ session: withEffort(this.state.session, effort) })
  }

  setPermissionMode(permissionMode: PermissionMode): void {
    this.permissionSelectionChanged = true
    this.set({ session: { ...this.state.session, permissionMode } })
  }

  async send(draft: ClientDraft): Promise<void> {
    const text = draft.text.trim()
    const attachments = draft.attachments
    if (
      (!text && !draft.images.length && !attachments.length)
      || this.state.turn.tag !== 'idle'
      || !this.state.connected
      || this.state.canAcceptDirectInput === false
    ) return
    if (!this.state.session.workspace) throw new Error('Choose a project or wait for the scratch workspace to become available')
    const selectionGeneration = this.threadOpenGeneration
    const submittedSession = { ...this.state.session }
    const submittedWithoutWorkspace = this.projectSelection === null
    const preview = text || attachments[0]?.name || draft.images[0]?.name || 'Attachment'
    let submittedThreadId = this.state.threadId
    this.transitionTurn('submit')
    this.appendUserActivity({ ...draft, text })
    try {
      if (!submittedThreadId) {
        const created = await this.host.command('thread.new', submittedSession)
        const thread = isRecord(created) && isRecord(created.thread) ? created.thread : undefined
        submittedThreadId = typeof thread?.id === 'string' ? thread.id : undefined
        if (!submittedThreadId) throw new Error('Codex did not create a thread')

        const stillSelected = selectionGeneration === this.threadOpenGeneration
          && this.state.threadId === undefined
        if (stillSelected) {
          this.activeThreadResumed = true
          this.addProvisionalThread(submittedThreadId, preview)
        }
        if (submittedWithoutWorkspace) {
          try {
            await this.host.call('workspace-layout.unassign-thread', { threadId: submittedThreadId })
          } catch (error) {
            console.error('Unable to keep the new chat out of workspace groups', error)
          }
        }
      }

      const response = await this.host.command('chat.send', {
        ...submittedSession,
        threadId: submittedThreadId,
        text,
        images: draft.images,
        attachments,
        skills: draft.skills,
      })
      const responseThreadId = isRecord(response) && typeof response.threadId === 'string'
        ? response.threadId
        : undefined
      const stillSelected = selectionGeneration === this.threadOpenGeneration
        && this.state.threadId === submittedThreadId
      if (stillSelected && responseThreadId) {
        this.activeThreadResumed = true
        this.set({ threadId: responseThreadId })
      }
      if (stillSelected) this.transitionTurn('accept')
    } catch (error) {
      const stillSelected = selectionGeneration === this.threadOpenGeneration
        && (submittedThreadId
          ? this.state.threadId === submittedThreadId
          : this.state.threadId === undefined)
      if (stillSelected) {
        this.transitionTurn('settle')
        this.set({
          activities: [...this.state.activities, {
            id: `send-error:${Date.now()}`,
            kind: 'status',
            title: 'Message failed',
            content: error instanceof Error ? error.message : String(error),
            status: 'failed',
            timestamp: now(),
          }],
        })
      }
      throw error
    }
  }

  async steer(draft: ClientDraft): Promise<void> {
    const threadId = this.state.threadId
    if (!threadId) throw new Error('there is no active thread to steer')
    this.appendUserActivity({ ...draft, text: draft.text.trim() }, true)
    await this.host.command('turn.steer', {
      threadId,
      text: draft.text,
      images: draft.images,
      attachments: draft.attachments,
      skills: draft.skills,
    })
  }

  private appendUserActivity(draft: ClientDraft, continuesTurn = false): void {
    this.set({
      activities: [...this.state.activities, {
        id: `user:local:${Date.now()}:${++this.optimisticUserSerial}`,
        ...(this.state.threadId ? { threadId: this.state.threadId } : {}),
        ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
        kind: 'user',
        title: 'You',
        content: draft.text,
        ...(continuesTurn ? { continuesTurn: true } : {}),
        images: draft.images,
        ...(draft.attachments.length ? { attachments: draft.attachments } : {}),
        timestamp: now(),
        createdAtMs: Date.now(),
      }],
    })
  }

  async interrupt(): Promise<void> {
    const threadId = this.state.threadId
    if (!threadId) return
    await this.host.command('turn.interrupt', { threadId })
  }

  ensureThread(workspace = this.state.session.workspace): Promise<string> {
    if (this.state.threadId) return Promise.resolve(this.state.threadId)
    if (this.threadCreation) return this.threadCreation
    const create = async (): Promise<string> => {
      if (this.state.turn.tag !== 'idle') throw new Error('the chat is already starting a turn')
      if (!this.state.connected) throw new Error('Alto is not connected to Codex')
      if (!workspace) throw new Error('Choose a project or wait for the scratch workspace to become available')
      const generation = this.threadOpenGeneration
      const session = { ...this.state.session, workspace }
      const response = await this.host.command('thread.new', session)
      const thread = isRecord(response) && isRecord(response.thread) ? response.thread : undefined
      const threadId = typeof thread?.id === 'string' ? thread.id : undefined
      if (!threadId) throw new Error('Codex did not create a thread')
      if (generation !== this.threadOpenGeneration || this.state.threadId) {
        throw new Error('the selected chat changed while its work target was being prepared')
      }
      this.clearThread(session)
      this.addProvisionalThread(threadId, '', 'New chat')
      this.scheduleResources()
      if (this.projectSelection === null) {
        try {
          await this.host.call('workspace-layout.unassign-thread', { threadId })
        } catch (error) {
          console.error('Unable to keep the new chat out of workspace groups', error)
        }
      }
      return threadId
    }
    this.threadCreation = create().finally(() => {
      this.threadCreation = undefined
    })
    return this.threadCreation
  }

  newThread(project?: LocalProject | null): void {
    const active = project ?? null
    this.projectSelection = active?.id ?? null
    const workspace = active?.primaryRoot ?? defaultWorkspace(this.state.harness)
    const session = { ...sessionDefaults(this.state.harness, workspace), permissionMode: this.state.session.permissionMode }
    this.modelSelectionChanged = false
    this.effortSelectionChanged = false
    this.clearThread(session)
    this.scheduleResources()
  }

  retargetNewThread(project: LocalProject): boolean {
    if (this.state.threadId || this.state.turn.tag !== 'idle') return false
    if (project.id === this.state.activeProjectId) return true
    this.projectSelection = project.id
    this.clearThread({ ...this.state.session, workspace: project.primaryRoot })
    this.scheduleResources()
    return true
  }

  async openThread(thread: ThreadSummary): Promise<void> {
    if (thread.id === this.state.threadId) return
    this.projectSelection = thread.projectId ?? null
    this.pendingRestoreThreadId = undefined
    const generation = ++this.threadOpenGeneration
    const workspace = thread.cwd || this.state.session.workspace
    const cached = this.resources.threadCache.get(thread.id)
    this.activateThread(cached ?? {
      summary: thread,
      activities: [],
      resumed: false,
    }, workspace)
    try {
      const loaded = await this.loadThread(thread)
      if (
        generation !== this.threadOpenGeneration
        || this.disposed
        || this.state.threadId !== thread.id
      ) return
      if (
        cached
        && sameActivities(this.state.activities, loaded.activities)
      ) {
        const resumed = {
          ...loaded,
          activities: this.state.activities,
          ...(loaded.olderCursor ?? cached.olderCursor
            ? { olderCursor: loaded.olderCursor ?? cached.olderCursor }
            : {}),
        }
        if (
          JSON.stringify(cached.summary) === JSON.stringify(loaded.summary)
          && JSON.stringify(cached.session) === JSON.stringify(loaded.session)
        ) {
          this.activeThreadResumed = true
          this.resources.threadCache.put(resumed)
        } else {
          this.activateThread(resumed, workspace)
        }
        return
      }
      this.activateThread(loaded, workspace)
    } catch (error) {
      if (generation !== this.threadOpenGeneration || this.disposed || cached) return
      this.set({
        history: {
          tag: 'failed',
          entries: historyEntries(this.state.history),
          problem: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    const title = name.trim()
    if (!threadId) throw new Error('a chat is required')
    if (!title) throw new Error('a chat name is required')
    await this.host.call(SESSION_THREAD_RENAME, { threadId, name: title })
    if (!this.disposed) this.applyThreadTitle(threadId, title)
  }

  async prefetchThread(thread: ThreadSummary): Promise<void> {
    const cached = this.resources.threadCache.get(thread.id)
    if (cached && cachedThreadIsFresh(cached, thread)) return
    if (thread.id === this.state.threadId) {
      this.resources.threadCache.put({
        summary: thread,
        activities: this.state.activities,
        ...(this.activeOlderCursor ? { olderCursor: this.activeOlderCursor } : {}),
        resumed: this.activeThreadResumed,
      })
      return
    }
    await this.previewThread(thread)
  }

  async loadEarlierActivities(): Promise<void> {
    const threadId = this.state.threadId
    const cursor = this.activeOlderCursor
    if (!threadId || !cursor || this.state.loadingEarlierActivities) return
    const generation = this.threadOpenGeneration
    this.set({ loadingEarlierActivities: true })
    try {
      const page = await this.host.command('thread.page', {
        threadId,
        cursor,
        limit: THREAD_PAGE_SIZE,
      })
      if (
        generation !== this.threadOpenGeneration
        || this.disposed
        || this.state.threadId !== threadId
      ) return
      const summary = this.resources.threadCache.get(threadId)?.summary
        ?? this.state.threads.find((thread) => thread.id === threadId)
        ?? historyEntries(this.state.history).find((thread) => thread.id === threadId)
      if (!summary) return
      const earlier = activitiesFromThread({ summary, messages: page.messages }, this.host.journal())
      const existing = new Set(this.state.activities.map((activity) => activity.id))
      if (page.olderCursor) this.activeOlderCursor = page.olderCursor
      else delete this.activeOlderCursor
      this.set({
        activities: [...earlier.filter((activity) => !existing.has(activity.id)), ...this.state.activities],
        hasEarlierActivities: Boolean(page.olderCursor),
        loadingEarlierActivities: false,
      })
    } catch (error) {
      console.error('Unable to load earlier chat activity', error)
    } finally {
      if (
        generation === this.threadOpenGeneration
        && !this.disposed
        && this.state.threadId === threadId
        && this.state.loadingEarlierActivities
      ) this.set({ loadingEarlierActivities: false })
    }
  }

  selectProject(project: LocalProject): void {
    if (this.state.turn.tag !== 'idle' || project.id === this.state.activeProjectId) return
    this.projectSelection = project.id
    this.clearThread({ ...this.state.session, workspace: project.primaryRoot })
    this.scheduleResources()
  }

  async saveProject(project: LocalProjectInput): Promise<void> {
    const projects = await this.host.command('project.save', project)
    this.setProjects(projects.projects)
  }

  async createWorkspace(project: LocalProjectInput): Promise<void> {
    if (this.state.turn.tag !== 'idle') {
      throw new Error('finish the current turn before changing workspaces')
    }
    const existing = new Set(this.state.projects.map((candidate) => candidate.id))
    const projects = await this.host.command('project.save', project)
    const created = projects.projects.find((candidate) => !existing.has(candidate.id))
    if (!created) throw new Error('the workspace was saved but could not be selected')
    this.setProjects(projects.projects)
    this.projectSelection = created.id
    this.clearThread({ ...this.state.session, workspace: created.primaryRoot })
    this.scheduleResources()
  }

  async removeProject(id: string): Promise<void> {
    const projects = await this.host.command('project.remove', { id })
    this.setProjects(projects.projects)
  }

  async refreshHistory(limit = 200, token?: unknown): Promise<void> {
    if (!this.state.connected || this.state.harness?.codex.status !== 'ready') return
    const generation = ++this.historyGeneration
    this.set({ history: { tag: 'loading', entries: historyEntries(this.state.history) } })
    try {
      const entries = await this.resources.listThreads(limit, token)
      if (generation !== this.historyGeneration || this.disposed) return
      this.set({ history: { tag: 'ready', entries }, threads: entries })
      await this.restoreActiveThread(entries)
      this.scheduleThreadWarming(entries)
    } catch (error) {
      if (generation !== this.historyGeneration || this.disposed) return
      this.set({
        history: {
          tag: 'failed',
          entries: historyEntries(this.state.history),
          problem: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  resolveRequest(id: string | number, result: unknown): Promise<void> {
    return this.host.command('serverRequest.resolve', { id, result }).then(() => undefined)
  }

  resolveProposal(id: string, decision: 'accept' | 'decline'): Promise<void> {
    return this.host.command('program.proposal.resolve', { id, decision }).then(() => undefined)
  }

  dispose(): void {
    this.disposed = true
    this.disposeHost()
    this.disposeEvents()
    if (this.resourceTimer !== undefined) window.clearTimeout(this.resourceTimer)
    if (this.warmTimer !== undefined) window.clearTimeout(this.warmTimer)
    this.cancelNotificationFrame()
    this.listeners.clear()
    if (this.ownsResources) this.resources.clear()
    this.historyGeneration += 1
    this.skillsGeneration += 1
    this.threadOpenGeneration += 1
    this.warmGeneration += 1
    this.reconnectGeneration += 1
  }

  private async loadThread(thread: ThreadSummary): Promise<CachedThreadActivities> {
    return this.resources.openThread(thread, this.state.session)
  }

  private async previewThread(thread: ThreadSummary): Promise<CachedThreadActivities> {
    return this.resources.previewThread(thread)
  }

  private scheduleThreadWarming(entries: ThreadSummary[]): void {
    const generation = ++this.warmGeneration
    if (this.warmTimer !== undefined) window.clearTimeout(this.warmTimer)
    const candidates = entries
      .filter((thread) => thread.id !== this.state.threadId)
      .slice(0, RECENT_THREAD_WARM_LIMIT)
    if (!candidates.length) return
    this.warmTimer = window.setTimeout(() => {
      void (async () => {
        for (const thread of candidates) {
          if (generation !== this.warmGeneration || this.disposed) return
          try {
            await this.prefetchThread(thread)
          } catch {
            // Warming is opportunistic; foreground navigation still loads on demand.
          }
        }
      })()
    }, 120)
  }

  private async restoreActiveThread(entries: ThreadSummary[]): Promise<void> {
    const threadId = this.pendingRestoreThreadId
    if (!threadId || this.state.threadId || this.state.turn.tag !== 'idle') return
    const thread = entries.find((candidate) => candidate.id === threadId)
    this.pendingRestoreThreadId = undefined
    if (!thread) {
      writeActiveThreadId(undefined)
      return
    }
    await this.openThread(thread)
  }

  private activateThread(entry: CachedThreadActivities, workspace: string): void {
    this.projectSelection = entry.summary.projectId ?? null
    if (entry.olderCursor) this.activeOlderCursor = entry.olderCursor
    else delete this.activeOlderCursor
    this.activeThreadResumed = entry.resumed
    const runtime = this.state.harness?.codex.threadStates?.[entry.summary.id]
    const turn: TurnState = runtime?.status.type === 'active'
      ? { tag: 'running' }
      : initialTurn
    const sameThread = this.state.threadId === entry.summary.id
    if (!sameThread) {
      this.modelSelectionChanged = false
      this.effortSelectionChanged = false
    }
    const activities = sameThread
      ? reconcileTranscriptSnapshot(this.state.activities, entry.activities, turn.tag === 'running')
      : entry.activities
    const effectiveSession = this.state.harness?.codex.threadSettings?.[entry.summary.id]
      ?? entry.session
    let session = {
      ...this.state.session,
      ...effectiveSession,
      workspace: effectiveSession?.workspace || entry.summary.cwd || workspace,
    }
    if (sameThread && this.modelSelectionChanged) {
      session = withModel(session, this.state.session.model)
    }
    if (sameThread && this.effortSelectionChanged) {
      session = withEffort(session, this.state.session.effort)
    }
    this.activeTurnId = undefined
    this.set({
      session,
      threadId: entry.summary.id,
      canAcceptDirectInput: effectiveSession?.canAcceptDirectInput
        ?? runtime?.canAcceptDirectInput
        ?? entry.summary.canAcceptDirectInput,
      activeProjectId: entry.summary.projectId,
      projectScope: entry.summary.projectId ? 'workspace' : 'unscoped',
      activities,
      hasEarlierActivities: Boolean(entry.olderCursor),
      loadingEarlierActivities: false,
      history: {
        tag: 'ready',
        entries: updateThread(historyEntries(this.state.history), entry.summary),
      },
      threads: updateThread(this.state.threads, entry.summary),
      turn,
      agentStatus: deriveAgentStatus(
        this.link,
        turn,
        this.state.harness?.codex.status ?? 'starting',
      ),
    })
    this.resources.threadCache.put(entry)
    this.scheduleResources()
  }

  private syncHost(): void {
    const hostState = this.host.snapshot()
    const harness = withAstraModel(hostState.snapshot)
    const connectionEpoch = hostState.connectionEpoch ?? 0
    const reconnected = this.connectionEpoch > 0 && connectionEpoch > this.connectionEpoch
    this.connectionEpoch = connectionEpoch
    if (hostState.connected && this.link.tag !== 'online') this.link = stepLink(this.link, { tag: 'opened' })
    if (!hostState.connected && this.link.tag === 'online') this.link = stepLink(this.link, { tag: 'closed' })

    let session = this.state.session
    if (harness) {
      const workspace = session.workspace || defaultWorkspace(harness)
      const configured = configuredDefaults(harness)
      const defaultsKey = configured ? JSON.stringify(configured) : undefined
      if (defaultsKey !== this.defaultsKey && configured && !this.state.threadId) {
        const previous = session
        session = sessionDefaults(harness, workspace)
        if (this.modelSelectionChanged) session = withModel(session, previous.model)
        if (this.effortSelectionChanged) session = withEffort(session, previous.effort)
        if (this.permissionSelectionChanged || this.state.turn.tag !== 'idle') {
          session.permissionMode = previous.permissionMode
        }
        this.defaultsKey = defaultsKey
      } else {
        const model = session.model
          ?? harness.codex.models.find((candidate) => candidate.isDefault)?.id
        session = withModel({ ...session, workspace }, model)
      }
      const selected = harness.codex.models.find((candidate) => candidate.id === session.model)
        ?? harness.codex.models.find((candidate) => candidate.isDefault)
      const efforts = selected?.supportedReasoningEfforts ?? []
      if (!session.effort || (
        efforts.length
        && !efforts.some((effort) => effort.reasoningEffort === session.effort)
      )) {
        session = withEffort(session, selected?.defaultReasoningEffort)
      }
    }

    const activeThreadId = this.state.threadId
    const effectiveSession = activeThreadId
      ? harness?.codex.threadSettings?.[activeThreadId]
      : undefined
    if (effectiveSession) {
      const selectedModel = session.model
      const selectedEffort = session.effort
      session = { ...session, ...effectiveSession }
      if (this.modelSelectionChanged) session = withModel(session, selectedModel)
      if (this.effortSelectionChanged) session = withEffort(session, selectedEffort)
    }

    const projects = harness?.projects.projects ?? this.state.projects
    const activeProjectId = this.activeProjectId(projects, session.workspace, this.state.threadId)
    const turn = this.state.turn
    const codex = harness?.codex.status ?? 'starting'
    this.set({
      connected: hostState.connected,
      ...(hostState.problem ? { connectionError: hostState.problem } : { connectionError: undefined }),
      ...(harness ? { harness } : {}),
      session,
      canAcceptDirectInput: activeThreadId
        ? effectiveSession?.canAcceptDirectInput
          ?? harness?.codex.threadStates?.[activeThreadId]?.canAcceptDirectInput
          ?? this.state.canAcceptDirectInput
        : undefined,
      projects,
      ...(activeProjectId ? { activeProjectId } : { activeProjectId: undefined }),
      agentStatus: deriveAgentStatus(this.link, turn, codex),
    })
    this.scheduleResources()
    if (reconnected && harness) void this.reconcileAfterReconnect(harness)
  }

  private receive(event: HarnessEvent): void {
    switch (event.type) {
      case 'codex.notification': {
        const threadId = notificationThreadId(event)
        const selectedThread = !threadId || threadId === this.state.threadId
        const activity = selectedThread ? activityFrom(event.payload) : undefined
        if (activity) {
          this.set(
            { activities: mergeActivity(this.state.activities, activity) },
            FRAME_COALESCED_ACTIVITY_METHODS.has(event.payload.method) ? 'frame' : 'immediate',
          )
        }
        if (selectedThread && event.payload.method === 'turn/started') {
          const scope = activityScope(event.payload.params)
          this.activeTurnId = scope.turnId
          const activities = bindPendingTurn(this.state.activities, scope)
          if (activities !== this.state.activities) this.set({ activities })
          this.setTurn({ tag: 'running' })
        }
        // Auto-started queued turns can arrive without this pane submitting a
        // draft. Their user items also appear in turn snapshots during replay.
        if (selectedThread && (event.payload.method === 'turn/started' || event.payload.method === 'turn/completed')) {
          const turn = recordAt(event.payload.params, 'turn')
          for (const item of Array.isArray(turn?.items) ? turn.items : []) {
            if (!isRecord(item) || item.type !== 'userMessage') continue
            const activity = activityFrom({ method: 'item/completed', params: {
              ...event.payload.params, item, turnId: turn?.id,
            } })
            if (activity) this.set({ activities: mergeActivity(this.state.activities, activity) })
          }
        }
        if (event.payload.method === 'turn/completed') {
          const turn = recordAt(event.payload.params, 'turn')
          const scope = activityScope(event.payload.params)
          const startedAt = typeof turn?.startedAt === 'number' ? turn.startedAt : 0
          const completedAt = typeof turn?.completedAt === 'number' ? turn.completedAt : 0
          const durationMs = typeof turn?.durationMs === 'number' && turn.durationMs > 0
            ? turn.durationMs
            : completedAt > startedAt
              ? (completedAt - startedAt) * 1_000
              : 0
          if (selectedThread) {
            const turnStatus = stringValue(turn?.status) ?? 'completed'
            let activities = settleTranscriptTurn(
              this.state.activities,
              scope.turnId ?? this.activeTurnId,
              turnStatus,
            )
            if (durationMs && !/interrupt|cancel|fail/u.test(turnStatus)) {
              activities = completeLatestTurn(activities, durationMs)
            }
            if (activities !== this.state.activities) this.set({ activities })
            this.activeTurnId = undefined
          }
          if (selectedThread) this.setTurn(initialTurn)
          void this.refreshHistory(200, event)
        }
        if (event.payload.method === 'thread/name/updated') {
          const threadId = stringValue(event.payload.params?.threadId)
          const threadName = stringValue(event.payload.params?.threadName)?.trim()
          if (threadId && threadName) {
            const known = this.state.threads.some((thread) => thread.id === threadId)
              || historyEntries(this.state.history).some((thread) => thread.id === threadId)
            if (!known && threadId === this.state.threadId) {
              const preview = this.state.activities.findLast((activity) => activity.kind === 'user')
                ?.content ?? ''
              this.addProvisionalThread(threadId, preview, threadName)
            } else {
              this.applyThreadTitle(threadId, threadName)
            }
          } else {
            void this.refreshHistory(200, event)
          }
        }
        if (
          event.payload.method === 'thread/project/updated'
          || event.payload.method === 'project/changed'
        ) void this.refreshHistory(200, event)
        if (event.payload.method === 'skills/changed') void this.refreshSkills(event)
        break
      }
      case 'program.error':
        this.set({
          activities: mergeActivity(this.state.activities, {
            id: `program-error:${Date.now()}`,
            kind: 'status',
            title: 'Program reload failed',
            content: event.payload.message,
            status: 'failed',
            timestamp: now(),
          }),
        })
        break
      case 'projects.updated':
        this.setProjects(event.payload.projects)
        void this.refreshHistory(200, event)
        break
      case 'snapshot':
      case 'codex.status':
      case 'codex.serverRequest':
      case 'codex.serverRequest.resolved':
      case 'codex.stderr':
      case 'program.updated':
      case 'ui.updated':
      case 'extensions.updated':
      case 'command.result':
        break
    }
  }

  private async refreshSkills(token?: unknown): Promise<void> {
    const workspace = this.state.session.workspace
    if (!workspace || !this.state.connected || this.state.harness?.codex.status !== 'ready') return
    const generation = ++this.skillsGeneration
    try {
      const skills = await this.resources.listSkills(workspace, token)
      if (generation === this.skillsGeneration && !this.disposed) this.set({ skills })
    } catch {
      if (generation === this.skillsGeneration && !this.disposed) this.set({ skills: [] })
    }
  }

  private async reconcileAfterReconnect(harness: ClientSessionSnapshot['harness']): Promise<void> {
    const generation = ++this.reconnectGeneration
    const threadId = this.state.threadId
    void this.refreshHistory(200, `reconnect:${this.connectionEpoch}`)
    if (!threadId || !harness) {
      if (this.state.turn.tag !== 'idle') this.setTurn(initialTurn)
      return
    }
    if (harness.codex.activeThreadIds.includes(threadId)) {
      this.setTurn({ tag: 'running' })
      return
    }

    this.setTurn(initialTurn)
    try {
      const view = await this.host.command('thread.open', {
        ...this.state.session,
        threadId,
      })
      if (
        generation !== this.reconnectGeneration
        || this.disposed
        || this.state.threadId !== threadId
      ) return
      this.activateThread({
        summary: view.summary,
        activities: activitiesFromThread(view, this.host.journal()),
        ...(view.olderCursor ? { olderCursor: view.olderCursor } : {}),
        resumed: true,
      }, this.state.session.workspace)
    } catch (error) {
      if (generation === this.reconnectGeneration && !this.disposed) {
        console.error('Unable to reconcile the active chat after reconnecting', error)
      }
    }
  }

  private scheduleResources(): void {
    const key = `${this.state.connected}:${this.state.harness?.codex.status}:${this.state.session.workspace}`
    if (key === this.resourcesKey) return
    this.resourcesKey = key
    if (this.resourceTimer !== undefined) window.clearTimeout(this.resourceTimer)
    if (!this.state.connected || this.state.harness?.codex.status !== 'ready' || !this.state.session.workspace) return
    this.resourceTimer = window.setTimeout(() => {
      void this.refreshHistory(200, `resources:${this.connectionEpoch}`)
      void this.refreshSkills(`resources:${this.connectionEpoch}:${this.state.session.workspace}`)
    }, 80)
  }

  private transitionTurn(event: 'submit' | 'accept' | 'settle'): void {
    this.setTurn(stepTurn(this.state.turn, event))
  }

  private addProvisionalThread(
    threadId: string,
    preview: string,
    title?: string,
  ): void {
    const timestamp = Math.floor(Date.now() / 1_000)
    const existing = this.state.threads.find((thread) => thread.id === threadId)
      ?? historyEntries(this.state.history).find((thread) => thread.id === threadId)
    const summary: ThreadSummary = {
      id: threadId,
      title: title ?? existing?.title ?? 'New chat',
      preview,
      cwd: this.state.session.workspace,
      createdAt: timestamp,
      updatedAt: timestamp,
      recencyAt: timestamp,
      ...(this.state.activeProjectId ? { projectId: this.state.activeProjectId } : {}),
    }
    this.set({
      threadId,
      history: {
        ...this.state.history,
        entries: upsertThread(historyEntries(this.state.history), summary),
      },
      threads: upsertThread(this.state.threads, summary),
    })
  }

  private setTurn(turn: TurnState): void {
    this.set({
      turn,
      agentStatus: deriveAgentStatus(
        this.link,
        turn,
        this.state.harness?.codex.status ?? 'starting',
      ),
    })
  }

  private clearThread(session: SessionOptions): void {
    this.historyGeneration += 1
    this.threadOpenGeneration += 1
    this.warmGeneration += 1
    this.reconnectGeneration += 1
    delete this.activeOlderCursor
    this.activeThreadResumed = false
    this.activeTurnId = undefined
    this.set({
      session,
      turn: initialTurn,
      threadId: undefined,
      canAcceptDirectInput: undefined,
      activities: [],
      hasEarlierActivities: false,
      loadingEarlierActivities: false,
      projectScope: this.projectSelection === null ? 'unscoped' : 'workspace',
      activeProjectId: this.activeProjectId(this.state.projects, session.workspace, undefined),
    })
  }

  private setProjects(projects: LocalProject[]): void {
    this.set({
      projects,
      activeProjectId: this.activeProjectId(projects, this.state.session.workspace, this.state.threadId),
    })
  }

  private activeProjectId(
    projects: LocalProject[],
    workspace: string,
    threadId: string | undefined,
  ): string | undefined {
    const thread = historyEntries(this.state.history).find((candidate) => candidate.id === threadId)
    if (thread?.projectId && projects.some((project) => project.id === thread.projectId)) {
      return thread.projectId
    }
    if (thread && !thread.projectId) return undefined
    if (this.projectSelection === null) return undefined
    if (
      this.projectSelection
      && projects.some((project) => project.id === this.projectSelection)
    ) return this.projectSelection
    return projectForWorkspace(projects, workspace)?.id
  }

  private applyThreadTitle(threadId: string, title: string): void {
    const cached = this.resources.threadCache.get(threadId)
    if (cached && cached.summary.title !== title) {
      this.resources.threadCache.put({
        ...cached,
        summary: { ...cached.summary, title },
      })
    }
    const entries = historyEntries(this.state.history)
    const history = withThreadTitle(entries, threadId, title)
    const threads = withThreadTitle(this.state.threads, threadId, title)
    if (history === entries && threads === this.state.threads) return
    this.set({
      history: { ...this.state.history, entries: history },
      threads,
    })
  }

  private set(
    change: Partial<ClientSessionSnapshot>,
    notification: 'immediate' | 'frame' = 'immediate',
  ): void {
    if ('threadId' in change) {
      this.pendingRestoreThreadId = undefined
      if (
        this.options.persistActiveThread !== false
        && (change.threadId !== this.state.threadId || change.threadId === undefined)
      ) {
        writeActiveThreadId(change.threadId)
      }
    }
    const next = { ...this.state, ...change, revision: this.state.revision + 1 }
    if (change.connectionError === undefined && 'connectionError' in change) delete next.connectionError
    if (change.harness === undefined && 'harness' in change) delete next.harness
    if (change.threadId === undefined && 'threadId' in change) delete next.threadId
    if (change.activeProjectId === undefined && 'activeProjectId' in change) delete next.activeProjectId
    this.state = next
    if ('activities' in change || 'threads' in change) this.rememberActiveThread()
    if (notification === 'frame') this.scheduleNotificationFrame()
    else {
      this.cancelNotificationFrame()
      this.emit()
    }
  }

  private scheduleNotificationFrame(): void {
    if (this.notificationFrame !== undefined || this.disposed) return
    if (typeof window.requestAnimationFrame === 'function') {
      this.notificationFrameUsesTimeout = false
      this.notificationFrame = window.requestAnimationFrame(() => {
        delete this.notificationFrame
        if (!this.disposed) this.emit()
      })
      return
    }
    this.notificationFrameUsesTimeout = true
    this.notificationFrame = window.setTimeout(() => {
      delete this.notificationFrame
      if (!this.disposed) this.emit()
    }, 16)
  }

  private cancelNotificationFrame(): void {
    const frame = this.notificationFrame
    if (frame === undefined) return
    if (this.notificationFrameUsesTimeout) window.clearTimeout(frame)
    else window.cancelAnimationFrame(frame)
    delete this.notificationFrame
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private rememberActiveThread(): void {
    const threadId = this.state.threadId
    if (!threadId) return
    const summary = this.state.threads.find((thread) => thread.id === threadId)
      ?? historyEntries(this.state.history).find((thread) => thread.id === threadId)
    if (!summary) return
    this.resources.threadCache.put({
      summary,
      activities: this.state.activities,
      ...(this.activeOlderCursor ? { olderCursor: this.activeOlderCursor } : {}),
      resumed: this.activeThreadResumed,
    })
  }
}

class SessionFactory implements ClientSessionFactoryService {
  constructor(
    private readonly host: ClientHostService,
    private readonly resources: SessionResources,
  ) {}

  create(options: ClientSessionCreateOptions = {}): ClientSessionHandle {
    const restored = options.restoreActiveThread ? readActiveThreadId() : undefined
    const native = new SessionService(this.host, {
      restoreActiveThread: false,
      persistActiveThread: false,
      ...options,
      ...(restored && isAgentChatId(restored) ? { restoreActiveThread: false } : {}),
    }, this.resources)
    const session = new AgentSessionService(native, this.host, {
      ...(restored && isAgentChatId(restored) ? { restoreThreadId: restored } : {}),
      ...(options.persistActiveThread ? { persist: writeActiveThreadId } : {}),
    })
    return {
      session,
      dispose: () => { session.dispose(); native.dispose() },
    }
  }
}

export class RoutedSessionService implements ClientSessionService, ClientSessionRouterService {
  private readonly listeners = new Set<() => void>()
  private readonly disposeBase: () => void
  private active: {
    key: string
    session: ClientSessionService
    dispose: () => void
  } | undefined

  constructor(private readonly base: ClientSessionService) {
    this.disposeBase = base.subscribe(() => {
      if (!this.active) this.emit()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientSessionSnapshot => this.activeSession().snapshot()

  activeKey(): string | undefined {
    return this.active?.key
  }

  activeSession(): ClientSessionService {
    return this.active?.session ?? this.base
  }

  globalSession(): ClientSessionService {
    return this.base
  }

  setActive(key: string, session: ClientSessionService): void {
    if (this.active?.key === key && this.active.session === session) return
    this.active?.dispose()
    this.active = {
      key,
      session,
      dispose: session.subscribe(() => this.emit()),
    }
    this.emit()
  }

  clearActive(key?: string): void {
    if (!this.active || (key !== undefined && this.active.key !== key)) return
    this.active.dispose()
    this.active = undefined
    this.emit()
  }

  hasSurface(id: string): boolean { return this.activeSession().hasSurface(id) }
  async loadModels(): Promise<void> { await this.activeSession().loadModels?.() }
  setAgentConfig(id: string, value: string): void { this.activeSession().setAgentConfig?.(id, value) }
  setProvider(id: string): void { this.activeSession().setProvider?.(id) }
  setModel(model: string | undefined): void { this.activeSession().setModel(model) }
  setEffort(effort: string | undefined): void { this.activeSession().setEffort(effort) }
  setPermissionMode(mode: PermissionMode): void { this.activeSession().setPermissionMode(mode) }
  send(draft: ClientDraft): Promise<void> { return this.activeSession().send(draft) }
  steer(draft: ClientDraft): Promise<void> { return this.activeSession().steer(draft) }
  interrupt(): Promise<void> { return this.activeSession().interrupt() }
  ensureThread(workspace?: string): Promise<string> { return this.activeSession().ensureThread(workspace) }
  newThread(project?: LocalProject | null): void { this.activeSession().newThread(project) }
  retargetNewThread(project: LocalProject): boolean { return this.activeSession().retargetNewThread(project) }
  openThread(thread: ThreadSummary): Promise<void> { return this.activeSession().openThread(thread) }
  renameThread(threadId: string, name: string): Promise<void> {
    return this.activeSession().renameThread(threadId, name)
  }
  prefetchThread(thread: ThreadSummary): Promise<void> { return this.activeSession().prefetchThread(thread) }
  loadEarlierActivities(): Promise<void> { return this.activeSession().loadEarlierActivities() }
  selectProject(project: LocalProject): void { this.activeSession().selectProject(project) }
  saveProject(project: LocalProjectInput): Promise<void> { return this.activeSession().saveProject(project) }
  createWorkspace(project: LocalProjectInput): Promise<void> { return this.activeSession().createWorkspace(project) }
  removeProject(id: string): Promise<void> { return this.activeSession().removeProject(id) }
  refreshHistory(limit?: number): Promise<void> { return this.activeSession().refreshHistory(limit) }
  resolveRequest(id: string | number, result: unknown): Promise<void> {
    return this.activeSession().resolveRequest(id, result)
  }
  resolveProposal(id: string, decision: 'accept' | 'decline'): Promise<void> {
    return this.activeSession().resolveProposal(id, decision)
  }

  dispose(): void {
    this.active?.dispose()
    this.active = undefined
    this.disposeBase()
    this.listeners.clear()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

const sessionPlugin: BrowserPlugin = (ctx) => {
  const resources = new SessionResources(ctx.clientHost)
  const restored = readActiveThreadId()
  const native = new SessionService(ctx.clientHost, {
    ...(restored && isAgentChatId(restored) ? { restoreActiveThread: false } : {}),
  }, resources)
  const base = new AgentSessionService(native, ctx.clientHost, {
    ...(restored && isAgentChatId(restored) ? { restoreThreadId: restored } : {}),
    persist: writeActiveThreadId,
  })
  const service = new RoutedSessionService(base)
  const factory = new SessionFactory(ctx.clientHost, resources)
  ctx.provide('clientConversation', service)
  ctx.provide('clientProjects', service)
  ctx.provide('clientApprovals', service)
  ctx.provide('clientPreferences', service)
  ctx.provide('clientSession', service)
  ctx.provide('clientSessionFactory', factory)
  ctx.provide('clientSessionRouter', service)
  return () => {
    service.dispose()
    base.dispose()
    native.dispose()
    resources.clear()
  }
}

sessionPlugin.inject = ['clientHost']
sessionPlugin.provide = [
  'clientConversation',
  'clientProjects',
  'clientApprovals',
  'clientPreferences',
  'clientSession',
  'clientSessionFactory',
  'clientSessionRouter',
]
sessionPlugin.resources = {
  requires: { extensions: ['session.defaults'] },
}

export default sessionPlugin
