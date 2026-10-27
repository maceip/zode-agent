import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Context, Plugin } from 'cordis'
import type {
  LocalProject,
  LocalProjectInput,
  ProjectSnapshot,
  ThreadSummary,
} from '../../shared/protocol.js'
import { isRecord } from '../../shared/protocol.js'

const execFileAsync = promisify(execFile)
const PROJECT_FILE_VERSION = 2
const LEGACY_PROJECT_FILE_VERSION = 1
const GIT_CONCURRENCY = 8

interface ProjectImport {
  source: string
  sourceProjectId: string
  projectId: string
}

interface ProjectFile {
  version: number
  revision: number
  projects: LocalProject[]
  imports: ProjectImport[]
}

export interface ProjectRegistryOptions {
  projectRoot: string
  statePath?: string
}

export interface ProjectSourceSnapshot {
  projects: LocalProject[]
  threadProjectIds?: Record<string, string>
  localThreadProjectIds?: Record<string, string>
  unassignedThreadIds?: string[]
}

export interface ProjectSourceRegistration {
  update(snapshot: ProjectSourceSnapshot): void
  dispose(): Promise<void>
}

interface RegisteredProjectSource {
  projects: LocalProject[]
  threadProjectIds: Map<string, string>
  unassignedThreadIds: Set<string>
  signature: string
}

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function normalizeRoot(root: string): string {
  const value = root.trim()
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`project folders must be absolute paths: ${root || '(empty)'}`)
  }
  return path.resolve(value)
}

async function canonicalRoot(root: string): Promise<string> {
  return realpath(root).catch(() => path.resolve(root))
}

function uniqueRoots(primaryRoot: string, roots: string[]): string[] {
  return [...new Set([primaryRoot, ...roots].map(normalizeRoot))]
}

function projectName(value: string): string {
  const name = value.trim()
  if (!name) throw new Error('a project name is required')
  if (name.length > 80) throw new Error('a project name may be at most 80 characters')
  return name
}

function storedProject(value: unknown): LocalProject | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.primaryRoot !== 'string'
    || !Array.isArray(value.roots)
    || !value.roots.every((root) => typeof root === 'string')
  ) return undefined

  try {
    const primaryRoot = normalizeRoot(value.primaryRoot)
    return {
      id: value.id,
      name: projectName(value.name),
      primaryRoot,
      roots: uniqueRoots(primaryRoot, value.roots as string[]),
    }
  } catch {
    return undefined
  }
}

function storedImport(value: unknown): ProjectImport | undefined {
  if (
    !isRecord(value)
    || typeof value.source !== 'string'
    || typeof value.sourceProjectId !== 'string'
    || typeof value.projectId !== 'string'
  ) return undefined

  try {
    const source = projectSourceId(value.source)
    const sourceProjectId = value.sourceProjectId.trim()
    const projectId = value.projectId.trim()
    if (!sourceProjectId || !projectId) return undefined
    return { source, sourceProjectId, projectId }
  } catch {
    return undefined
  }
}

function contains(root: string, workspace: string): boolean {
  const relative = path.relative(root, workspace)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function directlyMatchingProject(
  projects: LocalProject[],
  workspace: string,
): LocalProject | undefined {
  if (!workspace.trim() || !path.isAbsolute(workspace)) return undefined
  const candidate = path.resolve(workspace)
  let best: { project: LocalProject; length: number } | undefined

  for (const project of projects) {
    for (const root of project.roots) {
      if (!contains(root, candidate) || (best && root.length <= best.length)) continue
      best = { project, length: root.length }
    }
  }
  return best?.project
}

async function directory(root: string): Promise<void> {
  const metadata = await stat(root).catch((error: unknown) => {
    if (missing(error)) throw new Error(`project folder does not exist: ${root}`)
    throw error
  })
  if (!metadata.isDirectory()) throw new Error(`project folder is not a directory: ${root}`)
}

async function gitPath(workspace: string, argument: '--show-toplevel' | '--git-common-dir'): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      workspace,
      'rev-parse',
      '--path-format=absolute',
      argument,
    ], { timeout: 3_000 })
    const value = stdout.trim()
    if (!value) return undefined
    const absolute = path.isAbsolute(value) ? value : path.resolve(workspace, value)
    return await realpath(absolute).catch(() => path.resolve(absolute))
  } catch {
    return undefined
  }
}

