import { Context } from 'cordis'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { clientExtensionRegistryPlugin } from '../src/server/services/client-extension-registry.js'
import { ComposerActions } from '../program/plugins/composer-actions.js'
import { IdePreference } from '../program/plugins/open-in-ide.client.js'
import openInIde, { ideWorkspace } from '../program/plugins/open-in-ide.js'
import { OPEN_IN_IDE } from '../program/plugins/open-in-ide-api.js'
import type { WorkTarget } from '../program/plugins/work-contexts-api.js'

it.skipIf(process.platform !== 'darwin')('keeps the composer compact and targets its own pane through reloads', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(createRequire(import.meta.url)('electron') as string, [
    path.resolve('tests/fixtures/open-in-ide.cjs'),
  ], { cwd: process.cwd(), env, timeout: 25_000 })
  expect(stdout).toContain('Open in IDE browser checks passed')
}, 30_000)

describe('Open in IDE', () => {
  it('uses the invoking chat’s selected worktree and rejects remote targets', () => {
    const local = { kind: 'local', location: '/worktree' } as WorkTarget
    const contexts = { targetForThread: (id: string) => id === 'pane-a' ? local : undefined }
    expect(ideWorkspace({ ide: 'cursor', threadId: 'pane-a', workspace: '/project' }, contexts).workspace).toBe('/worktree')
    expect(ideWorkspace({ ide: 'cursor', threadId: 'pane-b', workspace: '/other' }, contexts).workspace).toBe('/other')
    expect(ideWorkspace({ ide: 'zed', workspace: '/new-chat' }, contexts).workspace).toBe('/new-chat')
    expect(() => ideWorkspace({ ide: 'cursor', workspace: '/remote', remote: true }, contexts)).toThrow(/remote/)
    expect(() => ideWorkspace({ ide: 'cursor', threadId: 'pane-a', workspace: '/project' }, {
      targetForThread: () => ({ ...local, kind: 'remote' }),
    })).toThrow(/remote/)
    for (const workspace of ['', 'relative', '/path\0suffix']) {
      expect(() => ideWorkspace({ ide: 'cursor', workspace }, contexts)).toThrow(/workspace/)
    }
    expect(() => ideWorkspace({ ide: 'arbitrary-command', workspace: '/project' }, contexts)).toThrow(/Choose an IDE/)
  })

  it('launches literal paths in a new window, reports failures, and aborts on unload', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'alto-ide-'))
    const workspace = path.join(directory, 'project with spaces; $(literal)')
    await mkdir(workspace)
    const ctx = new Context()
    const registry = await ctx.plugin(clientExtensionRegistryPlugin)
    const execFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    ctx.provide('processRunner', { execFile })
    ctx.provide('workContexts', { targetForThread: () => undefined } as never)
    let fiber
    try {
      fiber = await ctx.plugin(openInIde)
      for (const ide of ['vscode', 'cursor', 'zed']) {
        await ctx.clientExtensions.call(OPEN_IN_IDE, { ide, workspace })
        expect(execFile.mock.lastCall?.[1]).toEqual(['-n', workspace])
      }
      const savedWorkspace = path.join(directory, 'multi.code-workspace')
      await writeFile(savedWorkspace, '{}')
      await ctx.clientExtensions.call(OPEN_IN_IDE, { ide: 'cursor', workspace: savedWorkspace })
      expect(execFile.mock.lastCall?.[1]).toEqual(['-n', savedWorkspace])
      await expect(ctx.clientExtensions.call(OPEN_IN_IDE, { ide: 'cursor', workspace: path.join(directory, 'missing') })).rejects.toThrow(/no longer exists/)
      execFile.mockRejectedValueOnce(new Error('ENOENT'))
      await expect(ctx.clientExtensions.call(OPEN_IN_IDE, { ide: 'cursor', workspace })).rejects.toThrow(/Could not open Cursor/)
      const signal = execFile.mock.lastCall?.[2].signal as AbortSignal
      await fiber.dispose()
      expect(signal.aborted).toBe(true)
      await expect(ctx.clientExtensions.call(OPEN_IN_IDE, { ide: 'cursor', workspace })).rejects.toThrow()
    } finally {
      await fiber?.dispose()
      await registry.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists the IDE choice across reloads and ignores invalid saved values', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const preference = new IdePreference('cursor', storage)
    const listener = vi.fn()
    const unsubscribe = preference.subscribe(listener)
    preference.set('zed')
    expect(listener).toHaveBeenCalledOnce()
    expect(new IdePreference('vscode', storage).snapshot()).toBe('zed')
    values.set('alto.open-in-ide', 'unknown')
    expect(new IdePreference('cursor', storage).snapshot()).toBe('cursor')
    unsubscribe()
  })

  it('removes composer actions when their owning plugin unloads', async () => {
    const actions = new ComposerActions()
    const ctx = new Context()
    const changed = vi.fn()
    actions.subscribe(changed)
    const first = await ctx.plugin((owner) => { actions.register(owner, { id: 'first', order: 20, component: () => null }) })
    const second = await ctx.plugin((owner) => { actions.register(owner, { id: 'second', order: 10, component: () => null }) })
    expect(actions.snapshot().map((action) => action.id)).toEqual(['second', 'first'])
    await first.dispose()
    expect(actions.snapshot().map((action) => action.id)).toEqual(['second'])
    await second.dispose()
    expect(actions.snapshot()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(4)
  })
})
