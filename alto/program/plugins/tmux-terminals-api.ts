export const TMUX_PREPARE = 'tmux-terminals.prepare'
export const TMUX_CLOSE = 'tmux-terminals.close'

export interface TmuxTerminalService {
  processId(identity: import('./ghostty-terminal-api.js').TerminalIdentity): Promise<number>
}

declare module 'cordis' {
  interface Context { tmuxTerminals: TmuxTerminalService }
}
