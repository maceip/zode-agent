import type { ComponentType } from 'react'
import type { Context } from 'cordis'

export const TERMINAL_DEFAULT_DIRECTORY = 'ghostty-terminal.default-directory'

export interface GhosttyTerminalConfig {
  configuration?: string
  command?: string
  workingDirectory?: string
}

export interface TerminalIdentity {
  workspaceId: string
  paneId: string
  tabId: string
}

export interface TerminalLaunchRequest {
  identity?: TerminalIdentity
  workingDirectory?: string
  command?: string
}

export interface TerminalLauncher {
  id: string
  prepare(request: TerminalLaunchRequest): Promise<{ command?: string }>
  close(identity: TerminalIdentity): Promise<void>
}

export interface GhosttyTerminalProps extends TerminalLaunchRequest {
  configuration?: string
  active?: boolean
  focused?: boolean
}

export interface ClientGhosttyTerminalService {
  renderer: ComponentType<GhosttyTerminalProps>
  registerLauncher(owner: Context, launcher: TerminalLauncher): { dispose(): void }
  close(identity: TerminalIdentity): Promise<void>
}

declare module 'cordis' {
  interface Context {
    clientGhosttyTerminal: ClientGhosttyTerminalService
  }
}
