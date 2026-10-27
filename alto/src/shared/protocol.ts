export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type RpcId = string | number

export interface RpcRequest {
  id: RpcId
  method: string
  params?: Record<string, unknown>
}

export interface RpcNotification {
  method: string
  params?: Record<string, unknown>
}

export interface RpcResponse {
  id: RpcId
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface DynamicToolSpec {
  name: string
  namespace?: string
  description: string
  inputSchema: Record<string, unknown>
  deferLoading?: boolean
}

export type UiTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'danger'

export type UiSpacing = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export type ComposerCapability = 'skills' | 'markdown' | 'images' | 'files'
export type UiShellBuiltin =
  | 'brand'
  | 'status'
  | 'history'
  | 'search'
  | 'conversation'
  | 'scrollback'
  | 'steer'
  | 'composer'
  | 'settings'
  | 'plugins'
  | 'new-thread'
  | 'new-workspace'

export interface UiSurfaceBase {
  id: string
  kind: string
  label?: string
  appearance?: 'icon' | 'text' | 'full'
}

export interface UiSurface extends UiSurfaceBase {
  data?: JsonObject
  limit?: number
  showAge?: boolean
  emptyText?: string
  emptyState?: 'none' | 'orbit'
  markdown?: boolean
  placeholder?: string
  focusHeight?: number
  maxHeight?: number
  capabilities?: ComposerCapability[]
}

export type UiShellNode =
  | {
      type: 'box'
      id?: string
      role?: 'header' | 'main' | 'aside' | 'footer' | 'section'
      direction?: 'row' | 'column'
      align?: 'start' | 'center' | 'end' | 'stretch'
      justify?: 'start' | 'center' | 'end' | 'between'
      gap?: UiSpacing
      padding?: UiSpacing
      surface?: 'none' | 'canvas' | 'panel' | 'raised' | 'accent'
      border?: 'none' | 'soft' | 'strong'
      radius?: 'none' | 'sm' | 'md' | 'lg' | 'round'
      shadow?: 'none' | 'soft' | 'panel'
      width?: 'content' | 'compact' | 'narrow' | 'medium' | 'wide' | 'half' | 'full'
      grow?: boolean
      wrap?: boolean
      scroll?: 'none' | 'x' | 'y' | 'both'
      responsive?: 'none' | 'stack'
      children: UiShellNode[]
    }
  | {
      type: 'builtin'
      name: UiShellBuiltin
      label?: string
      appearance?: 'icon' | 'text' | 'full'
    }
  | {
      type: 'surface'
      id: string
    }
  | {
      type: 'contribution'
      id: string
      presentation?: 'cards' | 'plain' | 'inline'
    }
  | {
      type: 'slot'
      name: string
      title?: string
      empty?: string
      presentation?: 'cards' | 'plain' | 'inline'
      direction?: 'row' | 'column'
      gap?: UiSpacing
      grow?: boolean
      scroll?: 'none' | 'x' | 'y' | 'both'
    }
  | {
      type: 'outlet'
      name: string
      fallback?: UiShellNode
    }
  | {
      type: 'label'
      text: string
      tone?: UiTone
      style?: 'body' | 'caption' | 'title'
    }
  | {
      type: 'spacer'
    }

export interface UiTheme {
  accent?: string
  accentText?: string
  background?: string
  canvas?: string
  panel?: string
  text?: string
  textStrong?: string
  muted?: string
  border?: string
  font?: 'system' | 'rounded' | 'serif' | 'mono'
  density?: 'compact' | 'comfortable' | 'spacious'
  corners?: 'square' | 'soft' | 'round'
}

export interface UiShell {
  id: string
  theme?: UiTheme
  root: UiShellNode
}

export interface UiShellRegion {
  id: string
  outlet: string
  root: UiShellNode
}

export type UiNode =
  | {
      type: 'text'
      text: string
      tone?: UiTone
    }
  | {
      type: 'metric'
      label: string
      value: string
      tone?: UiTone
    }
  | {
      type: 'list'
      items: Array<{
        id?: string
        label: string
        detail?: string
        tone?: UiTone
      }>
      empty?: string
    }
  | {
      type: 'input'
      id: string
      label?: string
      placeholder?: string
      value?: string
      inputType?: 'text' | 'number' | 'password'
    }
  | {
      type: 'button'
      action: string
      label: string
      variant?: 'primary' | 'secondary' | 'danger'
      disabled?: boolean
    }
  | {
      type: 'row' | 'group'
      title?: string
      children: UiNode[]
    }

export interface UiContribution {
  id: string
  title?: string
  description?: string
  slot?: string
  order?: number
  nodes: UiNode[]
}

export interface UiSnapshot {
  shell?: UiShell
  regions: UiShellRegion[]
  surfaces: UiSurface[]
  contributions: UiContribution[]
}

export interface UiAction {
  contributionId: string
  actionId: string
  values: Record<string, string>
}

export interface ProgramFileView {
  path: string
  content: string
}

export interface ProgramPluginView {
  id: string
  name: string
  description: string
  protocolVersion: number
  module?: string
  client?: ProgramClientView
  parentId?: string
  depth: number
  enabled: boolean
  effectiveEnabled: boolean
  state: FiberStateName
  inject: string[]
  provides: string[]
  config: JsonValue
  isolate: Record<string, true | string>
  intercept: Record<string, JsonValue>
  loadedAt?: string
}

export interface ProgramClientView {
  module: string
  hash: string
  url: string
  loadedAt: string
}

export type FiberStateName =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'disposed'
  | 'unloading'
  | 'disabled'

export interface ProgramProposal {
  id: string
  summary: string
  createdAt: string
  files: ProgramFileView[]
  source: 'agent' | 'user'
}

export interface ProgramSnapshot {
  revision: number
  profileText: string
  plugins: ProgramPluginView[]
  files: ProgramFileView[]
  tools: DynamicToolSpec[]
  extensionMethods?: string[]
  proposals: ProgramProposal[]
  lastError?: string
  lastAppliedAt?: string
}

export interface ModelOption {
  id: string
  displayName: string
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string
    description?: string
  }>
}

