import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, type Plugin } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  nextScheduledRun,
  parseScheduledPersistence,
  ScheduledTaskRegistry,
} from '../program/plugins/scheduled.js'
import type {
  ScheduledProviderTask,
  ScheduledTargetProvider,
} from '../program/plugins/scheduled-api.js'

function task(overrides: Partial<ScheduledProviderTask> = {}): ScheduledProviderTask {
  return {
    id: 'task-1234',
    name: 'Review pull requests',
    prompt: 'Review every open pull request and leave actionable feedback.',
    target: 'local',
    sourceCheckoutId: 'checkout-main',
    projectId: 'wallet',
    workspace: '/tmp/wallet',
    branch: 'main',
    repository: 'git@github.com:example/wallet.git',
    cron: '0 9 * * 1-5',
    timezone: 'UTC',
    permissionMode: 'auto',
    enabled: true,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  }
}

function registryContext(): Context {
  return {
    clientExtensions: {
      registerState: () => ({ update: vi.fn(), dispose: vi.fn() }),
    },
    projects: {
      snapshot: () => ({
        projects: [{ id: 'wallet', primaryRoot: '/tmp/wallet' }],
      }),
    },
    workContexts: {
      refresh: async () => ({
        workstreams: [{
          checkouts: [{
            id: 'wallet-main',
            kind: 'local',
            projectId: 'wallet',
            location: '/tmp/wallet',
            branch: 'main',
            repository: 'git@github.com:example/wallet.git',
            primary: true,
          }],
        }],
      }),
    },
    codex: {
      snapshot: () => ({ defaults: {} }),
      startThread: vi.fn(async () => ({ thread: { id: 'scheduled-thread' } })),
      setThreadName: vi.fn(async () => undefined),
      startTurn: vi.fn(async () => undefined),
      threadSummary: vi.fn(async (threadId: string) => ({
        id: threadId,
        title: 'New chat',
        preview: '',
        cwd: '/tmp/alto',
        createdAt: 1,
        updatedAt: 1,
      })),
    },
    program: {
      projectRoot: '/tmp/alto',
    },
  } as unknown as Context
}

function provider(id: string) {
  const create = vi.fn(async () => undefined)
  const update = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const setEnabled = vi.fn(async () => undefined)
  const run = vi.fn(async () => ({ message: `${id} ran` }))
  const value: ScheduledTargetProvider = {
    descriptor: {
      id,
      label: `${id} runner`,
      description: `Runs on ${id}.`,
      icon: 'cloud',
      supportsCustomCron: true,
      supportsPermissionMode: false,
      timezoneMode: 'utc',
    },
    prepare: () => ({ secret: `${id}-secret` }),
    create,
    update,
    remove,
    setEnabled,
    run,
  }
  return { value, create, update, remove, setEnabled, run }
}

async function withRegistry(
  operation: (registry: ScheduledTaskRegistry, file: string, ctx: Context) => Promise<void>,
): Promise<void> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'alto-scheduled-'))
  const file = path.join(temporary, 'state', 'tasks.json')
  const ctx = registryContext()
  const registry = new ScheduledTaskRegistry(ctx, file)
  try {
    await registry.start(new Context())
    await operation(registry, file, ctx)
  } finally {
    registry.stop()
    await rm(temporary, { recursive: true, force: true })
  }
}