function defaultProjectId(root: string): string {
  return `project-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`
}

function projectSourceId(value: string): string {
  const id = value.trim()
  if (!/^[a-z][a-z0-9-]*$/i.test(id) || id.length > 80) {
    throw new Error(`invalid project source id: ${value}`)
  }
  return id
}

function externalProjectId(sourceId: string, projectId: string): string {
  return `${sourceId}:${projectId}`
}

function projectImportKey(sourceId: string, sourceProjectId: string): string {
  return JSON.stringify([sourceId, sourceProjectId])
}

function normalizeProjectSource(
  sourceId: string,
  snapshot: ProjectSourceSnapshot,
): RegisteredProjectSource {
  const ids = new Set<string>()
  const projects = snapshot.projects.map((project) => {
    const rawId = project.id.trim()
    if (!rawId) throw new Error(`project source "${sourceId}" contains a project without an id`)
    if (ids.has(rawId)) throw new Error(`project source "${sourceId}" contains duplicate project id "${rawId}"`)
    ids.add(rawId)
    const primaryRoot = normalizeRoot(project.primaryRoot)
    return {
      id: externalProjectId(sourceId, rawId),
      name: projectName(project.name),
      primaryRoot,
      roots: uniqueRoots(primaryRoot, project.roots),
      source: sourceId,
    }
  })

  const externalThreadProjectEntries = Object.entries(snapshot.threadProjectIds ?? {})
    .filter(([threadId, projectId]) => threadId.trim() && ids.has(projectId))
    .map(([threadId, projectId]) => [
      threadId,
      externalProjectId(sourceId, projectId),
    ] as const)
  const localThreadProjectEntries = Object.entries(snapshot.localThreadProjectIds ?? {})
    .filter(([threadId, projectId]) => threadId.trim() && projectId.trim())
  const threadProjectEntries = [...new Map([
    ...externalThreadProjectEntries,
    ...localThreadProjectEntries,
  ])].sort(([left], [right]) => left.localeCompare(right))
  const unassignedThreadIds = [...new Set(
    (snapshot.unassignedThreadIds ?? []).map((id) => id.trim()).filter(Boolean),
  )].sort()
  const signature = JSON.stringify({ projects, threadProjectEntries, unassignedThreadIds })

  return {
    projects,
    threadProjectIds: new Map(threadProjectEntries),
    unassignedThreadIds: new Set(unassignedThreadIds),
    signature,
  }
}