export interface CodexSessionDefaults {
  model?: string
  effort?: string
  permissionMode: PermissionMode
}

export interface PendingServerRequest {
  id: RpcId
  method: string
  params: Record<string, unknown>
  receivedAt: string
}

export interface HarnessSnapshot {
  codex: {
    status: 'starting' | 'ready' | 'stopped' | 'failed'
    version?: string
    error?: string
    models: ModelOption[]
    activeThreadIds: string[]
    threadStates?: Record<string, ThreadRuntimeState>
    threadSettings?: Record<string, ThreadSessionSettings>
    defaults?: CodexSessionDefaults
  }
  program: ProgramSnapshot
  projects: ProjectSnapshot
  ui: UiSnapshot
  extensions: Record<string, JsonValue>
  pendingRequests: PendingServerRequest[]
  server: {
    port: number
    host: string
    projectRoot: string
  }
}

export type PermissionMode = 'ask' | 'auto' | 'full'

export interface LocalProject {
  id: string
  name: string
  primaryRoot: string
  roots: string[]
  source?: string
}

export interface ProjectSnapshot {
  revision: number
  projects: LocalProject[]
}

export interface LocalProjectInput {
  id?: string
  name: string
  primaryRoot: string
  roots: string[]
}

export interface SessionOptions {
  workspace: string
  model?: string
  effort?: string
  permissionMode: PermissionMode
}

export interface SkillOption {
  name: string
  description: string
  path: string
  scope: 'user' | 'repo' | 'system' | 'admin'
  displayName?: string
  shortDescription?: string
}

export interface ChatImage {
  name: string
  mediaType: string
  url: string
}

export interface ChatAttachment {
  name: string
  path: string
  mediaType?: string
  size?: number
}

export interface ThreadFileChange {
  path: string
  kind: FileChangeKind
  diff: string
}

export type FileChangeKind = 'add' | 'delete' | 'update'

export interface ThreadTrace {
  id: string
  kind: 'reasoning' | 'command' | 'tool' | 'status'
  title: string
  text: string
  status?: string
}

export interface ThreadGitInfo {
  branch?: string
  sha?: string
  originUrl?: string
}

export interface ThreadProjectRef {
  source: string
  id: string
}

export interface ThreadRuntimeStatus {
  type: string
  activeFlags?: string[]
}

export interface ThreadRuntimeState {
  status: ThreadRuntimeStatus
  canAcceptDirectInput?: boolean
}

export interface ThreadSessionSettings extends SessionOptions {
  modelProvider?: string
  canAcceptDirectInput?: boolean
}

export interface ThreadTextElement {
  byteRange: { start: number; end: number }
  placeholder?: string
}

export type TurnInput =
  | { type: 'text'; text: string; text_elements?: ThreadTextElement[] }
  | { type: 'image'; url: string; detail?: string }
  | { type: 'localImage'; path: string; detail?: string }
  | { type: 'audio'; url: string }
  | { type: 'localAudio'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }

export interface ThreadSummary {
  id: string
  providerId?: string
  providerSessionId?: string
  title: string
  preview: string
  cwd: string
  createdAt: number
  updatedAt: number
  recencyAt?: number
  projectId?: string
  projectRef?: ThreadProjectRef
  gitInfo?: ThreadGitInfo
  modelProvider?: string
  status?: ThreadRuntimeStatus
  canAcceptDirectInput?: boolean
}

export function threadRecencyAt(
  thread: Pick<ThreadSummary, 'updatedAt' | 'recencyAt'>,
): number {
  return thread.recencyAt ?? thread.updatedAt
}

export interface AsyncUserInputQuestion {
  title: string
  options?: string[]
}

