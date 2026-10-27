import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import type { Context, Plugin } from 'cordis'
import type {
  CodexSessionDefaults,
  LocalProject,
  ModelOption,
  PendingServerRequest,
  PermissionMode,
  RpcId,
  RpcNotification,
  RpcRequest,
  SessionOptions,
  SkillOption,
  ThreadSummary,
  ThreadHistoryPage,
  ThreadRuntimeState,
  ThreadSessionSettings,
  ThreadView,
  TurnInput,
} from '../../shared/protocol.js'
import { errorMessage, isRecord } from '../../shared/protocol.js'
import {
  AppServerClient,
  type AppServerClientOptions,
  type AppServerStatusEvent,
} from '../app-server-client.js'
import type { DynamicToolCall, TurnDraft } from '../plugin-api.js'
import {
  readThreadMessages,
  readThreadRuntimeStatus,
  readThreadSummary,
  readThreadView,
} from './thread-view.js'

export const INITIAL_THREAD_TURN_LIMIT = 24

const execFileAsync = promisify(execFile)

interface ModelListResponse {
  data?: unknown[]
}

interface ConfigReadResponse {
  config?: unknown
}

interface ProjectListResponse {
  data?: unknown[]
  nextCursor?: string | null
}

interface ThreadStartResponse {
  thread?: { id?: string; [key: string]: unknown }
  [key: string]: unknown
}

interface ThreadListResponse {
  data?: unknown[]
  nextCursor?: string | null
}

interface ThreadReadResponse {
  thread?: unknown
}

interface ThreadResumeResponse {
  thread?: unknown
  initialTurnsPage?: unknown
  model?: unknown
  modelProvider?: unknown
  cwd?: unknown
  approvalPolicy?: unknown
  approvalsReviewer?: unknown
  sandbox?: unknown
  activePermissionProfile?: unknown
  reasoningEffort?: unknown
}

interface ThreadTurnsListResponse {
  data?: unknown[]
  nextCursor?: string | null
}

interface TurnStartResponse {
  turn?: { id?: string; [key: string]: unknown }
  [key: string]: unknown
}

interface TurnSteerResponse {
  turnId?: string
}

interface ThreadQueueListResponse {
  data?: unknown[]
  nextCursor?: string | null
}

interface ThreadQueueAddResponse {
  queuedSubmission?: unknown
}

interface ThreadQueueUpdateResponse {
  queuedSubmission?: unknown
}

interface ThreadQueueStartResponse {
  turn?: { id?: string; [key: string]: unknown }
}

interface SkillsListResponse {
  data?: unknown[]
}

export interface CodexSnapshot {
  status: AppServerStatusEvent['status']
  version?: string
  error?: string
  models: ModelOption[]
  activeThreadIds: string[]
  threadStates: Record<string, ThreadRuntimeState>
  threadSettings: Record<string, ThreadSessionSettings>
  defaults?: CodexSessionDefaults
}

export interface CodexServiceOptions extends AppServerClientOptions {
  projectRoot: string
}

export interface CodexTextGenerationRequest {
  workspace: string
  model: string
  effort: string
  instructions: string
  prompt: string
  serviceName?: string
  timeoutMs?: number
  additionalContext?: Record<
    string,
    { kind: 'application' | 'untrusted'; value: string }
  >
}

interface ActiveTurn {
  turnId: string
  permissionMode: PermissionMode
}

export interface PermissionSettings {
  sandbox: 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'on-request' | 'never'
  approvalsReviewer: 'user' | 'auto_review'
  sandboxPolicy:
    | { type: 'dangerFullAccess' }
    | {
        type: 'workspaceWrite'
        writableRoots: string[]
        networkAccess: boolean
        excludeTmpdirEnvVar: boolean
        excludeSlashTmp: boolean
      }
}

function chronologicalTurns(turns: unknown[]): unknown[] {
  return turns.toReversed()
}

function olderCursor(page: unknown): string | undefined {
  return isRecord(page) && typeof page.nextCursor === 'string'
    ? page.nextCursor
    : undefined
}

function openedThreadSummary(
  resumed: ThreadSummary,
  metadata: ThreadSummary | undefined,
  known: ThreadSummary | undefined,
): ThreadSummary {
  const status = resumed.status ?? metadata?.status ?? known?.status
  const canAcceptDirectInput = resumed.canAcceptDirectInput
    ?? metadata?.canAcceptDirectInput
    ?? known?.canAcceptDirectInput
  return {
    ...known,
    ...resumed,
    ...metadata,
    createdAt: metadata?.createdAt || resumed.createdAt || known?.createdAt || 0,
    updatedAt: Math.max(
      known?.updatedAt ?? 0,
      resumed.updatedAt,
      metadata?.updatedAt ?? 0,
    ),
    recencyAt: Math.max(
      known?.recencyAt ?? known?.updatedAt ?? 0,
      resumed.recencyAt ?? resumed.updatedAt,
      metadata?.recencyAt ?? metadata?.updatedAt ?? 0,
    ),
    ...(status ? { status } : {}),
    ...(typeof canAcceptDirectInput === 'boolean' ? { canAcceptDirectInput } : {}),
  }
}

