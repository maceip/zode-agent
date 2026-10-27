import type { Context, Plugin } from 'cordis'
import type {
  DynamicToolSpec,
  ProgramSnapshot,
  RpcNotification,
  RpcRequest,
  UiAction,
  UiContribution,
  UiShell,
  UiShellNode,
  UiShellRegion,
  UiSurface,
  TurnInput,
} from '../shared/protocol.js'
import type { CodexService } from './services/codex-service.js'
import type {
  AgentEvent,
  AgentEventListener,
  AgentMcpServer,
  AgentPlanEntry,
  AgentPromptPart,
  AgentProvider,
  AgentProviderCapabilities,
  AgentProviderRegistration,
  AgentProviderSnapshot,
  AgentProviderStatus,
  AgentRegistry,
  AgentSession,
  AgentSessionOptions,
  AgentTurn,
} from './services/agent-registry.js'
import type {
  ClientExtensionHandler,
  ClientExtensionMethodRegistration,
  ClientExtensionRegistry,
  ClientExtensionStateRegistration,
} from './services/client-extension-registry.js'
import type { ProgramRuntime } from './services/program-runtime.js'
import type {
  ProjectRegistry,
  ProjectSourceRegistration,
  ProjectSourceSnapshot,
} from './services/project-registry.js'
import type { TurnProgram } from './services/turn-program.js'
import type { DynamicToolRegistry } from './services/tool-registry.js'
import type {
  UiActionHandler,
  UiRegistration,
  UiRegistry,
  UiShellRegistration,
  UiShellRegionRegistration,
  UiSurfaceRegistration,
} from './services/ui-registry.js'

export interface TurnDraft {
  threadId: string
  input: TurnInput[]
  model?: string
  effort?: string
  cwd?: string
  additionalContext?: Record<
    string,
    { kind: 'application' | 'untrusted'; value: string }
  >
}

export interface DynamicToolCall {
  callId: string
  threadId: string
  turnId: string
  tool: string
  namespace?: string | null
  arguments: unknown
  /** Captured by the host transport; never read from the agent's tool arguments. */
  permissionMode?: import('../shared/protocol.js').PermissionMode
}

export interface DynamicToolContentItem {
  type: 'inputText' | 'inputImage' | 'inputAudio'
  text?: string
  imageUrl?: string
  audioUrl?: string
}

export interface DynamicToolResult {
  success: boolean
  contentItems: DynamicToolContentItem[]
}

export type DynamicToolHandlerResult =
  | string
  | Record<string, unknown>
  | DynamicToolResult

export type DynamicToolHandler = (
  call: DynamicToolCall,
) => Promise<DynamicToolHandlerResult> | DynamicToolHandlerResult

declare module 'cordis' {
  interface Context {
    agents: AgentRegistry
    clientExtensions: ClientExtensionRegistry
    codex: CodexService
    program: ProgramRuntime
    projects: ProjectRegistry
    turnProgram: TurnProgram
    tools: DynamicToolRegistry
    ui: UiRegistry
  }

  interface Events {
    'codex/notification'(notification: RpcNotification): void
    'codex/server-request'(request: RpcRequest): void
    'codex/turn/prepare'(
      draft: TurnDraft,
      next: () => TurnDraft | Promise<TurnDraft>,
    ): TurnDraft | Promise<TurnDraft>
    'program/changed'(snapshot: ProgramSnapshot): void
    'program/error'(error: Error): void
  }
}

export type HarnessContext = Context
export type HarnessPlugin<T = unknown> = Plugin<T>
export type {
  AgentEvent,
  AgentEventListener,
  AgentMcpServer,
  AgentPlanEntry,
  AgentPromptPart,
  AgentProvider,
  AgentProviderCapabilities,
  AgentProviderRegistration,
  AgentProviderSnapshot,
  AgentProviderStatus,
  AgentSession,
  AgentSessionOptions,
  AgentTurn,
  ClientExtensionHandler,
  ClientExtensionMethodRegistration,
  ClientExtensionStateRegistration,
  DynamicToolSpec,
  ProjectSourceRegistration,
  ProjectSourceSnapshot,
  UiAction,
  UiActionHandler,
  UiContribution,
  UiRegistration,
  UiShell,
  UiShellNode,
  UiShellRegistration,
  UiShellRegion,
  UiShellRegionRegistration,
  UiSurface,
  UiSurfaceRegistration,
}