describe('scheduled tasks', () => {
  it('computes the next run in the task timezone', () => {
    expect(nextScheduledRun(
      '0 9 * * 1-5',
      'America/Los_Angeles',
      new Date('2026-08-28T15:00:00.000Z'),
    )).toBe('2026-08-28T16:00:00.000Z')
  })

  it('rejects invalid cron expressions and timezones', () => {
    expect(() => nextScheduledRun('not a schedule', 'UTC')).toThrow()
    expect(() => nextScheduledRun('0 9 * * *', 'Mars/Olympus')).toThrow('valid timezone')
  })

  it('keeps valid persisted tasks and ignores malformed entries', () => {
    expect(parseScheduledPersistence({
      version: 2,
      tasks: [task(), { id: 'broken' }],
    }).tasks).toEqual([task()])
    expect(parseScheduledPersistence({ version: 3, tasks: [task()] }).tasks).toEqual([])
  })

  it('keeps tasks that intentionally have no workspace', () => {
    const unscoped = task()
    delete unscoped.sourceCheckoutId
    delete unscoped.projectId
    delete unscoped.workspace
    delete unscoped.branch
    delete unscoped.repository

    expect(parseScheduledPersistence({ version: 2, tasks: [unscoped] }).tasks)
      .toEqual([unscoped])
  })

  it('leaves legacy provider metadata opaque for the provider to migrate', () => {
    const legacy = {
      ...task({ target: 'remote' }),
      remoteReference: 'legacy-task',
      remoteCron: '0 16 * * 1-5',
    }

    const parsed = parseScheduledPersistence({ version: 1, tasks: [legacy] }).tasks[0]
    expect(parsed?.providerState).toBeUndefined()
    expect(parsed?.legacyState).toMatchObject({
      remoteReference: 'legacy-task',
      remoteCron: '0 16 * * 1-5',
    })
  })

  it('never exposes provider state in browser snapshots', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'alto-scheduled-state-'))
    const file = path.join(temporary, 'tasks.json')
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [task({ target: 'remote', providerState: { token: 'do-not-send' } })],
    }))
    const registry = new ScheduledTaskRegistry(registryContext(), file)
    try {
      await registry.start(new Context())
      expect(registry.snapshot().tasks[0]).not.toHaveProperty('providerState')
      expect(JSON.stringify(registry.snapshot())).not.toContain('do-not-send')
    } finally {
      registry.stop()
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('rolls back a newly created target when removing the old target fails', async () => {
    await withRegistry(async (registry) => {
      const first = provider('first')
      const second = provider('second')
      const root = new Context()
      const registration: Plugin = async (ctx) => {
        await registry.registerTarget(ctx, first.value)
        await registry.registerTarget(ctx, second.value)
      }
      const fiber = await root.plugin(registration)
      try {
        const saved = await registry.save({
          name: 'Remote task', prompt: 'Run it', target: 'first', projectId: 'wallet',
          cron: '0 9 * * *', timezone: 'UTC', permissionMode: 'auto', enabled: true,
        })
        first.remove.mockRejectedValueOnce(new Error('old provider failed'))
        await expect(registry.save({
          id: saved.id, name: saved.name, prompt: saved.prompt, target: 'second',
          projectId: 'wallet', cron: saved.cron, timezone: 'UTC',
          permissionMode: 'auto', enabled: true,
        })).rejects.toThrow('old provider failed')
        expect(second.create).toHaveBeenCalledTimes(1)
        expect(second.remove).toHaveBeenCalledTimes(1)
        expect(registry.snapshot().tasks[0]?.target).toBe('first')
      } finally {
        await fiber.dispose()
      }
    })
  })

  it('creates provider tasks without requiring a workspace', async () => {
    await withRegistry(async (registry) => {
      const remote = provider('remote')
      const root = new Context()
      const fiber = await root.plugin(async (ctx) => {
        await registry.registerTarget(ctx, remote.value)
      })
      try {
        const saved = await registry.save({
          name: 'Weekly brief', prompt: 'Summarize the week', target: 'remote',
          projectId: '', cron: '0 15 * * 5', timezone: 'UTC',
          permissionMode: 'auto', enabled: true,
        })
        expect(saved).not.toHaveProperty('projectId')
        expect(saved).not.toHaveProperty('workspace')
        expect(saved).not.toHaveProperty('branch')
        expect(remote.create).toHaveBeenCalledOnce()
      } finally {
        await fiber.dispose()
      }
    })
  })

  it('runs a local task without a workspace from Alto itself', async () => {
    await withRegistry(async (registry, _file, ctx) => {
      const saved = await registry.save({
        name: 'Weekly brief', prompt: 'Summarize the week', target: 'local',
        projectId: '', cron: '0 15 * * 5', timezone: 'Etc/GMT+8',
        permissionMode: 'auto', enabled: true,
      })

      await registry.run({ id: saved.id })

      expect(ctx.codex.startThread).toHaveBeenCalledWith(expect.objectContaining({
        workspace: '/tmp/alto',
      }))
      expect(ctx.codex.startTurn).toHaveBeenCalledWith(
        'scheduled-thread',
        [{ type: 'text', text: 'Summarize the week' }],
        expect.any(Object),
      )
    })
  })

  it('publishes a newer completion reported by an external provider', async () => {
    await withRegistry(async (registry) => {
      const remote = provider('remote')
      remote.value.refresh = vi.fn(async () => ({
        lastRun: {
          status: 'succeeded' as const,
          startedAt: '2026-08-27T16:00:00.000Z',
          finishedAt: '2026-08-27T16:03:00.000Z',
          message: 'Remote run completed.',
        },
      }))
      const root = new Context()
      const fiber = await root.plugin(async (ctx) => {
        await registry.registerTarget(ctx, remote.value)
      })
      try {
        await registry.save({
          name: 'Weekly brief', prompt: 'Summarize the week', target: 'remote',
          projectId: '', cron: '0 15 * * 5', timezone: 'UTC',
          permissionMode: 'auto', enabled: true,
        })

        await registry.refresh()

        expect(registry.snapshot().tasks[0]?.lastRun).toMatchObject({
          status: 'succeeded',
          finishedAt: '2026-08-27T16:03:00.000Z',
        })
      } finally {
        await fiber.dispose()
      }
    })
  })

  it('creates an Alto thread with completed provider output as import context', async () => {
    await withRegistry(async (registry, _file, ctx) => {
      const remote = provider('remote')
      remote.value.refresh = vi.fn(async () => ({
        lastRun: {
          status: 'succeeded' as const,
          startedAt: '2026-08-27T16:00:00.000Z',
          finishedAt: '2026-08-27T16:03:00.000Z',
          externalId: 'remote-run-1',
        },
      }))
      remote.value.importResult = vi.fn(async () => ({
        content: 'The completed result.',
        sourceLabel: 'Remote runner',
        url: 'https://example.invalid/run/1',
      }))
      vi.mocked(ctx.codex.startTurn).mockImplementationOnce(async (threadId, input) => {
        const prepared = registry.prepareImportedTurn({ threadId, input })
        expect(prepared.additionalContext).toMatchObject({
          scheduled_import: { kind: 'application' },
          scheduled_import_output: {
            kind: 'untrusted',
            value: 'The completed result.',
          },
        })
        return { turn: { id: 'import-turn' } }
      })
      const root = new Context()
      const fiber = await root.plugin(async (owner) => {
        await registry.registerTarget(owner, remote.value)
      })
      try {
        const saved = await registry.save({
          name: 'Weekly brief', prompt: 'Summarize the week', target: 'remote',
          projectId: '', cron: '0 15 * * 5', timezone: 'UTC',
          permissionMode: 'auto', enabled: true,
        })
        await registry.refresh()

        const thread = await registry.importResult({ id: saved.id })

        expect(thread).toMatchObject({ id: 'scheduled-thread', title: 'Weekly brief' })
        expect(ctx.codex.setThreadName).toHaveBeenCalledWith('scheduled-thread', 'Weekly brief')
      } finally {
        await fiber.dispose()
      }
    })
  })

  it('keeps a retired provider available for existing tasks until they are removed', async () => {
    await withRegistry(async (registry) => {
      const remote = provider('remote')
      const root = new Context()
      const fiber = await root.plugin(async (ctx) => {
        await registry.registerTarget(ctx, remote.value)
      })
      const saved = await registry.save({
        name: 'Remote task', prompt: 'Run it', target: 'remote', projectId: 'wallet',
        cron: '0 9 * * *', timezone: 'UTC', permissionMode: 'auto', enabled: true,
      })
      await fiber.dispose()
      expect(registry.snapshot().targets.find(({ id }) => id === 'remote')).toMatchObject({
        available: false,
        canManageExisting: true,
      })
      await registry.run({ id: saved.id })
      expect(remote.run).toHaveBeenCalledOnce()
      await registry.remove({ id: saved.id })
      expect(registry.snapshot().targets.some(({ id }) => id === 'remote')).toBe(false)
    })
  })

  it('requires an explicit detach before forgetting a task whose provider is absent', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'alto-scheduled-detach-'))
    const file = path.join(temporary, 'tasks.json')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [
        task({ id: 'delete-me', target: 'missing' }),
        task({ id: 'move-me', target: 'missing' }),
      ],
    }))
    const registry = new ScheduledTaskRegistry(registryContext(), file)
    try {
      await registry.start(new Context())
      await expect(registry.remove({ id: 'delete-me' })).rejects.toThrow('confirm detaching')
      await registry.remove({ id: 'delete-me', detachUnavailableTarget: true })

      const localInput = {
        id: 'move-me', name: 'Local task', prompt: 'Run it', target: 'local',
        projectId: 'wallet', cron: '0 9 * * *', timezone: 'UTC',
        permissionMode: 'auto', enabled: true,
      }
      await expect(registry.save(localInput)).rejects.toThrow('confirm detaching')
      await registry.save({ ...localInput, detachUnavailableTarget: true })
      expect(registry.snapshot().tasks).toMatchObject([{ id: 'move-me', target: 'local' }])
      expect(JSON.parse(await readFile(file, 'utf8')).tasks)
        .toMatchObject([{ id: 'move-me', target: 'local' }])
    } finally {
      registry.stop()
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
