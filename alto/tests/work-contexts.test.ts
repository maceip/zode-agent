import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Context, type Plugin } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  createLocalGitWorktree,
  discoverLocalCheckouts,
  groupWorkstreams,
  localExecutionContext,
  parseGitWorktrees,
  parseWorkTargetFile,
  remoteExecutionContext,
  switchLocalGitBranch,
  WorkContextRegistry,
} from '../program/plugins/work-contexts.js'

const execFileAsync = promisify(execFile)

describe('work contexts', () => {
  it('creates and reuses a sibling worktree for a branch', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'alto-worktree-'))
    const repository = path.join(temporary, 'repo')
    try {
      await mkdir(repository)
      await execFileAsync('git', ['init', '-b', 'main', repository])
      await writeFile(path.join(repository, 'README.md'), '# test\n', 'utf8')
      await execFileAsync('git', ['-C', repository, 'add', 'README.md'])
      await execFileAsync('git', [
        '-C', repository,
        '-c', 'user.name=Alto Tests',
        '-c', 'user.email=alto-tests@example.com',
        'commit', '-m', 'initial',
      ])

      const created = await createLocalGitWorktree(repository, 'feature/parallel')
      const resolvedTemporary = await realpath(temporary)
      expect(created).toEqual({
        branch: 'feature/parallel',
        location: path.join(resolvedTemporary, 'repo-feature-parallel'),
        created: true,
      })
      const { stdout } = await execFileAsync('git', ['-C', created.location, 'branch', '--show-current'])
      expect(stdout.trim()).toBe('feature/parallel')

      await expect(createLocalGitWorktree(repository, 'feature/parallel')).resolves.toEqual({
        branch: 'feature/parallel',
        location: created.location,
        created: false,
      })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('creates a new worktree from the requested Git base instead of checkout HEAD', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'alto-worktree-base-'))
    const repository = path.join(temporary, 'repo')
    try {
      await mkdir(repository)
      await execFileAsync('git', ['init', '-b', 'main', repository])
      await writeFile(path.join(repository, 'README.md'), 'base\n', 'utf8')
      await execFileAsync('git', ['-C', repository, 'add', 'README.md'])
      await execFileAsync('git', [
        '-C', repository,
        '-c', 'user.name=Alto Tests',
        '-c', 'user.email=alto-tests@example.com',
        'commit', '-m', 'base',
      ])
      await execFileAsync('git', ['-C', repository, 'branch', 'stable-base'])
      await writeFile(path.join(repository, 'README.md'), 'new head\n', 'utf8')
      await execFileAsync('git', ['-C', repository, 'add', 'README.md'])
      await execFileAsync('git', [
        '-C', repository,
        '-c', 'user.name=Alto Tests',
        '-c', 'user.email=alto-tests@example.com',
        'commit', '-m', 'new head',
      ])

      const created = await createLocalGitWorktree(repository, 'feature/from-base', 'stable-base')
      await expect(readFile(path.join(created.location, 'README.md'), 'utf8')).resolves.toBe('base\n')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('creates a branch in the existing checkout without moving its changes', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'alto-checkout-branch-'))
    const repository = path.join(temporary, 'repo')
    try {
      await mkdir(repository)
      await execFileAsync('git', ['init', '-b', 'main', repository])
      await writeFile(path.join(repository, 'README.md'), '# initial\n', 'utf8')
      await execFileAsync('git', ['-C', repository, 'add', 'README.md'])
      await execFileAsync('git', [
        '-C', repository,
        '-c', 'user.name=Alto Tests',
        '-c', 'user.email=alto-tests@example.com',
        'commit', '-m', 'initial',
      ])
      await writeFile(path.join(repository, 'README.md'), '# changed\n', 'utf8')

      await expect(switchLocalGitBranch(repository, 'feature/in-place')).resolves.toMatchObject({
        branch: 'feature/in-place',
        location: repository,
        created: true,
      })
      const [{ stdout: branch }, { stdout: status }] = await Promise.all([
        execFileAsync('git', ['-C', repository, 'branch', '--show-current']),
        execFileAsync('git', ['-C', repository, 'status', '--porcelain=v1']),
      ])
      expect(branch.trim()).toBe('feature/in-place')
      expect(status).toContain('README.md')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('parses branch and detached git worktrees', () => {
    const parsed = parseGitWorktrees(`worktree /tmp/repo
HEAD 0123456789abcdef
branch refs/heads/main

worktree /tmp/repo-fix
HEAD fedcba9876543210
detached
`)

    expect(parsed).toEqual([
      {
        path: '/tmp/repo',
        head: '0123456789abcdef',
        branch: 'refs/heads/main',
        detached: false,
        bare: false,
      },
      {
        path: '/tmp/repo-fix',
        head: 'fedcba9876543210',
        detached: true,
        bare: false,
      },
    ])
  })

  it('discovers a repository topology once when project roots are sibling worktrees', async () => {
    const calls: Array<{ cwd: string; args: string[] }> = []
    const readGit = async (cwd: string, args: string[]): Promise<string | undefined> => {
      calls.push({ cwd, args })
      if (args.join(' ') === 'worktree list --porcelain') return `worktree /tmp/repo
HEAD 0123456789abcdef
branch refs/heads/main

worktree /tmp/repo-feature
HEAD fedcba9876543210
branch refs/heads/feature
`
      if (args.join(' ') === 'remote get-url origin') return 'git@github.com:example/repo.git'
      if (args.join(' ') === 'status --porcelain=v1') return ''
      return undefined
    }

    const checkouts = await discoverLocalCheckouts({
      id: 'repo',
      name: 'repo',
      primaryRoot: '/tmp/repo',
      roots: ['/tmp/repo', '/tmp/repo-feature'],
    }, readGit)

    expect(checkouts).toHaveLength(2)
    expect(calls.filter(({ args }) => args[0] === 'worktree')).toHaveLength(1)
    expect(calls.filter(({ args }) => args[0] === 'remote')).toHaveLength(1)
    expect(calls.filter(({ args }) => args[0] === 'status')).toHaveLength(0)
    expect(checkouts.every((checkout) => checkout.dirty === undefined)).toBe(true)
  })

  it('groups local and provider checkouts by project and branch', () => {
    const grouped = groupWorkstreams([
      {
        id: 'remote',
        kind: 'cloud-runner',
        projectId: 'atlas',
        branch: 'fix/replay',
        label: 'atlas-replay-1',
        location: 'atlas-replay-1',
        status: 'Running',
      },
      {
        id: 'local',
        kind: 'local',
        projectId: 'atlas',
        branch: 'fix/replay',
        label: 'atlas-replay',
        location: '/tmp/atlas-replay',
        repository: 'github.com/example/atlas',
        primary: true,
      },
      {
        id: 'other',
        kind: 'local',
        projectId: 'atlas',
        branch: 'audit/rng',
        label: 'atlas-audit',
        location: '/tmp/atlas-audit',
      },
    ])

    expect(grouped).toHaveLength(2)
    expect(grouped.find((stream) => stream.branch === 'fix/replay')).toMatchObject({
      projectId: 'atlas',
      repository: 'github.com/example/atlas',
      checkouts: [
        { id: 'local', kind: 'local' },
        { id: 'remote', kind: 'cloud-runner' },
      ],
    })
  })

  it('registers an arbitrary remote provider without changing the registry', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'alto-provider-'))
    const root = new Context()
    const registry = new WorkContextRegistry({
      program: { projectRoot: temporary },
    } as Context)
    const source = {
      id: 'local-atlas',
      kind: 'local',
      projectId: 'atlas',
      branch: 'main',
      label: 'atlas',
      location: '/tmp/atlas',
    }
    const plugin: Plugin = (ctx) => {
      registry.registerSource(ctx, 'local-fixture', { checkouts: [source] })
      registry.registerProvider(ctx, {
        id: 'cloud-runner',
        label: 'Cloud Runner',
        description: 'Runs a branch in an isolated remote checkout.',
        createTarget: async ({ source: selected }) => ({
          ...selected,
          id: 'cloud-atlas-main',
          kind: 'cloud-runner',
          label: 'atlas-main-remote',
          location: 'atlas-main-remote',
        }),
      })
    }

    const fiber = await root.plugin(plugin)
    try {
      expect(registry.snapshot().providers).toEqual([{
        id: 'cloud-runner',
        label: 'Cloud Runner',
        description: 'Runs a branch in an isolated remote checkout.',
        supportsExistingTarget: true,
        supportsBranchTarget: false,
      }])
      const target = await registry.createProviderTarget(
        'cloud-runner',
        'thread-1',
        source.id,
      )
      expect(target.kind).toBe('cloud-runner')
      expect(registry.targetForThread('thread-1')).toMatchObject({
        checkoutId: 'cloud-atlas-main',
        kind: 'cloud-runner',
      })
    } finally {
      await fiber.dispose()
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('persists a concrete branch and checkout per chat', () => {
    const targets = parseWorkTargetFile({
      version: 1,
      threadTargets: {
        'thread-1': {
          id: 'local-fix',
          checkoutId: 'local-fix',
          kind: 'local',
          projectId: 'atlas',
          branch: 'fix/replay',
          label: 'atlas-fix',
          location: '/tmp/atlas-fix',
          dirty: true,
          updatedAt: '2026-08-21T20:00:00Z',
        },
        malformed: { kind: 'local' },
      },
    })

    expect(targets).toEqual({
      'thread-1': expect.objectContaining({
        checkoutId: 'local-fix',
        kind: 'local',
        branch: 'fix/replay',
        location: '/tmp/atlas-fix',
        dirty: true,
      }),
    })
    expect(localExecutionContext(targets['thread-1']!)).toContain(
      'Use this checkout for repository reads, edits, commands, tests, and git operations',
    )
  })

  it('never silently falls back when a remote provider is unavailable', () => {
    expect(remoteExecutionContext({
      id: 'cloud-fix',
      checkoutId: 'cloud-fix',
      kind: 'cloud-runner',
      projectId: 'atlas',
      branch: 'fix/replay',
      label: 'atlas-fix',
      location: 'atlas-fix',
      updatedAt: '2026-08-21T20:00:00Z',
    })).toContain('report that instead of silently falling back to local execution')
  })
})
