import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export async function canonicalPath(value: string): Promise<string> {
  return realpath(value).catch(() => path.resolve(value))
}

/**
 * Resolves a user-selected file for a read-only preview. Previewing is not a
 * workspace mutation, so files do not need to belong to an Alto project.
 */
export async function resolveReadableFile(filePath: string): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error('Files must use an absolute path')
  return realpath(filePath)
}

async function gitPath(
  workspace: string,
  argument: '--show-toplevel' | '--git-common-dir',
): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    workspace,
    'rev-parse',
    '--path-format=absolute',
    argument,
  ], { timeout: 3_000 })
  return canonicalPath(stdout.trim())
}

/**
 * Resolves a project checkout without assuming that every worktree was added
 * to the project's explicit roots. Linked worktrees are accepted when their
 * repository or common Git directory belongs to an Alto project.
 */
export async function validateProjectWorkspace(
  workspace: string,
  roots: readonly string[],
): Promise<string> {
  if (!path.isAbsolute(workspace)) throw new Error('Workspaces must use an absolute path')
  const candidate = await canonicalPath(workspace)
  const allowed = await Promise.all(roots.map(canonicalPath))
  if (allowed.some((root) => containsPath(root, candidate))) return candidate

  const [topLevel, commonDirectory] = await Promise.all([
    gitPath(candidate, '--show-toplevel').catch(() => ''),
    gitPath(candidate, '--git-common-dir').catch(() => ''),
  ])
  if (allowed.some((root) => (
    (topLevel && containsPath(root, topLevel))
    || (commonDirectory && containsPath(root, commonDirectory))
  ))) return candidate
  throw new Error('That workspace is outside Alto projects')
}
