import { execFile } from 'node:child_process'
import { opendir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import { FILE_TREE_LIST_METHOD, type FileTreeSnapshot } from './file-tree-api.js'
import { validateProjectWorkspace } from './workspace-files.js'

const execFileAsync = promisify(execFile)
const DEFAULT_LIMIT = 5_000
const SKIPPED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules'])

function normalizedPaths(output: string, limit: number): string[] {
  return [...new Set(output.split('\0').map((value) => value.trim()).filter(Boolean))]
    .toSorted((left, right) => left.localeCompare(right))
    .slice(0, limit)
}

async function filesystemFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = []
  const pending = ['']
  while (pending.length && files.length < limit) {
    const relative = pending.pop()!
    const directory = await opendir(path.join(root, relative))
    for await (const entry of directory) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue
      const child = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile()) files.push(child)
      if (files.length >= limit) break
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right))
}

export async function listWorkspaceFiles(workspace: string, limit = DEFAULT_LIMIT): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', workspace,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
    return normalizedPaths(stdout, limit)
  } catch {
    return filesystemFiles(workspace, limit)
  }
}

const fileTree: HarnessPlugin<{ limit?: number }> = (ctx, config) => {
  const configuredLimit = config?.limit
  const limit = typeof configuredLimit === 'number' && Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.min(20_000, Math.floor(configuredLimit))
    : DEFAULT_LIMIT
  ctx.clientExtensions.registerMethod(ctx, FILE_TREE_LIST_METHOD, async (payload) => {
    if (!isRecord(payload) || typeof payload.workspace !== 'string') {
      throw new Error('file-tree.list needs a workspace')
    }
    const roots = ctx.projects.snapshot().projects.flatMap((project) => project.roots)
    const workspace = await validateProjectWorkspace(payload.workspace, roots)
    const snapshot: FileTreeSnapshot = {
      workspace,
      paths: await listWorkspaceFiles(workspace, limit),
    }
    return snapshot as unknown as JsonValue
  })
}

fileTree.inject = ['clientExtensions', 'projects']

export default fileTree