export function permissionSettings(
  mode: PermissionMode,
  workspace: string,
): PermissionSettings {
  if (mode === 'full') {
    return {
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }
  }

  return {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: workspace ? [workspace] : [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  }
}

function permissionModeFrom(
  approvalPolicy: unknown,
  approvalsReviewer: unknown,
  sandboxPolicy: unknown,
): PermissionMode {
  const sandboxType = isRecord(sandboxPolicy) ? sandboxPolicy.type : sandboxPolicy
  if (approvalPolicy === 'never' && (
    sandboxType === 'dangerFullAccess'
    || sandboxType === 'danger-full-access'
  )) return 'full'
  return approvalsReviewer === 'auto_review' ? 'auto' : 'ask'
}

function threadSessionSettings(
  value: Record<string, unknown>,
  fallback?: ThreadSummary,
): ThreadSessionSettings | undefined {
  const workspace = typeof value.cwd === 'string' && value.cwd.trim()
    ? value.cwd
    : fallback?.cwd
  if (!workspace) return undefined
  const sandbox = value.sandboxPolicy ?? value.sandbox
  return {
    workspace,
    permissionMode: permissionModeFrom(
      value.approvalPolicy,
      value.approvalsReviewer,
      sandbox,
    ),
    ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
    ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort
      ? { effort: value.reasoningEffort }
      : typeof value.effort === 'string' && value.effort
        ? { effort: value.effort }
        : {}),
    ...(typeof value.modelProvider === 'string' && value.modelProvider
      ? { modelProvider: value.modelProvider }
      : fallback?.modelProvider
        ? { modelProvider: fallback.modelProvider }
        : {}),
    ...(typeof fallback?.canAcceptDirectInput === 'boolean'
      ? { canAcceptDirectInput: fallback.canAcceptDirectInput }
      : {}),
  }
}

function modelOption(value: unknown): ModelOption | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined
  const efforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts.flatMap((effort) => {
      if (!isRecord(effort) || typeof effort.reasoningEffort !== 'string') return []
      return [{
        reasoningEffort: effort.reasoningEffort,
        ...(typeof effort.description === 'string'
          ? { description: effort.description }
          : {}),
      }]
    })
    : undefined

  return {
    id: value.id,
    displayName: typeof value.displayName === 'string'
      ? value.displayName
      : value.id,
    ...(typeof value.isDefault === 'boolean' ? { isDefault: value.isDefault } : {}),
    ...(typeof value.defaultReasoningEffort === 'string'
      ? { defaultReasoningEffort: value.defaultReasoningEffort }
      : {}),
    ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
  }
}

function appServerProject(value: unknown): LocalProject | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    return undefined
  }
  const roots = Array.isArray(value.roots)
    ? value.roots.flatMap((root) => (
        isRecord(root) && typeof root.path === 'string' && root.path
          ? [root.path]
          : []
      ))
    : []
  const primaryRoot = roots[0]
  if (!primaryRoot) return undefined
  return {
    id: value.id,
    name: value.name,
    primaryRoot,
    roots,
  }
}

