import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { TERMINAL_DEFAULT_DIRECTORY, type GhosttyTerminalConfig } from './ghostty-terminal-api.js'

export async function defaultTerminalDirectory(configured?: string, home = homedir()): Promise<string> {
  const preferred = configured?.trim() || '~/development'
  const directory = preferred === '~' ? home
    : preferred.startsWith('~/') ? path.join(home, preferred.slice(2)) : path.resolve(preferred)
  try {
    if ((await stat(directory)).isDirectory()) return directory
  } catch {
    // A missing or inaccessible preferred directory must not inherit Alto's
    // own process directory when the shell starts.
  }
  return home
}

const ghosttyTerminal: HarnessPlugin<GhosttyTerminalConfig> = (ctx, config) => {
  ctx.clientExtensions.registerMethod(ctx, TERMINAL_DEFAULT_DIRECTORY, async () => ({
    workingDirectory: await defaultTerminalDirectory(config.workingDirectory),
  }))
}
ghosttyTerminal.inject = ['clientExtensions']
export default ghosttyTerminal
