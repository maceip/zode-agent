import type {} from '../../src/server/services/agent-registry.js'
import type {} from '../../src/server/services/remote-agent-api.js'

/** Display metadata for the checkout where a remote process actually runs. */
export interface RemoteWorkspace {
  name?: string
  url?: string
  cwd?: string
  branch?: string
  repository?: string
}

declare module '../../src/server/services/agent-registry.js' {
  interface AgentSession { workspace?: RemoteWorkspace }
  interface AgentProvider {
    /** Inspect an existing binding without starting or reconnecting its agent. */
    workspaceInfo?(sessionId: string): Promise<RemoteWorkspace | undefined>
  }
}

declare module '../../src/server/services/remote-agent-api.js' {
  interface RemoteAgentProcess { workspace?: RemoteWorkspace }
  interface RemoteAgentBackend {
    /** Read the existing process's location and Git metadata without resuming it. */
    workspaceInfo?(process: RemoteAgentProcess, signal: AbortSignal): Promise<RemoteWorkspace>
  }
}
