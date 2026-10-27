import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { watch } from 'chokidar'
import type { Context } from 'cordis'
import type { LocalProject } from '../../../src/shared/protocol.js'
import { isRecord } from '../../../src/shared/protocol.js'
import type { ProjectSourceSnapshot } from '../../../src/server/plugin-api.js'

const SOURCE_ID = 'codex-app'
const EMPTY_SOURCE: ProjectSourceSnapshot = { projects: [] }

export interface CodexWorkspaceImportOptions {
  importCodexWorkspaces?: boolean
  codexStatePath?: string
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function roots(value: unknown): string[] {
  return [...new Set(strings(value)
    .map((root) => root.trim())
    .filter((root) => root && path.isAbsolute(root))
    .map((root) => path.resolve(root)))]
}

function fallbackId(root: string): string {
  return `root-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`
}

function workspaceName(root: string, labels: Record<string, unknown>): string {
  const label = labels[root]
  if (typeof label === 'string' && label.trim()) return label.trim()
  return path.basename(root) || 'Workspace'
}

function projectsFromState(state: Record<string, unknown>): LocalProject[] {
  const stored = state['local-projects']
  const entries = isRecord(stored) ? Object.entries(stored) : []
  const parsed = entries.flatMap(([key, value]) => {
    if (!isRecord(value)) return []
    const projectRoots = roots(value.rootPaths)
    if (!projectRoots.length) return []
    const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : key
    const name = typeof value.name === 'string' && value.name.trim()
      ? value.name.trim()
      : path.basename(projectRoots[0]!) || 'Workspace'
    return [{
      id,
      name,
      primaryRoot: projectRoots[0]!,
      roots: projectRoots,
    }]
  })

  if (parsed.length) {
    const byId = new Map(parsed.map((project) => [project.id, project]))
    const ordered = strings(state['project-order']).flatMap((id) => {
      const project = byId.get(id)
      if (!project) return []
      byId.delete(id)
      return [project]
    })
    return [...ordered, ...byId.values()]
  }

  const labels = isRecord(state['electron-workspace-root-labels'])
    ? state['electron-workspace-root-labels']
    : {}
  return roots(state['electron-saved-workspace-roots']).map((root) => ({
    id: fallbackId(root),
    name: workspaceName(root, labels),
    primaryRoot: root,
    roots: [root],
  }))
}

export function parseCodexWorkspaceState(value: unknown): ProjectSourceSnapshot {
  if (!isRecord(value)) throw new Error('Codex Desktop state must be an object')
  if (!('local-projects' in value) && !('electron-saved-workspace-roots' in value)) {
    throw new Error('Codex Desktop state does not contain a workspace registry')
  }

  const projects = projectsFromState(value)
  const projectIds = new Set(projects.map((project) => project.id))
  const assignments = isRecord(value['thread-project-assignments'])
    ? value['thread-project-assignments']
    : {}
  const threadProjectIds = Object.fromEntries(Object.entries(assignments).flatMap(([threadId, assignment]) => {
    if (!threadId || !isRecord(assignment)) return []
    if (assignment.projectKind !== undefined && assignment.projectKind !== 'local') return []
    const projectId = assignment.projectId
    return typeof projectId === 'string' && projectIds.has(projectId)
      ? [[threadId, projectId]]
      : []
  }))

  return {
    projects,
    ...(Object.keys(threadProjectIds).length ? { threadProjectIds } : {}),
    ...(Array.isArray(value['projectless-thread-ids'])
      ? { unassignedThreadIds: strings(value['projectless-thread-ids']) }
      : {}),
  }
}

export function codexDesktopStatePath(configured?: string): string {
  const explicit = configured?.trim() || process.env.ALTO_CODEX_STATE?.trim()
  if (explicit) return path.resolve(explicit)
  const configuredHome = process.env.CODEX_HOME?.trim()
  const codexHome = configuredHome ? path.resolve(configuredHome) : path.join(homedir(), '.codex')
  return path.join(codexHome, '.codex-global-state.json')
}

export function installCodexWorkspaceSource(
  ctx: Context,
  options: CodexWorkspaceImportOptions,
): void {
  if (options.importCodexWorkspaces === false) return

  const registration = ctx.projects.registerSource(ctx, SOURCE_ID, EMPTY_SOURCE)
  const statePath = codexDesktopStatePath(options.codexStatePath)
  let active = true
  let generation = 0

  const refresh = async (): Promise<void> => {
    const current = ++generation
    let snapshot: ProjectSourceSnapshot
    try {
      const state: unknown = JSON.parse(await readFile(statePath, 'utf8'))
      snapshot = parseCodexWorkspaceState(state)
    } catch {
      // Codex replaces this private file atomically. Keep the last good snapshot
      // if a read races that replacement or a future Desktop release changes it.
      return
    }
    if (!active || current !== generation) return
    try {
      const projectIds = await ctx.projects.importProjects(SOURCE_ID, snapshot.projects)
      if (!active || current !== generation) return
      const localThreadProjectIds = Object.fromEntries(
        Object.entries(snapshot.threadProjectIds ?? {}).flatMap(([threadId, sourceProjectId]) => {
          const projectId = projectIds.get(sourceProjectId)
          return projectId ? [[threadId, projectId]] : []
        }),
      )
      registration.update({
        projects: [],
        ...(Object.keys(localThreadProjectIds).length ? { localThreadProjectIds } : {}),
        ...(snapshot.unassignedThreadIds ? { unassignedThreadIds: snapshot.unassignedThreadIds } : {}),
      })
    } catch (error) {
      console.error('Unable to import Codex workspaces into Alto', error)
    }
  }

  ctx.effect(() => {
    void refresh()
    const watcher = watch(statePath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 80,
        pollInterval: 20,
      },
    })
    const changed = (): void => { void refresh() }
    watcher.on('add', changed)
    watcher.on('change', changed)
    return async () => {
      active = false
      generation += 1
      await watcher.close()
    }
  }, 'sidebar.codexWorkspaces')
}
