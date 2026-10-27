import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Finder and Dock launches receive only macOS's system PATH. Add the usual
 * user and package-manager locations so child tools resolve the same way they
 * do from a terminal, while preserving any explicitly supplied PATH entries.
 */
export function desktopExecutablePath(
  currentPath = process.env.PATH,
  home = homedir(),
): string {
  const current = currentPath?.split(path.delimiter).filter(Boolean) ?? []
  const supplemental = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
  ]
  return [...new Set([...current, ...supplemental])].join(path.delimiter)
}

export function hydrateDesktopEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  env.PATH = desktopExecutablePath(env.PATH)
}