export class ProjectRegistry {
  private readonly statePath: string
  private readonly gitCommonDirs = new Map<string, Promise<string | undefined>>()
  private readonly sources = new Map<string, RegisteredProjectSource>()
  private imports = new Map<string, ProjectImport>()
  private projects: LocalProject[] = []
  private revision = 0
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly root: Context,
    private readonly options: ProjectRegistryOptions,
  ) {
    this.statePath = path.resolve(
      options.statePath ?? path.join(options.projectRoot, '.codex-cordis', 'projects.json'),
    )
  }

  async start(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (
        !isRecord(parsed)
        || (parsed.version !== LEGACY_PROJECT_FILE_VERSION && parsed.version !== PROJECT_FILE_VERSION)
        || !Array.isArray(parsed.projects)
      ) {
        throw new Error(`invalid project registry: ${this.statePath}`)
      }
      const projects = parsed.projects.map(storedProject)
      if (projects.some((project) => !project)) {
        throw new Error(`invalid project registry entry: ${this.statePath}`)
      }
      this.projects = projects as LocalProject[]
      if (parsed.version === PROJECT_FILE_VERSION) {
        if (!Array.isArray(parsed.imports)) {
          throw new Error(`invalid project imports: ${this.statePath}`)
        }
        const imports = parsed.imports.map(storedImport)
        if (imports.some((entry) => !entry)) {
          throw new Error(`invalid project import entry: ${this.statePath}`)
        }
        for (const entry of imports as ProjectImport[]) {
          const key = projectImportKey(entry.source, entry.sourceProjectId)
          if (this.imports.has(key)) {
            throw new Error(`duplicate project import entry: ${this.statePath}`)
          }
          this.imports.set(key, entry)
        }
      }
      this.revision = typeof parsed.revision === 'number' ? parsed.revision : 0
      return
    } catch (error) {
      if (!missing(error)) throw error
    }

    const configuredRoot = path.resolve(this.options.projectRoot)
    const primaryRoot = await gitPath(configuredRoot, '--show-toplevel') ?? configuredRoot
    this.projects = [{
      id: defaultProjectId(primaryRoot),
      name: path.basename(primaryRoot) || 'Project',
      primaryRoot,
      roots: [primaryRoot],
    }]
    this.revision = 1
    await this.persist()
  }

  snapshot(): ProjectSnapshot {
    return {
      revision: this.revision,
      projects: this.allProjects().map((project) => structuredClone(project)),
    }
  }

  registerSource(
    owner: Context,
    id: string,
    snapshot: ProjectSourceSnapshot,
  ): ProjectSourceRegistration {
    const sourceId = projectSourceId(id)
    let entry = normalizeProjectSource(sourceId, snapshot)
    let active = false
    const dispose = owner.effect(() => {
      if (this.sources.has(sourceId)) {
        throw new Error(`project source "${sourceId}" is already registered`)
      }
      active = true
      this.sources.set(sourceId, entry)
      this.emitChanged()
      return () => {
        active = false
        if (this.sources.get(sourceId) === entry) this.sources.delete(sourceId)
        this.emitChanged()
      }
    }, `projects.registerSource(${JSON.stringify(sourceId)})`)

    return {
      update: (next) => {
        if (!active) throw new Error(`project source "${sourceId}" is not active`)
        const normalized = normalizeProjectSource(sourceId, next)
        if (normalized.signature === entry.signature) return
        entry = normalized
        this.sources.set(sourceId, entry)
        this.emitChanged()
      },
      dispose: async () => dispose(),
    }
  }

  /**
   * Copies projects discovered by another application into Alto's registry.
   * Existing imports are deliberately left untouched so names and roots edited
   * in Alto do not get reset the next time the source application writes state.
   */
  async importProjects(
    source: string,
    projects: LocalProject[],
  ): Promise<Map<string, string>> {
    const sourceId = projectSourceId(source)
    const sourceIds = new Set<string>()
    const discovered = projects.map((project) => {
      const sourceProjectId = project.id.trim()
      if (!sourceProjectId) throw new Error(`project source "${sourceId}" contains a project without an id`)
      if (sourceIds.has(sourceProjectId)) {
        throw new Error(`project source "${sourceId}" contains duplicate project id "${sourceProjectId}"`)
      }
      sourceIds.add(sourceProjectId)
      const primaryRoot = normalizeRoot(project.primaryRoot)
      return {
        sourceProjectId,
        name: projectName(project.name),
        primaryRoot,
        roots: uniqueRoots(primaryRoot, project.roots),
      }
    })

    const nextProjects = this.projects.map((project) => structuredClone(project))
    const nextImports = new Map(this.imports)
    const canonicalOwners = new Map<string, string>()
    const ownedRoots = await Promise.all(nextProjects.flatMap((project) => (
      project.roots.map(async (root) => [await canonicalRoot(root), project.id] as const)
    )))
    for (const [root, projectId] of ownedRoots) canonicalOwners.set(root, projectId)

    const imported = new Map<string, string>()
    let changed = false
    for (const project of discovered) {
      const key = projectImportKey(sourceId, project.sourceProjectId)
      const previous = nextImports.get(key)
      if (previous) {
        // A missing target is a tombstone left by removing an imported workspace.
        // Keep it so a later source refresh does not silently recreate the workspace.
        if (nextProjects.some((candidate) => candidate.id === previous.projectId)) {
          imported.set(project.sourceProjectId, previous.projectId)
        }
        continue
      }

      let projectId: string | undefined
      for (const root of project.roots) {
        projectId ??= canonicalOwners.get(await canonicalRoot(root))
      }
      if (!projectId) {
        projectId = randomUUID()
        nextProjects.push({
          id: projectId,
          name: project.name,
          primaryRoot: project.primaryRoot,
          roots: project.roots,
        })
        for (const root of project.roots) {
          canonicalOwners.set(await canonicalRoot(root), projectId)
        }
      }

      nextImports.set(key, {
        source: sourceId,
        sourceProjectId: project.sourceProjectId,
        projectId,
      })
      imported.set(project.sourceProjectId, projectId)
      changed = true
    }

    if (changed) await this.commit(nextProjects, nextImports)
    return imported
  }

  async save(input: LocalProjectInput): Promise<ProjectSnapshot> {
    const primaryRoot = normalizeRoot(input.primaryRoot)
    const roots = uniqueRoots(primaryRoot, input.roots)
    await Promise.all(roots.map(directory))

    const id = input.id?.trim() || randomUUID()
    if (this.externalProject(id)) {
      throw new Error('workspaces from an external source must be edited in that app')
    }
    const project: LocalProject = {
      id,
      name: projectName(input.name),
      primaryRoot,
      roots,
    }
    const duplicate = this.allProjects().find((candidate) => (
      candidate.id !== id
      && candidate.roots.some((root) => roots.includes(root))
    ))
    if (duplicate) throw new Error(`that folder already belongs to ${duplicate.name}`)

    const index = this.projects.findIndex((candidate) => candidate.id === id)
    const next = this.projects.map((candidate) => structuredClone(candidate))
    if (index >= 0) next[index] = project
    else next.push(project)
    await this.commit(next)
    return this.snapshot()
  }

  async remove(id: string): Promise<ProjectSnapshot> {
    if (this.externalProject(id)) {
      throw new Error('workspaces from an external source must be removed in that app')
    }
    const next = this.projects.filter((project) => project.id !== id)
    if (next.length === this.projects.length) throw new Error(`unknown project: ${id}`)
    await this.commit(next)
    return this.snapshot()
  }

  async classifyThreads(threads: ThreadSummary[]): Promise<ThreadSummary[]> {
    const assignments = new Map<string, string>()
    const unassigned = new Set<string>()
    for (const source of this.sources.values()) {
      for (const [threadId, projectId] of source.threadProjectIds) {
        if (!assignments.has(threadId)) assignments.set(threadId, projectId)
      }
      for (const threadId of source.unassignedThreadIds) unassigned.add(threadId)
    }
    const projects = this.allProjects()
    const validProjectIds = new Set(projects.map((project) => project.id))
    const importedProject = (thread: ThreadSummary): string | undefined => {
      const reference = thread.projectRef
      if (!reference) return undefined
      const projectId = this.imports.get(projectImportKey(reference.source, reference.id))?.projectId
      return projectId && validProjectIds.has(projectId) ? projectId : undefined
    }
    const assignedProject = (threadId: string): string | undefined => {
      const projectId = assignments.get(threadId)
      return projectId && validProjectIds.has(projectId) ? projectId : undefined
    }
    const workspaces = [...new Set(threads
      .filter((thread) => (
        !importedProject(thread)
        && !assignedProject(thread.id)
        && !unassigned.has(thread.id)
      ))
      .map((thread) => thread.cwd)
      .filter(Boolean))]
    const projectIds = new Map<string, string | undefined>()
    let cursor = 0
    const classifyNext = async (): Promise<void> => {
      while (cursor < workspaces.length) {
        const workspace = workspaces[cursor++]
        if (workspace) projectIds.set(workspace, await this.projectIdFor(workspace, projects))
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(GIT_CONCURRENCY, workspaces.length) },
      classifyNext,
    ))

    return threads.map((thread) => {
      const { projectId: _projectId, ...summary } = thread
      // App Server's projectId describes the task's canonical Codex project.
      // Local sidebar assignments are a fallback for older tasks, not an
      // override for metadata supplied by the task itself.
      const canonicalProjectId = importedProject(thread)
      const projectId = canonicalProjectId ?? (unassigned.has(thread.id)
        ? undefined
        : assignedProject(thread.id) ?? projectIds.get(thread.cwd))
      return projectId ? { ...summary, projectId } : summary
    })
  }

  private async projectIdFor(
    workspace: string,
    projects: LocalProject[],
  ): Promise<string | undefined> {
    const direct = directlyMatchingProject(projects, workspace)
    if (direct) return direct.id

    const candidateCommonDir = await this.gitCommonDir(workspace)
    if (!candidateCommonDir) return undefined
    for (const project of projects) {
      for (const root of project.roots) {
        if (await this.gitCommonDir(root) === candidateCommonDir) return project.id
      }
    }
    return undefined
  }

  private gitCommonDir(workspace: string): Promise<string | undefined> {
    const key = path.resolve(workspace)
    const cached = this.gitCommonDirs.get(key)
    if (cached) return cached
    const pending = gitPath(key, '--git-common-dir')
    this.gitCommonDirs.set(key, pending)
    return pending
  }

  private allProjects(): LocalProject[] {
    const external = [...this.sources.values()].flatMap((source) => source.projects)
    const externalRoots = new Set(external.flatMap((project) => project.roots))
    const local = this.projects.filter((project) => !externalRoots.has(project.primaryRoot))
    return [...external, ...local]
  }

  private externalProject(id: string): LocalProject | undefined {
    for (const source of this.sources.values()) {
      const project = source.projects.find((candidate) => candidate.id === id)
      if (project) return project
    }
    return undefined
  }

  private emitChanged(): void {
    this.revision += 1
    this.root.emit('projects/changed', this.snapshot())
  }

  private async commit(
    projects: LocalProject[],
    imports = this.imports,
  ): Promise<void> {
    const previousProjects = this.projects
    const previousImports = this.imports
    const previousRevision = this.revision
    this.projects = projects
    this.imports = imports
    this.revision += 1
    try {
      await this.persist()
    } catch (error) {
      this.projects = previousProjects
      this.imports = previousImports
      this.revision = previousRevision
      throw error
    }
    this.root.emit('projects/changed', this.snapshot())
  }

  private async persist(): Promise<void> {
    const document: ProjectFile = {
      version: PROJECT_FILE_VERSION,
      revision: this.revision,
      projects: this.projects,
      imports: [...this.imports.values()],
    }
    const operation = async (): Promise<void> => {
      await mkdir(path.dirname(this.statePath), { recursive: true })
      const temporary = `${this.statePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
        await rename(temporary, this.statePath)
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    }
    this.writeQueue = this.writeQueue.then(operation, operation)
    await this.writeQueue
  }
}

export const projectRegistryPlugin: Plugin<ProjectRegistryOptions> = async (
  ctx: Context,
  options: ProjectRegistryOptions,
) => {
  const registry = new ProjectRegistry(ctx.root, options)
  ctx.provide('projects', registry)
  await registry.start()
}

projectRegistryPlugin.provide = 'projects'

declare module 'cordis' {
  interface Events {
    'projects/changed'(snapshot: ProjectSnapshot): void
  }
}