// Async questions are agent messages, not server requests. Preserve their
// metadata in both live activity and history instead of flattening it to text.
export function agentMessageMetadata(item: Record<string, unknown>): {
  delivery?: 'async'
  questions?: AsyncUserInputQuestion[]
} {
  if (item.delivery !== 'async') return {}
  const questions = Array.isArray(item.questions) ? item.questions.flatMap((question) => {
    if (!isRecord(question) || typeof question.title !== 'string' || !question.title.trim()) return []
    const options = Array.isArray(question.options)
      ? question.options.filter((option): option is string => typeof option === 'string' && Boolean(option.trim()))
      : []
    return [{ title: question.title, ...(options.length ? { options } : {}) }]
  }) : []
  return { delivery: 'async', ...(questions.length ? { questions } : {}) }
}

export interface ThreadMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  continuesTurn?: boolean
  phase?: 'commentary' | 'final_answer'
  delivery?: 'async'
  questions?: AsyncUserInputQuestion[]
  images?: ChatImage[]
  attachments?: ChatAttachment[]
  createdAt?: number
  durationMs?: number
  tracesBefore?: ThreadTrace[]
  tracesAfter?: ThreadTrace[]
  fileChanges?: ThreadFileChange[]
  input?: TurnInput[]
}

export interface ThreadView {
  summary: ThreadSummary
  messages: ThreadMessage[]
  olderCursor?: string
  session?: ThreadSessionSettings
}

export interface ThreadHistoryPage {
  messages: ThreadMessage[]
  olderCursor?: string
}

export type BrowserCommand = (
  | {
      type: 'extension.call'
      requestId: string
      payload: {
        method: string
        payload?: JsonValue
      }
    }
  | {
      type: 'chat.send'
      requestId: string
      payload: SessionOptions & {
        threadId?: string
        text: string
        images?: ChatImage[]
        attachments?: ChatAttachment[]
        skills?: SkillOption[]
      }
    }
  | {
      type: 'skill.list'
      requestId: string
      payload: { workspace: string }
    }
  | {
      type: 'thread.new'
      requestId: string
      payload: SessionOptions
    }
  | {
      type: 'thread.list'
      requestId: string
      payload: { limit?: number }
    }
  | {
      type: 'thread.open'
      requestId: string
      payload: SessionOptions & { threadId: string }
    }
  | {
      type: 'thread.page'
      requestId: string
      payload: { threadId: string; cursor?: string; limit?: number }
    }
  | {
      type: 'project.save'
      requestId: string
      payload: LocalProjectInput
    }
  | {
      type: 'project.remove'
      requestId: string
      payload: { id: string }
    }
  | {
      type: 'turn.interrupt'
      requestId: string
      payload: { threadId: string }
    }
  | {
      type: 'turn.steer'
      requestId: string
      payload: {
        threadId: string
        text: string
        images?: ChatImage[]
        attachments?: ChatAttachment[]
        skills?: SkillOption[]
      }
    }
  | {
      type: 'serverRequest.resolve'
      requestId: string
      payload: { id: RpcId; result: unknown }
    }
  | {
      type: 'program.apply'
      requestId: string
      payload: { profileText: string; files: ProgramFileView[] }
    }
  | {
      type: 'program.reload'
      requestId: string
      payload?: Record<string, never>
    }
  | {
      type: 'program.plugin.setEnabled'
      requestId: string
      payload: { id: string; enabled: boolean }
    }
  | {
      type: 'program.proposal.resolve'
      requestId: string
      payload: { id: string; decision: 'accept' | 'decline' }
    }
  | {
      type: 'ui.action'
      requestId: string
      payload: UiAction
    }
  | {
      type: 'program.client.ready'
      requestId: string
      payload: { revision: number; success: boolean; error?: string }
    }
) & { programRevision?: number }

export type HarnessEvent =
  | { type: 'snapshot'; payload: HarnessSnapshot }
  | { type: 'codex.status'; payload: HarnessSnapshot['codex'] }
  | { type: 'codex.notification'; payload: RpcNotification }
  | { type: 'codex.serverRequest'; payload: PendingServerRequest }
  | { type: 'codex.serverRequest.resolved'; payload: { id: RpcId } }
  | { type: 'codex.stderr'; payload: { text: string } }
  | {
      type: 'program.candidate'
      payload: {
        program: ProgramSnapshot
        ui: UiSnapshot
        extensions: Record<string, JsonValue>
      }
    }
  | {
      type: 'program.updated'
      payload: {
        program: ProgramSnapshot
        projects: ProjectSnapshot
        ui: UiSnapshot
        extensions: Record<string, JsonValue>
      }
    }
  | { type: 'program.error'; payload: { message: string } }
  | { type: 'projects.updated'; payload: ProjectSnapshot }
  | { type: 'ui.updated'; payload: UiSnapshot }
  | { type: 'extensions.updated'; payload: Record<string, JsonValue> }
  | {
      type: 'command.result'
      requestId: string
      payload?: unknown
      error?: string
    }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** App Server represents patch kinds as `{ type: "add" }`, not bare strings. */
export function fileChangeKind(value: unknown): FileChangeKind {
  const kind = typeof value === 'string'
    ? value
    : isRecord(value) && typeof value.type === 'string'
      ? value.type
      : undefined
  return kind === 'add' || kind === 'delete' ? kind : 'update'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
