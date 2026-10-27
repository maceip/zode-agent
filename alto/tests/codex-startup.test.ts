import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { Context, type Fiber } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexServicePlugin } from '../src/server/services/codex-service.js'
import { clientExtensionRegistryPlugin } from '../src/server/services/client-extension-registry.js'
import { projectRegistryPlugin } from '../src/server/services/project-registry.js'
import { toolRegistryPlugin } from '../src/server/services/tool-registry.js'
import { turnProgramPlugin } from '../src/server/services/turn-program.js'
import { uiRegistryPlugin } from '../src/server/services/ui-registry.js'
import sessionPlugin from '../program/plugins/session.js'
import orchestratorPlugin from '../program/plugins/orchestrator.js'
import { ORCHESTRATOR_REFRESH } from '../program/plugins/orchestrator-api.js'
import { SESSION_CODEX_START, SESSION_WORKSPACE_STATE } from '../program/plugins/session-api.js'

class MockProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly methods: string[] = []
  finishConfig: (() => void) | undefined

  constructor(holdConfig = false) {
    super()
    createInterface({ input: this.stdin }).on('line', (line) => {
      const message = JSON.parse(line) as { id?: number; method: string }
      this.methods.push(message.method)
      if (message.id === undefined) return
      const reply = (result: unknown): void => { this.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`) }
      if (message.method === 'config/read') {
        const finish = (): void => reply({ config: { model: 'test-model', model_reasoning_effort: 'high' } })
        if (holdConfig) this.finishConfig = finish
        else finish()
      } else if (message.method === 'model/list') reply({ data: [{ id: 'test-model', displayName: 'Test', isDefault: true }] })
      else if (message.method === 'thread/start') reply({ thread: { id: 'thread-new' } })
      else reply({ data: [], nextCursor: null })
    })
  }

  kill(): boolean {
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

async function fixture(createProcess = vi.fn(() => new MockProcess())) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'alto-codex-startup-'))
  vi.spyOn(os, 'homedir').mockReturnValue(projectRoot)
  cleanup.push(() => rm(projectRoot, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers: Fiber[] = []
  cleanup.push(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  fibers.push(await ctx.plugin(clientExtensionRegistryPlugin))
  fibers.push(await ctx.plugin(projectRegistryPlugin, { projectRoot }))
  fibers.push(await ctx.plugin(toolRegistryPlugin))
  fibers.push(await ctx.plugin(turnProgramPlugin))
  fibers.push(await ctx.plugin(uiRegistryPlugin))
  fibers.push(await ctx.plugin(codexServicePlugin, { projectRoot, command: process.execPath, createProcess }))
  fibers.push(await ctx.plugin(sessionPlugin, {}))
  fibers.push(await ctx.plugin(orchestratorPlugin, {}))
  return { ctx, createProcess, projectRoot }
}

describe('on-demand Codex startup', () => {
  it('mounts the session and task plugins and opens ACP tasks without spawning Codex', async () => {
    const { ctx, createProcess, projectRoot } = await fixture()
    await ctx.clientExtensions.call(ORCHESTRATOR_REFRESH, {})
    await ctx.clientExtensions.call(ORCHESTRATOR_REFRESH, { parentThreadId: 'acp-11111111-1111-1111-1111-111111111111' })
    expect(createProcess).not.toHaveBeenCalled()
    expect(ctx.codex.snapshot()).toMatchObject({ status: 'stopped', models: [] })
    expect(ctx.clientExtensions.snapshot()['session.defaults']).toBeNull()
    const workspace = ctx.clientExtensions.snapshot()[SESSION_WORKSPACE_STATE] as string
    expect(workspace).toBe(path.join(await realpath(projectRoot), '.alto', 'scratch'))
    expect((await stat(workspace)).isDirectory()).toBe(true)
  })

  it('starts once on the first Codex action and loads defaults before publishing readiness', async () => {
    const child = new MockProcess(true)
    const { ctx, createProcess, projectRoot } = await fixture(vi.fn(() => child))
    const ready = vi.fn()
    ctx.codex.on('status', (snapshot) => { if (snapshot.status === 'ready') ready(snapshot) })
    const thread = ctx.codex.startThread({ workspace: projectRoot, permissionMode: 'ask' })
    const models = ctx.clientExtensions.call(SESSION_CODEX_START, {})
    await vi.waitFor(() => expect(child.finishConfig).toBeDefined())
    expect(ctx.codex.snapshot().status).toBe('starting')
    expect(ready).not.toHaveBeenCalled()
    expect(child.methods).not.toContain('thread/start')
    child.finishConfig!()
    await expect(thread).resolves.toMatchObject({ thread: { id: 'thread-new' } })
    await models
    expect(createProcess).toHaveBeenCalledOnce()
    expect(ready).toHaveBeenCalled()
    expect(ctx.clientExtensions.snapshot()['session.defaults']).toEqual({ model: 'test-model', effort: 'high', permissionMode: 'ask' })
    expect(child.methods.indexOf('project/list')).toBeLessThan(child.methods.indexOf('thread/start'))
  })

  it('keeps a missing CLI failure local to Codex and allows a later retry', async () => {
    const createProcess = vi.fn<() => MockProcess>(() => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) })
    const { ctx } = await fixture(createProcess)
    await expect(ctx.clientExtensions.call(SESSION_CODEX_START, {})).rejects.toThrow('Codex CLI is not installed')
    expect(ctx.codex.snapshot().status).toBe('failed')
    await ctx.clientExtensions.call(ORCHESTRATOR_REFRESH, {})
    expect(createProcess).toHaveBeenCalledOnce()
    createProcess.mockImplementation(() => new MockProcess())
    await ctx.clientExtensions.call(SESSION_CODEX_START, {})
    expect(createProcess).toHaveBeenCalledTimes(2)
    expect(ctx.codex.snapshot().status).toBe('ready')
    expect(ctx.codex.snapshot().error).toBeUndefined()
  })

  it('does not publish readiness or restart a process after shutdown during startup', async () => {
    const child = new MockProcess(true)
    const { ctx, createProcess } = await fixture(vi.fn(() => child))
    const starting = expect(ctx.codex.start()).rejects.toThrow()
    await vi.waitFor(() => expect(child.finishConfig).toBeDefined())
    await ctx.codex.stop()
    child.finishConfig!()
    await starting
    expect(ctx.codex.snapshot().status).toBe('stopped')
    expect(createProcess).toHaveBeenCalledOnce()
  })
})
