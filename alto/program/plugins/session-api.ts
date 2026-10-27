import type {
  HarnessSnapshot,
  LocalProject,
  LocalProjectInput,
  ModelOption,
  PermissionMode,
  SessionOptions,
  SkillOption,
  ThreadSummary,
} from '../../src/shared/protocol.js'
import type { AgentConfigOption, AgentPlanEntry } from '../../src/server/services/agent-registry.js'
import type { ClientDraft } from '../../src/client/plugin-api.js'
import type { ActivityItem } from './ui/activity.js'
import type { HistoryState } from './ui/history.js'
import type { AgentStatus, TurnState } from './ui/machines.js'
import type { RemoteWorkspace } from './remote-workspace-api.js'

export const SESSION_THREAD_RENAME = 'session.thread.rename'
export const SESSION_CODEX_START = 'session.codex.start'
export const SESSION_WORKSPACE_STATE = 'session.workspace'

export interface ClientSessionSnapshot {
  revision: number
  remoteLocation?: string
  remoteStarting?: boolean
  remoteWorkspaceName?: string
  remoteWorkspace?: RemoteWorkspace
  providerId?: string
  providers?: Array<Pick<import('../../src/server/services/agent-registry.js').AgentProviderSnapshot, 'id' | 'label' | 'agentId' | 'location'>>
  models?: ModelOption[]
  agentConfig?: AgentConfigOption[]
  agentPlan?: AgentPlanEntry[]
  agentUsage?: { used: number; size: number; cost?: { amount: number; currency: string } }
  agentCommands?: Array<{ name: string; description: string }>
  canSteer?: boolean
  acceptsImages?: boolean
  connected: boolean
  connectionError?: string | undefined
  harness?: HarnessSnapshot | undefined
  session: SessionOptions
  turn: TurnState
  threadId?: string | undefined
  canAcceptDirectInput?: boolean | undefined
  activeProjectId?: string | undefined
  projectScope?: 'workspace' | 'unscoped'
  agentStatus: AgentStatus
  activities: ActivityItem[]
  hasEarlierActivities: boolean
  loadingEarlierActivities: boolean
  history: HistoryState
  threads: ThreadSummary[]
  projects: LocalProject[]
  skills: SkillOption[]
}

export interface ClientSessionService {
  loadModels?(): Promise<void>
  setProvider?(id: string): void
  setAgentConfig?(id: string, value: string): void
  subscribe(listener: () => void): () => void
  snapshot(): ClientSessionSnapshot
  hasSurface(id: string): boolean
  setModel(model: string | undefined): void
  setEffort(effort: string | undefined): void
  setPermissionMode(mode: PermissionMode): void
  send(draft: ClientDraft): Promise<void>
  steer(draft: ClientDraft): Promise<void>
  interrupt(): Promise<void>
  /** Materialize an empty Codex thread, optionally at a different checkout. */
  ensureThread(workspace?: string): Promise<string>
  newThread(project?: LocalProject | null): void
  retargetNewThread(project: LocalProject): boolean
  openThread(thread: ThreadSummary): Promise<void>
  renameThread(threadId: string, name: string): Promise<void>
  prefetchThread(thread: ThreadSummary): Promise<void>
  loadEarlierActivities(): Promise<void>
  selectProject(project: LocalProject): void
  saveProject(project: LocalProjectInput): Promise<void>
  createWorkspace(project: LocalProjectInput): Promise<void>
  removeProject(id: string): Promise<void>
  refreshHistory(limit?: number): Promise<void>
  resolveRequest(id: string | number, result: unknown): Promise<void>
  resolveProposal(id: string, decision: 'accept' | 'decline'): Promise<void>
}

/**
 * Narrow capability views over the routed session. They intentionally share
 * the same snapshot so consumers can migrate without introducing parallel
 * stores or synchronization between the focused pane and app-wide controls.
 */
export interface ClientConversationService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientSessionSnapshot
  send(draft: ClientDraft): Promise<void>
  steer(draft: ClientDraft): Promise<void>
  interrupt(): Promise<void>
  ensureThread(workspace?: string): Promise<string>
  newThread(project?: LocalProject | null): void
  retargetNewThread(project: LocalProject): boolean
  openThread(thread: ThreadSummary): Promise<void>
  renameThread(threadId: string, name: string): Promise<void>
  prefetchThread(thread: ThreadSummary): Promise<void>
  loadEarlierActivities(): Promise<void>
  refreshHistory(limit?: number): Promise<void>
}

export interface ClientProjectsService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientSessionSnapshot
  selectProject(project: LocalProject): void
  saveProject(project: LocalProjectInput): Promise<void>
  createWorkspace(project: LocalProjectInput): Promise<void>
  removeProject(id: string): Promise<void>
}

export interface ClientApprovalsService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientSessionSnapshot
  resolveRequest(id: string | number, result: unknown): Promise<void>
  resolveProposal(id: string, decision: 'accept' | 'decline'): Promise<void>
}

export interface ClientPreferencesService {
  loadModels?(): Promise<void>
  setProvider?(id: string): void
  setAgentConfig?(id: string, value: string): void
  subscribe(listener: () => void): () => void
  snapshot(): ClientSessionSnapshot
  setModel(model: string | undefined): void
  setEffort(effort: string | undefined): void
  setPermissionMode(mode: PermissionMode): void
}

export interface ClientSessionCreateOptions {
  initialWorkspace?: string
  initialProjectId?: string | null
  restoreActiveThread?: boolean
  persistActiveThread?: boolean
}

export interface ClientSessionHandle {
  session: ClientSessionService
  dispose(): void
}

export interface ClientSessionFactoryService {
  create(options?: ClientSessionCreateOptions): ClientSessionHandle
}

/**
 * App-wide plugins consume one stable session object. A layout can point that
 * object at its focused pane without reopening the same chat in a second
 * session. Clearing the target restores the ordinary single-chat session.
 */
export interface ClientSessionRouterService {
  activeKey(): string | undefined
  activeSession(): ClientSessionService
  globalSession(): ClientSessionService
  setActive(key: string, session: ClientSessionService): void
  clearActive(key?: string): void
}

declare module 'cordis' {
  interface Context {
    clientApprovals: ClientApprovalsService
    clientConversation: ClientConversationService
    clientPreferences: ClientPreferencesService
    clientProjects: ClientProjectsService
    clientSession: ClientSessionService
    clientSessionFactory: ClientSessionFactoryService
    clientSessionRouter: ClientSessionRouterService
  }
}
