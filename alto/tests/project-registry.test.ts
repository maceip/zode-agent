import { execFile } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Context, type Plugin } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadSummary } from '../src/shared/protocol.js'
import {
  ProjectRegistry,
  projectRegistryPlugin,
  type ProjectSourceRegistration,
} from '../src/server/services/project-registry.js'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

function thread(id: string, cwd: string): ThreadSummary {
  return {
    id,
    title: id,
    preview: id,
    cwd,
    createdAt: 1,
    updatedAt: 1,
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-cordis-projects-'))
  temporaryDirectories.push(root)
  return root
}

describe('project registry', () => {
  it('persists named projects and classifies attached folders', async () => {
    const root = await temporaryRoot()
    const related = path.join(root, 'related')
    const nested = path.join(related, 'docs')
    await mkdir(nested, { recursive: true })

    const registry = new ProjectRegistry(new Context(), { projectRoot: root })
    await registry.start()
    const saved = await registry.save({
      name: 'Related work',
      primaryRoot: related,
      roots: [related],
    })
    const relatedProject = saved.projects.find((project) => project.name === 'Related work')
    expect(relatedProject).toBeDefined()

    const [classified] = await registry.classifyThreads([thread('thread-1', nested)])
    expect(classified?.projectId).toBe(relatedProject?.id)

    const reloaded = new ProjectRegistry(new Context(), { projectRoot: root })
    await reloaded.start()
    expect(reloaded.snapshot()).toEqual(saved)
  })

  it('maps a Git worktree back to the project containing its primary repository', async () => {
    const root = await temporaryRoot()
    const repository = path.join(root, 'repository')
    const worktree = path.join(root, 'feature-worktree')
    await execFileAsync('git', ['init', repository])
    await writeFile(path.join(repository, 'README.md'), '# test\n')
    await execFileAsync('git', ['-C', repository, 'add', 'README.md'])
    await execFileAsync('git', [
      '-C', repository,
      '-c', 'user.name=Alto',
      '-c', 'user.email=codex-cordis@example.invalid',
      'commit', '-m', 'initial',
    ])
    await execFileAsync('git', ['-C', repository, 'worktree', 'add', '-b', 'feature', worktree])

    const registry = new ProjectRegistry(new Context(), { projectRoot: repository })
    await registry.start()
    const project = registry.snapshot().projects[0]
    const [classified] = await registry.classifyThreads([thread('thread-1', worktree)])

    expect(classified?.projectId).toBe(project?.id)
  })

  it('owns external workspace sources by fiber and honors their thread assignments', async () => {
    const root = await temporaryRoot()
    const desktopRoot = path.join(root, 'desktop-project')
    const nested = path.join(desktopRoot, 'packages', 'app')
    await mkdir(nested, { recursive: true })

    const ctx = new Context()
    const registryFiber = await ctx.plugin(projectRegistryPlugin, { projectRoot: root })
    let registration: ProjectSourceRegistration | undefined
    const source: Plugin = (owner) => {
      registration = owner.projects.registerSource(owner, 'codex-app', {
        projects: [{
          id: 'desktop-1',
          name: 'Desktop project',
          primaryRoot: desktopRoot,
          roots: [desktopRoot],
        }],
        threadProjectIds: { assigned: 'desktop-1' },
        unassignedThreadIds: ['projectless'],
      })
    }
    source.inject = ['projects']

    const sourceFiber = await ctx.plugin(source)
    const imported = ctx.projects.snapshot().projects.find((project) => project.source === 'codex-app')
    expect(imported).toMatchObject({
      id: 'codex-app:desktop-1',
      name: 'Desktop project',
      primaryRoot: desktopRoot,
    })

    const [assigned, projectless, inferred] = await ctx.projects.classifyThreads([
      thread('assigned', root),
      thread('projectless', nested),
      thread('inferred', nested),
    ])
    expect(assigned?.projectId).toBe(imported?.id)
    expect(projectless?.projectId).toBeUndefined()
    expect(inferred?.projectId).toBe(imported?.id)

    registration?.update({
      projects: [{
        id: 'desktop-1',
        name: 'Renamed in Desktop',
        primaryRoot: desktopRoot,
        roots: [desktopRoot],
      }],
    })
    expect(ctx.projects.snapshot().projects.find((project) => project.id === imported?.id)?.name)
      .toBe('Renamed in Desktop')

    await sourceFiber.dispose()
    expect(ctx.projects.snapshot().projects.some((project) => project.source === 'codex-app')).toBe(false)
    await registryFiber.dispose()
  })

  it('copies imported projects into Alto state without overwriting later edits', async () => {
    const root = await temporaryRoot()
    const desktopRoot = path.join(root, 'desktop-project')
    await mkdir(desktopRoot)

    const statePath = path.join(root, 'alto-state', 'projects.json')
    const registry = new ProjectRegistry(new Context(), { projectRoot: root, statePath })
    await registry.start()
    const first = await registry.importProjects('codex-app', [{
      id: 'desktop-1',
      name: 'Desktop project',
      primaryRoot: desktopRoot,
      roots: [desktopRoot],
    }])
    const importedId = first.get('desktop-1')
    if (!importedId) throw new Error('expected imported project id')
    expect(registry.snapshot().projects.find((project) => project.id === importedId)).toMatchObject({
      name: 'Desktop project',
      primaryRoot: desktopRoot,
    })
    expect(registry.snapshot().projects.find((project) => project.id === importedId)?.source).toBeUndefined()

    await registry.save({
      id: importedId,
      name: 'My Alto name',
      primaryRoot: desktopRoot,
      roots: [desktopRoot],
    })
    const second = await registry.importProjects('codex-app', [{
      id: 'desktop-1',
      name: 'Renamed in Desktop',
      primaryRoot: desktopRoot,
      roots: [desktopRoot],
    }])
    expect(second).toEqual(new Map([['desktop-1', importedId]]))
    expect(registry.snapshot().projects.find((project) => project.id === importedId)?.name)
      .toBe('My Alto name')

    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      version: number
      imports: ProjectImportFixture[]
    }
    expect(persisted.version).toBe(2)
    expect(persisted.imports).toContainEqual({
      source: 'codex-app',
      sourceProjectId: 'desktop-1',
      projectId: importedId,
    })

    const reloaded = new ProjectRegistry(new Context(), { projectRoot: root, statePath })
    await reloaded.start()
    expect(await reloaded.importProjects('codex-app', [{
      id: 'desktop-1',
      name: 'Desktop again',
      primaryRoot: desktopRoot,
      roots: [desktopRoot],
    }])).toEqual(new Map([['desktop-1', importedId]]))
    expect(reloaded.snapshot().projects.find((project) => project.id === importedId)?.name)
      .toBe('My Alto name')
  })

  it('prefers an App Server project id over cwd-based classification', async () => {
    const root = await temporaryRoot()
    const desktopRoot = path.join(root, 'desktop-project')
    await mkdir(desktopRoot)
    const registry = new ProjectRegistry(new Context(), { projectRoot: root })
    await registry.start()
    const imported = await registry.importProjects('codex-app', [{
      id: 'desktop-1',
      name: 'Desktop project',
      primaryRoot: desktopRoot,
      roots: [desktopRoot],
    }])
    const importedId = imported.get('desktop-1')
    if (!importedId) throw new Error('expected imported project id')

    const [classified] = await registry.classifyThreads([{
      ...thread('thread-1', root),
      projectRef: { source: 'codex-app', id: 'desktop-1' },
    }])

    expect(classified?.projectId).toBe(importedId)
  })

  it('upgrades a version-one registry when Codex workspaces are first imported', async () => {
    const root = await temporaryRoot()
    const desktopRoot = path.join(root, 'desktop-project')
    await mkdir(desktopRoot)
    const statePath = path.join(root, 'alto-state', 'projects.json')
    await mkdir(path.dirname(statePath), { recursive: true })
    await writeFile(statePath, `${JSON.stringify({
      version: 1,
      revision: 7,
      projects: [{
        id: 'existing-project',
        name: 'Existing project',
        primaryRoot: desktopRoot,
        roots: [desktopRoot],
      }],
    })}\n`)

    const registry = new ProjectRegistry(new Context(), { projectRoot: root, statePath })
    await registry.start()
    expect(await registry.importProjects('codex-app', [{
      id: 'desktop-1',
      name: 'Desktop project',
      primaryRoot: desktopRoot,
      roots: [desktopRoot],
    }])).toEqual(new Map([['desktop-1', 'existing-project']]))

    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      version: number
      imports: ProjectImportFixture[]
    }
    expect(persisted.version).toBe(2)
    expect(persisted.imports).toContainEqual({
      source: 'codex-app',
      sourceProjectId: 'desktop-1',
      projectId: 'existing-project',
    })
  })

  it('can assign source-owned threads to imported local projects', async () => {
    const root = await temporaryRoot()
    const desktopRoot = path.join(root, 'desktop-project')
    await mkdir(desktopRoot)

    const ctx = new Context()
    const registryFiber = await ctx.plugin(projectRegistryPlugin, { projectRoot: root })
    const imported = await ctx.projects.importProjects('codex-app', [{
      id: 'desktop-1',
      name: 'Desktop project',
      primaryRoot: desktopRoot,
      roots: [desktopRoot],
    }])
    const importedId = imported.get('desktop-1')
    if (!importedId) throw new Error('expected imported project id')
    const source: Plugin = (owner) => {
      owner.projects.registerSource(owner, 'codex-thread-assignments', {
        projects: [],
        localThreadProjectIds: { assigned: importedId },
      })
    }
    source.inject = ['projects']
    const sourceFiber = await ctx.plugin(source)

    const [assigned] = await ctx.projects.classifyThreads([thread('assigned', root)])
    expect(assigned?.projectId).toBe(importedId)

    await sourceFiber.dispose()
    await registryFiber.dispose()
  })
})

interface ProjectImportFixture {
  source: string
  sourceProjectId: string
  projectId: string
}