export function codexSessionDefaults(
  value: unknown,
  models: ModelOption[],
): CodexSessionDefaults {
  const config = isRecord(value) ? value : {}
  const configuredModel = typeof config.model === 'string' ? config.model : undefined
  const model = configuredModel
    ?? models.find((candidate) => candidate.isDefault)?.id
  const selected = models.find((candidate) => candidate.id === model)
    ?? models.find((candidate) => candidate.isDefault)
  const configuredEffort = typeof config.model_reasoning_effort === 'string'
    ? config.model_reasoning_effort
    : undefined
  const effort = configuredEffort ?? selected?.defaultReasoningEffort
  const fullAccess = config.default_permissions === ':danger-full-access'
    || config.sandbox_mode === 'danger-full-access'
  const permissionMode: PermissionMode = fullAccess
    ? 'full'
    : config.approvals_reviewer === 'auto_review'
      ? 'auto'
      : 'ask'

  return {
    permissionMode,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}

function skillOption(value: unknown): SkillOption | undefined {
  if (
    !isRecord(value)
    || typeof value.name !== 'string'
    || typeof value.description !== 'string'
    || typeof value.path !== 'string'
    || !['user', 'repo', 'system', 'admin'].includes(String(value.scope))
    || value.enabled === false
  ) return undefined

  const interfaceValue = isRecord(value.interface) ? value.interface : undefined
  return {
    name: value.name,
    description: value.description,
    path: value.path,
    scope: value.scope as SkillOption['scope'],
    ...(typeof interfaceValue?.displayName === 'string'
      ? { displayName: interfaceValue.displayName }
      : {}),
    ...(typeof interfaceValue?.shortDescription === 'string'
      ? { shortDescription: interfaceValue.shortDescription }
      : typeof value.shortDescription === 'string'
        ? { shortDescription: value.shortDescription }
        : {}),
  }
}

function toolCall(request: RpcRequest): DynamicToolCall | undefined {
  const params = request.params
  if (
    !params
    || typeof params.callId !== 'string'
    || typeof params.threadId !== 'string'
    || typeof params.turnId !== 'string'
    || typeof params.tool !== 'string'
  ) return undefined

  return {
    callId: params.callId,
    threadId: params.threadId,
    turnId: params.turnId,
    tool: params.tool,
    ...(typeof params.namespace === 'string' || params.namespace === null
      ? { namespace: params.namespace }
      : {}),
    arguments: params.arguments,
  }
}

export class CodexService extends EventEmitter {
  private readonly client: AppServerClient
  private startup: Promise<void> | undefined
  private generation = 0
  private readonly pending = new Map<RpcId, PendingServerRequest>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly threadSummaries = new Map<string, ThreadSummary>()
  private readonly threadStates = new Map<string, ThreadRuntimeState>()
  private readonly threadSettings = new Map<string, ThreadSessionSettings>()
  private readonly ephemeralThreadIds = new Set<string>()
  private projectSync: Promise<void> | undefined
  private state: CodexSnapshot = {
    status: 'stopped',
    models: [],
    activeThreadIds: [],
    threadStates: {},
    threadSettings: {},
  }

  constructor(
    private readonly ctx: Context,
    private readonly options: CodexServiceOptions,
  ) {
    super()
    this.client = new AppServerClient({
      ...(options.command ? { command: options.command } : {}),
      ...(options.args ? { args: options.args } : {}),
      cwd: options.cwd ?? options.projectRoot,
      ...(options.createProcess ? { createProcess: options.createProcess } : {}),
    })
    this.attachClient()
  }

  private attachClient(): void {
    this.client.on('status', (event: AppServerStatusEvent) => {
      // The transport handshake finishes before models, defaults, and projects
      // are loaded. Publish readiness only after the whole startup completes.
      if (event.status === 'ready') return
      if (event.status === 'stopped' || event.status === 'failed') {
        this.activeTurns.clear()
        for (const [threadId, state] of this.threadStates) {
          this.threadStates.set(threadId, {
            status: { type: 'notLoaded' },
            ...(typeof state.canAcceptDirectInput === 'boolean'
              ? { canAcceptDirectInput: state.canAcceptDirectInput }
              : {}),
          })
        }
      }
      const { error: _previousError, ...previous } = this.state
      this.state = {
        ...previous,
        status: event.status,
        ...(event.error ? { error: event.error } : {}),
      }
      this.emit('status', this.snapshot())
    })
    this.client.on('stderr', (text: string) => this.emit('stderr', text))
    this.client.on('notification', (notification: RpcNotification) => {
      this.handleNotification(notification)
      this.ctx.root.emit('codex/notification', notification)
    })
    this.client.on('request', (request: RpcRequest) => {
      void this.handleRequest(request)
    })
  }

  start(): Promise<void> {
    if (this.state.status === 'ready') return Promise.resolve()
    if (!this.startup) {
      const attempt = this.startInternal().finally(() => {
        if (this.startup === attempt) this.startup = undefined
      })
      this.startup = attempt
    }
    return this.startup
  }

  private async startInternal(): Promise<void> {
    const generation = this.generation
    const checkRunning = (): void => {
      if (generation !== this.generation || this.client.status !== 'ready') {
        throw new Error('Codex startup was interrupted')
      }
    }
    try {
      await this.client.start()
      checkRunning()
      const [version, models, config] = await Promise.all([
        this.readVersion(),
        this.loadModels(),
        this.readConfig(),
      ])
      checkRunning()
      // Import App Server's canonical projects before advertising readiness.
      // Otherwise the first thread/list can race project discovery and pin a
      // task to whichever local checkout happens to contain its cwd.
      await this.refreshProjects().catch(() => undefined)
      checkRunning()
      const { error: _previousError, ...previous } = this.state
      this.state = {
        ...previous,
        status: 'ready',
        ...(version ? { version } : {}),
        models,
        defaults: codexSessionDefaults(config, models),
      }
      this.emit('status', this.snapshot())
    } catch (error) {
      if (generation === this.generation) {
        this.state = {
          ...this.state,
          status: 'failed',
          error: errorMessage(error),
        }
        this.emit('status', this.snapshot())
      }
      throw error
    }
  }

  private async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    await this.start()
    return this.client.request<T>(method, params)
  }

  private async readVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(this.options.command ?? 'codex', ['--version'])
      return stdout.trim() || undefined
    } catch {
      return undefined
    }
  }

  private async loadModels(): Promise<ModelOption[]> {
    const response = await this.client.request<ModelListResponse>('model/list', {})
    return (response.data ?? [])
      .map(modelOption)
      .filter((model): model is ModelOption => model !== undefined)
  }

  async readConfig(): Promise<unknown> {
    try {
      const response = await this.client.request<ConfigReadResponse>('config/read', {
        includeLayers: false,
      })
      return response.config
    } catch {
      // Older app-server versions may not expose config/read. Model metadata still
      // provides a useful fallback for the session defaults in that case.
      return undefined
    }
  }

  private refreshProjects(): Promise<void> {
    if (this.projectSync) return this.projectSync
    this.projectSync = (async () => {
      const projects: LocalProject[] = []
      let cursor: string | undefined
      do {
        const response = await this.client.request<ProjectListResponse>('project/list', {
          ...(cursor ? { cursor } : {}),
          limit: 100,
        })
        projects.push(...(response.data ?? []).flatMap((value) => {
          const project = appServerProject(value)
          return project ? [project] : []
        }))
        const next = typeof response.nextCursor === 'string' ? response.nextCursor : undefined
        if (!next || next === cursor) break
        cursor = next
      } while (cursor)
      await this.ctx.projects.importProjects('codex-app', projects)
    })().finally(() => {
      this.projectSync = undefined
    })
    return this.projectSync
  }

  private async classifyThreads(threads: ThreadSummary[]): Promise<ThreadSummary[]> {
    // A project/changed notification can arrive immediately before a history
    // refresh or resume. Wait for that import so canonical project ids are not
    // temporarily replaced by cwd-based guesses.
    if (this.projectSync) await this.projectSync.catch(() => undefined)
    return this.ctx.projects.classifyThreads(threads)
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method === 'serverRequest/resolved') {
      const requestId = notification.params?.requestId as RpcId | undefined
      if (requestId !== undefined) this.resolvePending(requestId)
      return
    }

    if (notification.method === 'project/changed') {
      void this.refreshProjects().catch(() => undefined)
      return
    }

    if (notification.method === 'thread/started') {
      const thread = notification.params?.thread
      if (isRecord(thread) && thread.ephemeral === true && typeof thread.id === 'string') {
        this.ephemeralThreadIds.add(thread.id)
        return
      }
      const summary = readThreadSummary(notification.params?.thread)
      if (summary) {
        this.rememberThreadSummary(summary)
        void this.classifyThreads([summary]).then(([classified]) => {
          if (classified) this.rememberThreadSummary(classified)
          this.emit('status', this.snapshot())
        }).catch(() => undefined)
      }
      return
    }

    if (notification.method === 'thread/name/updated') {
      const threadId = notification.params?.threadId
      const threadName = notification.params?.threadName
      const summary = typeof threadId === 'string' ? this.threadSummaries.get(threadId) : undefined
      if (summary && typeof threadName === 'string' && threadName.trim()) {
        this.rememberThreadSummary({ ...summary, title: threadName.trim() })
        this.emit('status', this.snapshot())
      }
      return
    }

    if (notification.method === 'thread/status/changed') {
      const threadId = notification.params?.threadId
      if (typeof threadId === 'string' && this.ephemeralThreadIds.has(threadId)) return
      const status = readThreadRuntimeStatus(notification.params?.status)
      if (typeof threadId === 'string' && status) {
        if (status.type !== 'active') this.activeTurns.delete(threadId)
        const previous = this.threadStates.get(threadId)
        this.threadStates.set(threadId, {
          status,
          ...(typeof previous?.canAcceptDirectInput === 'boolean'
            ? { canAcceptDirectInput: previous.canAcceptDirectInput }
            : {}),
        })
        this.emit('status', this.snapshot())
      }
      return
    }

    if (notification.method === 'thread/settings/updated') {
      const threadId = notification.params?.threadId
      const settings = isRecord(notification.params?.threadSettings)
        ? threadSessionSettings(
            notification.params.threadSettings,
            typeof threadId === 'string' ? this.threadSummaries.get(threadId) : undefined,
          )
        : undefined
      if (typeof threadId === 'string' && settings) {
        this.threadSettings.set(threadId, settings)
        const summary = this.threadSummaries.get(threadId)
        if (summary) {
          this.rememberThreadSummary({
            ...summary,
            cwd: settings.workspace,
            ...(settings.modelProvider ? { modelProvider: settings.modelProvider } : {}),
          })
        }
        this.emit('status', this.snapshot())
      }
      return
    }

    if (notification.method === 'thread/project/updated') {
      const threadId = notification.params?.threadId
      const projectId = notification.params?.projectId
      const summary = typeof threadId === 'string' ? this.threadSummaries.get(threadId) : undefined
      if (summary) {
        const next = { ...summary }
        if (typeof projectId === 'string' && projectId) {
          next.projectRef = { source: 'codex-app', id: projectId }
        } else {
          delete next.projectRef
        }
        this.rememberThreadSummary(next)
        this.emit('status', this.snapshot())
      }
      return
    }


    if (notification.method === 'turn/started') {
      const threadId = notification.params?.threadId
      if (typeof threadId === 'string' && this.ephemeralThreadIds.has(threadId)) return
      if (typeof threadId === 'string') {
        const turn = isRecord(notification.params?.turn) ? notification.params.turn : undefined
        const turnId = typeof turn?.id === 'string'
          ? turn.id
          : typeof notification.params?.turnId === 'string'
            ? notification.params.turnId
            : undefined
        const active = this.activeTurns.get(threadId)
        if (turnId && active?.turnId !== turnId) {
          this.activeTurns.set(threadId, {
            turnId,
            permissionMode: this.threadSettings.get(threadId)?.permissionMode ?? 'ask',
          })
        }
        const previous = this.threadStates.get(threadId)
        this.threadStates.set(threadId, {
          status: { type: 'active' },
          ...(typeof previous?.canAcceptDirectInput === 'boolean'
            ? { canAcceptDirectInput: previous.canAcceptDirectInput }
            : {}),
        })
        this.emit('status', this.snapshot())
      }
      return
    }

    if (notification.method === 'turn/completed') {
      const threadId = notification.params?.threadId
      if (typeof threadId === 'string' && this.ephemeralThreadIds.has(threadId)) return
      const turn = isRecord(notification.params?.turn) ? notification.params.turn : undefined
      const completedTurnId = typeof notification.params?.turnId === 'string'
        ? notification.params.turnId
        : typeof turn?.id === 'string'
          ? turn.id
          : undefined
      const active = typeof threadId === 'string'
        ? this.activeTurns.get(threadId)
        : undefined
      if (typeof threadId === 'string' && (
        !active || !completedTurnId || completedTurnId === active.turnId
      )) {
        if (active) this.activeTurns.delete(threadId)
        const previous = this.threadStates.get(threadId)
        this.threadStates.set(threadId, {
          status: { type: 'idle' },
          ...(typeof previous?.canAcceptDirectInput === 'boolean'
            ? { canAcceptDirectInput: previous.canAcceptDirectInput }
            : {}),
        })
        this.emit('status', this.snapshot())
      }
    }
  }

  private async handleRequest(request: RpcRequest): Promise<void> {
    if (request.method === 'item/tool/call') {
      const call = toolCall(request)
      if (!call) {
        this.client.respondError(request.id, -32602, 'Invalid dynamic tool call parameters')
        return
      }
      this.client.respond(request.id, await this.ctx.tools.execute(call))
      return
    }

    if (request.method === 'currentTime/read') {
      this.client.respond(request.id, {
        currentTimeAt: Math.floor(Date.now() / 1000),
      })
      return
    }

    const pending: PendingServerRequest = {
      id: request.id,
      method: request.method,
      params: request.params ?? {},
      receivedAt: new Date().toISOString(),
    }
    this.pending.set(request.id, pending)
    this.ctx.root.emit('codex/server-request', request)
    this.emit('serverRequest', structuredClone(pending))
  }

  async startThread(options: SessionOptions): Promise<ThreadStartResponse> {
    const permissions = permissionSettings(options.permissionMode, options.workspace)
    const response = await this.request<ThreadStartResponse>('thread/start', {
      cwd: options.workspace,
      model: options.model ?? null,
      sandbox: permissions.sandbox,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      dynamicTools: this.ctx.tools.toAppServerSpecs(),
      experimentalRawEvents: false,
    })
    if (!response.thread || typeof response.thread.id !== 'string') {
      throw new Error('codex app-server returned a thread without an id')
    }
    const summary = readThreadSummary(response.thread)
    this.rememberThreadWorkspace(response.thread.id, summary?.cwd || options.workspace, summary)
    return response
  }

  /** Runs one non-persistent, read-only model turn and returns its final text. */
  async generateText(request: CodexTextGenerationRequest): Promise<string> {
    const timeoutMs = Math.min(10 * 60_000, Math.max(30_000, request.timeoutMs ?? 5 * 60_000))
    const started = await this.request<ThreadStartResponse>('thread/start', {
      cwd: request.workspace,
      model: request.model,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      dynamicTools: [],
      experimentalRawEvents: false,
      ephemeral: true,
      serviceName: request.serviceName ?? 'alto-text-generation',
      baseInstructions: request.instructions,
    })
    const threadId = started.thread?.id
    if (!threadId) throw new Error('codex app-server returned an ephemeral thread without an id')
    this.ephemeralThreadIds.add(threadId)

    let turnId: string | undefined
    let completed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let resolveCompletion: ((notification: RpcNotification) => void) | undefined
    const completion = new Promise<RpcNotification>((resolve, reject) => {
      resolveCompletion = resolve
      timer = setTimeout(() => reject(new Error(
        `Codex text generation did not finish within ${Math.ceil(timeoutMs / 1000)} seconds`,
      )), timeoutMs)
    })
    const onNotification = (notification: RpcNotification): void => {
      if (notification.method !== 'turn/completed') return
      const notificationThreadId = notification.params?.threadId
      const turn = isRecord(notification.params?.turn) ? notification.params.turn : undefined
      const notificationTurnId = typeof notification.params?.turnId === 'string'
        ? notification.params.turnId
        : typeof turn?.id === 'string'
          ? turn.id
          : undefined
      if (notificationThreadId !== threadId) return
      if (turnId && notificationTurnId && notificationTurnId !== turnId) return
      completed = true
      resolveCompletion?.(notification)
    }
    this.client.on('notification', onNotification)

    try {
      const response = await this.request<TurnStartResponse>('turn/start', {
        threadId,
        input: [{ type: 'text', text: request.prompt }],
        model: request.model,
        effort: request.effort,
        cwd: request.workspace,
        additionalContext: request.additionalContext ?? null,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      })
      turnId = response.turn?.id
      if (!turnId) throw new Error('codex app-server started text generation without a turn id')

      const notification = await completion
      const completedTurn = isRecord(notification.params?.turn)
        ? notification.params.turn
        : undefined
      if (completedTurn?.status === 'failed') {
        const failure = isRecord(completedTurn.error) && typeof completedTurn.error.message === 'string'
          ? completedTurn.error.message
          : 'Codex reported that text generation failed'
        throw new Error(failure)
      }

      const immediateMessages = completedTurn
        ? readThreadMessages(threadId, [completedTurn])
        : []
      let answer = immediateMessages.findLast((message) => (
        message.role === 'agent' && message.phase === 'final_answer'
      )) ?? immediateMessages.findLast((message) => message.role === 'agent')
      if (!answer) {
        const page = await this.listThreadTurns(threadId, undefined, 1)
        answer = page.messages.findLast((message) => (
          message.role === 'agent' && message.phase === 'final_answer'
        )) ?? page.messages.findLast((message) => message.role === 'agent')
      }
      const text = answer?.text.trim()
      if (!text) throw new Error('Codex completed text generation without a final response')
      return text
    } catch (error) {
      if (!completed && turnId) {
        await this.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      this.client.off('notification', onNotification)
      resolveCompletion = undefined
      this.activeTurns.delete(threadId)
      this.threadStates.delete(threadId)
      this.threadSettings.delete(threadId)
      this.threadSummaries.delete(threadId)
      this.ephemeralThreadIds.delete(threadId)
    }
  }

  async threadSummary(threadId: string): Promise<ThreadSummary | undefined> {
    const cached = this.threadSummaries.get(threadId)
    if (cached) return structuredClone(cached)

    const response = await this.request<ThreadReadResponse>('thread/read', {
      threadId,
      includeTurns: false,
    })
    const summary = readThreadSummary(response.thread)
    if (!summary) return undefined
    this.rememberThreadSummary(summary)
    return structuredClone(summary)
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.request('thread/name/set', { threadId, name })
  }

  async listThreads(limit = 200): Promise<ThreadSummary[]> {
    const threads: ThreadSummary[] = []
    let cursor: string | undefined

    while (threads.length < limit) {
      const response = await this.request<ThreadListResponse>('thread/list', {
        ...(cursor ? { cursor } : {}),
        limit: Math.min(100, limit - threads.length),
        sortKey: 'recency_at',
        sortDirection: 'desc',
        sourceKinds: ['cli', 'vscode', 'appServer'],
      })
      threads.push(...(response.data ?? []).flatMap((value) => {
        const summary = readThreadSummary(value)
        return summary ? [summary] : []
      }))

      const nextCursor = typeof response.nextCursor === 'string'
        ? response.nextCursor
        : undefined
      if (!nextCursor || nextCursor === cursor) break
      cursor = nextCursor
    }

    const listed = threads.slice(0, limit)
    for (const thread of listed) this.rememberThreadSummary(thread)
    const classified = await this.classifyThreads(listed)
    for (const thread of classified) this.rememberThreadSummary(thread)
    return classified
  }

  async listSkills(workspace: string): Promise<SkillOption[]> {
    const response = await this.request<SkillsListResponse>('skills/list', {
      cwds: [workspace],
    })
    const entry = (response.data ?? []).find((value) => (
      isRecord(value) && value.cwd === workspace
    )) ?? response.data?.[0]
    if (!isRecord(entry) || !Array.isArray(entry.skills)) return []

    const seen = new Set<string>()
    return entry.skills.flatMap((value) => {
      const skill = skillOption(value)
      if (!skill || seen.has(skill.name)) return []
      seen.add(skill.name)
      return [skill]
    }).sort((left, right) => left.name.localeCompare(right.name))
  }

  async openThread(threadId: string, _options: SessionOptions): Promise<ThreadView> {
    const known = this.threadSummaries.get(threadId)
    // thread/resume is optimized for turn state and can omit immutable thread
    // metadata such as gitInfo. Read that one thread directly when our cache is
    // incomplete instead of inferring its branch from the current checkout.
    const metadataPromise = known?.gitInfo
      ? Promise.resolve(known)
      : this.request<ThreadReadResponse>('thread/read', {
          threadId,
          includeTurns: false,
        }).then(({ thread }) => readThreadSummary(thread)).catch(() => known)
    const [response, metadata] = await Promise.all([
      this.request<ThreadResumeResponse>('thread/resume', {
        threadId,
        excludeTurns: true,
        initialTurnsPage: {
          limit: INITIAL_THREAD_TURN_LIMIT,
          sortDirection: 'desc',
          itemsView: 'full',
        },
      }),
      metadataPromise,
    ])
    const thread = response.thread
    const page = isRecord(response.initialTurnsPage) && Array.isArray(response.initialTurnsPage.data)
      ? response.initialTurnsPage.data
      : []
    const view = readThreadView(isRecord(thread)
      ? { ...thread, turns: chronologicalTurns(page) }
      : thread)
    const openedSummary = openedThreadSummary(view.summary, metadata, known)
    const [summary] = await this.classifyThreads([openedSummary])
    const resolvedSummary = summary ?? openedSummary
    this.rememberThreadSummary(resolvedSummary)
    const settings = threadSessionSettings(response as unknown as Record<string, unknown>, resolvedSummary)
    if (settings) this.threadSettings.set(threadId, settings)
    const activeTurn = page.find((turn) => (
      isRecord(turn) && turn.status === 'inProgress' && typeof turn.id === 'string'
    ))
    if (isRecord(activeTurn) && typeof activeTurn.id === 'string') {
      this.activeTurns.set(threadId, {
        turnId: activeTurn.id,
        permissionMode: settings?.permissionMode ?? 'ask',
      })
      const previous = this.threadStates.get(threadId)
      this.threadStates.set(threadId, {
        status: { type: 'active' },
        ...(typeof previous?.canAcceptDirectInput === 'boolean'
          ? { canAcceptDirectInput: previous.canAcceptDirectInput }
          : {}),
      })
    } else {
      this.activeTurns.delete(threadId)
    }
    // Resume supplies authoritative runtime settings and may also recover an
    // in-flight turn. Publish both before the browser renders the resumed task.
    this.emit('status', this.snapshot())
    const cursor = olderCursor(response.initialTurnsPage)
    return {
      ...view,
      summary: resolvedSummary,
      ...(cursor ? { olderCursor: cursor } : {}),
      ...(settings ? { session: settings } : {}),
    }
  }

  async listThreadTurns(
    threadId: string,
    cursor?: string,
    limit = INITIAL_THREAD_TURN_LIMIT,
  ): Promise<ThreadHistoryPage> {
    const response = await this.request<ThreadTurnsListResponse>('thread/turns/list', {
      threadId,
      ...(cursor ? { cursor } : {}),
      limit: Math.max(1, Math.min(100, Math.floor(limit))),
      sortDirection: 'desc',
      itemsView: 'full',
    })
    const turns = chronologicalTurns(response.data ?? [])
    const next = typeof response.nextCursor === 'string' ? response.nextCursor : undefined
    return {
      messages: readThreadMessages(threadId, turns),
      ...(next ? { olderCursor: next } : {}),
    }
  }

  async startTurn(
    threadId: string,
    input: TurnInput[],
    options: SessionOptions,
  ): Promise<TurnStartResponse> {
    // Capture this before crossing the App Server boundary. The caller may
    // update its composer settings while turn/start is still in flight.
    const permissionMode = options.permissionMode
    const draft: TurnDraft = {
      threadId,
      input,
      cwd: options.workspace,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
    }
    const prepared = await this.ctx.turnProgram.prepare(draft)
    this.rememberThreadWorkspace(threadId, prepared.cwd ?? options.workspace)
    // A trusted turn plugin may retarget the working directory (for example,
    // to another local worktree). Keep the sandbox rooted at the directory
    // the turn will actually use instead of the composer's original folder.
    const permissions = permissionSettings(permissionMode, prepared.cwd ?? options.workspace)
    const response = await this.request<TurnStartResponse>('turn/start', {
      threadId: prepared.threadId,
      input: prepared.input,
      model: prepared.model ?? null,
      effort: prepared.effort ?? null,
      cwd: prepared.cwd ?? null,
      additionalContext: prepared.additionalContext ?? null,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandboxPolicy: permissions.sandboxPolicy,
    })
    if (response.turn && typeof response.turn.id === 'string') {
      this.activeTurns.set(threadId, {
        turnId: response.turn.id,
        // Authorization follows the permissions the turn actually started
        // with. A later composer setting change must not upgrade a live turn.
        permissionMode,
      })
      const previous = this.threadStates.get(threadId)
      this.threadStates.set(threadId, {
        status: { type: 'active' },
        ...(typeof previous?.canAcceptDirectInput === 'boolean'
          ? { canAcceptDirectInput: previous.canAcceptDirectInput }
          : {}),
      })
      this.emit('status', this.snapshot())
    }
    return response
  }

  permissionModeForTurn(threadId: string, turnId: string): PermissionMode | undefined {
    const active = this.activeTurns.get(threadId)
    return active?.turnId === turnId ? active.permissionMode : undefined
  }

  async interrupt(threadId: string): Promise<void> {
    const active = this.activeTurns.get(threadId)
    if (!active) throw new Error(`thread ${threadId} has no active turn`)
    await this.request('turn/interrupt', { threadId, turnId: active.turnId })
  }

  async steer(threadId: string, input: TurnInput[]): Promise<{ turnId: string }> {
    const active = this.activeTurns.get(threadId)
    if (!active) throw new Error(`thread ${threadId} has no active turn`)
    const expectedTurnId = active.turnId
    const response = await this.request<TurnSteerResponse>('turn/steer', {
      threadId,
      input,
      expectedTurnId,
    })
    if (response.turnId !== expectedTurnId) {
      throw new Error('codex app-server steered a different turn than expected')
    }
    return { turnId: expectedTurnId }
  }

  async listQueuedSubmissions(threadId: string): Promise<unknown[]> {
    const submissions: unknown[] = []
    let cursor: string | undefined
    do {
      const response = await this.request<ThreadQueueListResponse>('thread/queue/list', {
        threadId,
        ...(cursor ? { cursor } : {}),
        limit: 100,
      })
      submissions.push(...(response.data ?? []))
      const next = typeof response.nextCursor === 'string' ? response.nextCursor : undefined
      if (!next || next === cursor) break
      cursor = next
    } while (cursor)
    return submissions
  }

  async addQueuedSubmission(
    threadId: string,
    input: TurnInput[],
    clientUserMessageId: string,
  ): Promise<unknown> {
    const response = await this.request<ThreadQueueAddResponse>('thread/queue/add', {
      threadId,
      input,
      clientUserMessageId,
    })
    return response.queuedSubmission
  }

  async updateQueuedSubmission(
    threadId: string,
    queuedSubmissionId: string,
    input: TurnInput[],
  ): Promise<unknown> {
    const response = await this.request<ThreadQueueUpdateResponse>('thread/queue/update', {
      threadId,
      queuedSubmissionId,
      input,
    })
    return response.queuedSubmission
  }

  async deleteQueuedSubmission(threadId: string, queuedSubmissionId: string): Promise<void> {
    await this.request('thread/queue/delete', { threadId, queuedSubmissionId })
  }

  async reorderQueuedSubmissions(threadId: string, queuedSubmissionIds: string[]): Promise<void> {
    await this.request('thread/queue/reorder', { threadId, queuedSubmissionIds })
  }

  async startQueuedSubmission(
    threadId: string,
    queuedSubmissionId?: string,
  ): Promise<ThreadQueueStartResponse> {
    const response = await this.request<ThreadQueueStartResponse>('thread/queue/start', {
      threadId,
      ...(queuedSubmissionId ? { queuedSubmissionId } : {}),
    })
    if (response.turn && typeof response.turn.id === 'string') {
      this.activeTurns.set(threadId, {
        turnId: response.turn.id,
        permissionMode: this.threadSettings.get(threadId)?.permissionMode ?? 'ask',
      })
      const previous = this.threadStates.get(threadId)
      this.threadStates.set(threadId, {
        status: { type: 'active' },
        ...(typeof previous?.canAcceptDirectInput === 'boolean'
          ? { canAcceptDirectInput: previous.canAcceptDirectInput }
          : {}),
      })
      this.emit('status', this.snapshot())
    }
    return response
  }

  resolveServerRequest(id: RpcId, result: unknown): void {
    if (!this.pending.has(id)) throw new Error(`unknown server request: ${String(id)}`)
    this.client.respond(id, result)
    this.resolvePending(id)
  }

  private resolvePending(id: RpcId): void {
    if (!this.pending.delete(id)) return
    this.emit('serverRequestResolved', id)
  }

  pendingRequests(): PendingServerRequest[] {
    return [...this.pending.values()].map((request) => structuredClone(request))
  }

  snapshot(): CodexSnapshot {
    const { defaults, error, version, ...required } = this.state
    return {
      ...required,
      ...(version ? { version } : {}),
      ...(error ? { error } : {}),
      ...(defaults ? { defaults: structuredClone(defaults) } : {}),
      models: this.state.models.map((model) => structuredClone(model)),
      activeThreadIds: [...this.threadStates]
        .filter(([, state]) => state.status.type === 'active')
        .map(([threadId]) => threadId),
      threadStates: Object.fromEntries(
        [...this.threadStates].map(([threadId, state]) => [threadId, structuredClone(state)]),
      ),
      threadSettings: Object.fromEntries(
        [...this.threadSettings].map(([threadId, settings]) => [threadId, structuredClone(settings)]),
      ),
    }
  }

  async stop(): Promise<void> {
    this.generation++
    this.startup = undefined
    await this.client.stop()
    this.pending.clear()
    this.activeTurns.clear()
    this.threadSummaries.clear()
    this.threadStates.clear()
    this.threadSettings.clear()
  }

  private rememberThreadSummary(thread: ThreadSummary): void {
    this.threadSummaries.set(thread.id, structuredClone(thread))
    if (thread.status || typeof thread.canAcceptDirectInput === 'boolean') {
      const previous = this.threadStates.get(thread.id)
      this.threadStates.set(thread.id, {
        status: thread.status ?? previous?.status ?? { type: 'notLoaded' },
        ...(typeof thread.canAcceptDirectInput === 'boolean'
          ? { canAcceptDirectInput: thread.canAcceptDirectInput }
          : typeof previous?.canAcceptDirectInput === 'boolean'
            ? { canAcceptDirectInput: previous.canAcceptDirectInput }
            : {}),
      })
    }
  }

  private rememberThreadWorkspace(
    threadId: string,
    workspace: string,
    summary = this.threadSummaries.get(threadId),
  ): void {
    const timestamp = Math.floor(Date.now() / 1_000)
    this.rememberThreadSummary({
      id: threadId,
      title: summary?.title ?? 'New chat',
      preview: summary?.preview ?? '',
      cwd: workspace,
      createdAt: summary?.createdAt || timestamp,
      updatedAt: summary?.updatedAt || timestamp,
      recencyAt: summary?.recencyAt || summary?.updatedAt || timestamp,
      ...(summary?.projectId ? { projectId: summary.projectId } : {}),
      ...(summary?.projectRef ? { projectRef: summary.projectRef } : {}),
      ...(summary?.gitInfo ? { gitInfo: summary.gitInfo } : {}),
      ...(summary?.modelProvider ? { modelProvider: summary.modelProvider } : {}),
      ...(summary?.status ? { status: summary.status } : {}),
      ...(typeof summary?.canAcceptDirectInput === 'boolean'
        ? { canAcceptDirectInput: summary.canAcceptDirectInput }
        : {}),
    })
  }
}

export const codexServicePlugin: Plugin<CodexServiceOptions> = (
  ctx: Context,
  options: CodexServiceOptions,
) => {
  const service = new CodexService(ctx, options)
  ctx.provide('codex', service)
  return () => service.stop()
}

codexServicePlugin.inject = ['projects', 'tools', 'turnProgram']
codexServicePlugin.provide = 'codex'
