import type { Context } from 'cordis'
import type { JsonValue } from '../../shared/protocol.js'

export interface RemoteAgentDescriptor {
  id: string
  label: string
  protocol: 'acp' | 'codex-app-server'
}

/** An opaque, non-secret handle to one process, never an agent-type lookup. */
export interface RemoteAgentProcess {
  id: string
  cwd: string
  workspaceName?: string
  data: JsonValue
}

export type RemoteAgentRecord = {
  cursor: string
  timestamp: string
} & (
  | { stream: 'input' | 'output' | 'error'; text: string }
  | { stream: 'exit'; code: number }
)

/** The journal includes both directions, in order. Cursors are exclusive. */
export interface RemoteAgentBackend {
  id: string
  label: string
  agents: RemoteAgentDescriptor[]
  /** Resolve a display name without provisioning or starting an agent. */
  workspaceName?(cwd: string, signal: AbortSignal, process?: RemoteAgentProcess): Promise<string>
  create(agentId: string, cwd: string, signal: AbortSignal): Promise<RemoteAgentProcess>
  read(process: RemoteAgentProcess, options: {
    after?: string
    follow: boolean
    signal: AbortSignal
  }): AsyncIterable<RemoteAgentRecord>
  send(process: RemoteAgentProcess, text: string, signal: AbortSignal): Promise<void>
  terminate(process: RemoteAgentProcess, signal: AbortSignal): Promise<void>
}

export interface RemoteAgentRegistryService {
  register(owner: Context, backend: RemoteAgentBackend): void
}

declare module 'cordis' {
  interface Context { remoteAgents: RemoteAgentRegistryService }
}
