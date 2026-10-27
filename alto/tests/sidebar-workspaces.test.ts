import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, type Plugin } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installCodexWorkspaceSource,
  parseCodexWorkspaceState,
} from '../program/plugins/sidebar/codex-workspaces.js'
import { projectRegistryPlugin } from '../src/server/services/project-registry.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('Codex Desktop workspace import', () => {
  it('preserves Desktop names, ordering, attached roots, and thread grouping', () => {
    const snapshot = parseCodexWorkspaceState({
      'local-projects': {
        alpha: {
          id: 'alpha',
          name: 'Alpha',
          rootPaths: ['/work/alpha', '/work/alpha-docs'],
        },
        beta: {
          id: 'beta',
          name: 'Beta',
          rootPaths: ['/work/beta'],
        },
      },
      'project-order': ['beta', 'alpha'],
      'thread-project-assignments': {
        'thread-1': { projectKind: 'local', projectId: 'alpha', cwd: '/tmp/worktree' },
        'thread-2': { projectKind: 'remote', projectId: 'beta' },
        'thread-3': { projectKind: 'local', projectId: 'missing' },
      },
      'projectless-thread-ids': ['thread-4'],
    })

    expect(snapshot.projects).toEqual([
      {
        id: 'beta',
        name: 'Beta',
        primaryRoot: '/work/beta',
        roots: ['/work/beta'],
      },
      {
        id: 'alpha',
        name: 'Alpha',
        primaryRoot: '/work/alpha',
        roots: ['/work/alpha', '/work/alpha-docs'],
      },
    ])
    expect(snapshot.threadProjectIds).toEqual({ 'thread-1': 'alpha' })
    expect(snapshot.unassignedThreadIds).toEqual(['thread-4'])
  })

  it('falls back to the older saved-root representation', () => {
    const snapshot = parseCodexWorkspaceState({
      'local-projects': {},
      'electron-saved-workspace-roots': ['/work/one'],
      'electron-workspace-root-labels': { '/work/one': 'One' },
    })

    expect(snapshot.projects).toEqual([expect.objectContaining({
      name: 'One',
      primaryRoot: '/work/one',
      roots: ['/work/one'],
    })])
  })

  it('rejects unrelated private-state shapes instead of clearing a good import', () => {
    expect(() => parseCodexWorkspaceState({ settings: {} }))
      .toThrow('does not contain a workspace registry')
  })

  it('copies discovered workspaces into Alto and retains Desktop task assignments', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-codex-workspaces-'))
    temporaryDirectories.push(root)
    const desktopRoot = path.join(root, 'desktop-project')
    await mkdir(desktopRoot)
    const codexStatePath = path.join(root, 'codex-state.json')
    const altoStatePath = path.join(root, 'alto-state', 'projects.json')
    await writeFile(codexStatePath, JSON.stringify({
      'local-projects': {
        desktop: {
          id: 'desktop',
          name: 'From Codex',
          rootPaths: [desktopRoot],
        },
      },
      'thread-project-assignments': {
        assigned: { projectKind: 'local', projectId: 'desktop' },
      },
    }))

    const ctx = new Context()
    const registryFiber = await ctx.plugin(projectRegistryPlugin, {
      projectRoot: root,
      statePath: altoStatePath,
    })
    const importer: Plugin = (owner) => {
      installCodexWorkspaceSource(owner, { codexStatePath })
    }
    importer.inject = ['projects']
    const importerFiber = await ctx.plugin(importer)

    await vi.waitFor(() => {
      expect(ctx.projects.snapshot().projects.some((project) => project.name === 'From Codex')).toBe(true)
    })
    const imported = ctx.projects.snapshot().projects.find((project) => project.name === 'From Codex')
    expect(imported?.source).toBeUndefined()
    const [assigned] = await ctx.projects.classifyThreads([{
      id: 'assigned',
      title: 'Assigned',
      preview: '',
      cwd: root,
      createdAt: 1,
      updatedAt: 1,
    }])
    expect(assigned?.projectId).toBe(imported?.id)

    const persisted = JSON.parse(await readFile(altoStatePath, 'utf8')) as {
      imports: Array<{ source: string; sourceProjectId: string; projectId: string }>
    }
    expect(persisted.imports).toContainEqual({
      source: 'codex-app',
      sourceProjectId: 'desktop',
      projectId: imported?.id,
    })

    await importerFiber.dispose()
    expect(ctx.projects.snapshot().projects.some((project) => project.id === imported?.id)).toBe(true)
    await registryFiber.dispose()
  })
})
