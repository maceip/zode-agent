import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { CodexService } from '../src/server/services/codex-service.js'
import type { SessionOptions } from '../src/shared/protocol.js'

class MockProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  kill(): boolean {
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

describe('Codex steering', () => {
  it('sets the canonical App Server thread name', async () => {
    const child = new MockProcess()
    const outbound: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        buffer = buffer.slice(newline + 1)
        outbound.push(message)
        const reply = (result: unknown): void => {
          child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
        }
        if (message.method === 'initialize') reply({ userAgent: 'test' })
        if (message.method === 'model/list') reply({ data: [] })
        if (message.method === 'config/read') reply({ config: {} })
        if (message.method === 'project/list') reply({ data: [], nextCursor: null })
        if (message.method === 'thread/name/set') reply({})
      }
    })

    const ctx = { root: new EventEmitter() } as unknown as Context
    const service = new CodexService(ctx, {
      projectRoot: '/tmp/thread-name-test',
      createProcess: () => child,
    })

    await service.start()
    await service.setThreadName('thread-1', 'A clearer title')
    expect(outbound.find((message) => message.method === 'thread/name/set')).toMatchObject({
      params: { threadId: 'thread-1', name: 'A clearer title' },
    })
    await service.stop()
  })

  it('keeps the permission mode captured before turn/start crosses the process boundary', async () => {
    const child = new MockProcess()
    let releaseTurn: (() => void) | undefined
    let markTurnRequested: (() => void) | undefined
    const turnRequested = new Promise<void>((resolve) => {
      markTurnRequested = resolve
    })
    let buffer = ''
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        buffer = buffer.slice(newline + 1)
        const reply = (result: unknown): void => {
          child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
        }
        if (message.method === 'initialize') reply({ userAgent: 'test' })
        if (message.method === 'model/list') reply({ data: [] })
        if (message.method === 'config/read') reply({ config: {} })
        if (message.method === 'project/list') reply({ data: [], nextCursor: null })
        if (message.method === 'turn/start') {
          releaseTurn = () => reply({ turn: { id: 'turn-captured' } })
          markTurnRequested?.()
        }
      }
    })

    const ctx = {
      root: new EventEmitter(),
      turnProgram: { prepare: async (draft: unknown) => draft },
    } as unknown as Context
    const service = new CodexService(ctx, {
      projectRoot: '/tmp/codex-permission-test',
      createProcess: () => child,
    })
    const options: SessionOptions = {
      workspace: '/tmp/codex-permission-test',
      permissionMode: 'auto',
    }

    await service.start()
    const starting = service.startTurn(
      'thread-captured',
      [{ type: 'text', text: 'start here' }],
      options,
    )
    await turnRequested
    options.permissionMode = 'full'
    releaseTurn?.()
    await starting

    expect(service.permissionModeForTurn('thread-captured', 'turn-captured')).toBe('auto')
    await service.stop()
  })

  it('roots turn permissions at a plugin-retargeted worktree', async () => {
    const child = new MockProcess()
    const outbound: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        buffer = buffer.slice(newline + 1)
        outbound.push(message)
        const reply = (result: unknown): void => {
          child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
        }
        if (message.method === 'initialize') reply({ userAgent: 'test' })
        if (message.method === 'model/list') reply({ data: [] })
        if (message.method === 'config/read') reply({ config: {} })
        if (message.method === 'project/list') reply({ data: [], nextCursor: null })
        if (message.method === 'turn/start') reply({ turn: { id: 'turn-worktree' } })
      }
    })

    const ctx = {
      root: new EventEmitter(),
      turnProgram: {
        prepare: async (draft: Record<string, unknown>) => ({
          ...draft,
          cwd: '/tmp/selected-worktree',
        }),
      },
    } as unknown as Context
    const service = new CodexService(ctx, {
      projectRoot: '/tmp/original-worktree',
      createProcess: () => child,
    })

    await service.start()
    await service.startTurn(
      'thread-worktree',
      [{ type: 'text', text: 'make the change' }],
      { workspace: '/tmp/original-worktree', permissionMode: 'auto' },
    )

    expect(outbound.find((message) => message.method === 'turn/start')).toMatchObject({
      params: {
        cwd: '/tmp/selected-worktree',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/tmp/selected-worktree'],
        },
      },
    })
    await service.stop()
  })

  it('targets the known active turn with turn/steer', async () => {
    const child = new MockProcess()
    const outbound: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        buffer = buffer.slice(newline + 1)
        outbound.push(message)
        const reply = (result: unknown): void => {
          child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
        }
        if (message.method === 'initialize') reply({ userAgent: 'test' })
        if (message.method === 'model/list') reply({ data: [] })
        if (message.method === 'config/read') reply({ config: {} })
        if (message.method === 'project/list') reply({ data: [], nextCursor: null })
        if (message.method === 'turn/start') reply({ turn: { id: 'turn-1' } })
        if (message.method === 'turn/steer') reply({ turnId: 'turn-1' })
      }
    })

    const ctx = {
      root: new EventEmitter(),
      turnProgram: { prepare: async (draft: unknown) => draft },
    } as unknown as Context
    const service = new CodexService(ctx, {
      projectRoot: '/tmp/codex-steer-test',
      createProcess: () => child,
    })

    await service.start()
    await service.startTurn(
      'thread-1',
      [{ type: 'text', text: 'start here' }],
      { workspace: '/tmp/codex-steer-test', permissionMode: 'ask' },
    )
    expect(service.permissionModeForTurn('thread-1', 'turn-1')).toBe('ask')
    expect(service.permissionModeForTurn('thread-1', 'different-turn')).toBeUndefined()
    await expect(service.steer(
      'thread-1',
      [{ type: 'text', text: 'change direction' }],
    )).resolves.toEqual({ turnId: 'turn-1' })
    expect(service.snapshot().activeThreadIds).toEqual(['thread-1'])

    expect(outbound.find((message) => message.method === 'turn/steer')).toMatchObject({
      method: 'turn/steer',
      params: {
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'change direction' }],
      },
    })

    child.stdout.write(`${JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    })}\n`)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(service.snapshot().activeThreadIds).toEqual([])
    expect(service.permissionModeForTurn('thread-1', 'turn-1')).toBeUndefined()
    await service.stop()
  })

  it('recovers an in-progress turn and its effective permissions when resuming', async () => {
    const child = new MockProcess()
    const outbound: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        buffer = buffer.slice(newline + 1)
        outbound.push(message)
        const reply = (result: unknown): void => {
          child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
        }
        if (message.method === 'initialize') reply({ userAgent: 'test' })
        if (message.method === 'model/list') reply({ data: [] })
        if (message.method === 'config/read') reply({ config: {} })
        if (message.method === 'project/list') reply({ data: [], nextCursor: null })
        if (message.method === 'thread/read') reply({
          thread: {
            id: 'thread-running',
            name: 'Running chat',
            preview: 'Running chat',
            cwd: '/tmp/running',
            createdAt: 1,
            updatedAt: 2,
            gitInfo: { branch: 'captured/running', sha: 'def456' },
          },
        })
        if (message.method === 'thread/resume') reply({
          thread: {
            id: 'thread-running',
            name: 'Running chat',
            preview: 'Running chat',
            cwd: '/tmp/running',
            createdAt: 1,
            updatedAt: 2,
            status: { type: 'active', activeFlags: [] },
            canAcceptDirectInput: true,
            turns: [],
          },
          model: 'gpt-effective',
          modelProvider: 'openai',
          cwd: '/tmp/running',
          approvalPolicy: 'never',
          approvalsReviewer: 'human',
          sandbox: { type: 'dangerFullAccess' },
          reasoningEffort: 'high',
          initialTurnsPage: {
            data: [{
              id: 'turn-running',
              status: 'inProgress',
              itemsView: 'full',
              items: [],
              startedAt: 2,
            }],
            nextCursor: null,
          },
        })
        if (message.method === 'turn/interrupt') reply({})
      }
    })

    const ctx = {
      root: new EventEmitter(),
      projects: {
        importProjects: async () => new Map(),
        classifyThreads: async (threads: unknown) => threads,
      },
    } as unknown as Context
    const service = new CodexService(ctx, {
      projectRoot: '/tmp/running',
      createProcess: () => child,
    })

    await service.start()
    const opened = await service.openThread('thread-running', {
      workspace: '/tmp/stale',
      permissionMode: 'ask',
    })

    expect(opened.session).toMatchObject({
      workspace: '/tmp/running',
      permissionMode: 'full',
      model: 'gpt-effective',
    })
    expect(opened.summary.gitInfo).toEqual({
      branch: 'captured/running',
      sha: 'def456',
    })
    expect(service.snapshot()).toMatchObject({
      activeThreadIds: ['thread-running'],
      threadStates: {
        'thread-running': {
          status: { type: 'active' },
          canAcceptDirectInput: true,
        },
      },
    })
    expect(service.permissionModeForTurn('thread-running', 'turn-running')).toBe('full')

    await service.interrupt('thread-running')
    expect(outbound.find((message) => message.method === 'turn/interrupt')).toMatchObject({
      params: { threadId: 'thread-running', turnId: 'turn-running' },
    })
    await service.stop()
  })

  it('uses App Server as the durable submission queue', async () => {
    const child = new MockProcess()
    const outbound: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        buffer = buffer.slice(newline + 1)
        outbound.push(message)
        const reply = (result: unknown): void => {
          child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
        }
        if (message.method === 'initialize') reply({ userAgent: 'test' })
        if (message.method === 'model/list') reply({ data: [] })
        if (message.method === 'config/read') reply({ config: {} })
        if (message.method === 'project/list') reply({ data: [], nextCursor: null })
        if (message.method === 'thread/queue/list') reply({
          data: [{
            id: 'queued-1',
            input: [{ type: 'text', text: 'queued' }],
            clientUserMessageId: 'client-1',
          }],
          nextCursor: null,
        })
        if (message.method === 'thread/queue/add') reply({
          queuedSubmission: {
            id: 'queued-2',
            input: [{ type: 'text', text: 'another' }],
            clientUserMessageId: 'client-2',
          },
        })
        if (message.method === 'thread/queue/update') reply({
          queuedSubmission: {
            id: 'queued-2',
            input: [{ type: 'text', text: 'edited' }],
            clientUserMessageId: 'client-2',
          },
        })
        if (message.method === 'thread/queue/delete') reply({ deleted: true })
        if (message.method === 'thread/queue/reorder') reply({})
        if (message.method === 'thread/queue/start') reply({ turn: { id: 'turn-queued' } })
      }
    })

    const ctx = {
      root: new EventEmitter(),
      projects: { importProjects: async () => new Map() },
    } as unknown as Context
    const service = new CodexService(ctx, {
      projectRoot: '/tmp/queue',
      createProcess: () => child,
    })

    await service.start()
    await expect(service.listQueuedSubmissions('thread-queue')).resolves.toHaveLength(1)
    await expect(service.addQueuedSubmission(
      'thread-queue',
      [{ type: 'text', text: 'another' }],
      'client-2',
    )).resolves.toMatchObject({ id: 'queued-2' })
    await expect(service.updateQueuedSubmission(
      'thread-queue',
      'queued-2',
      [{ type: 'text', text: 'edited' }],
    )).resolves.toMatchObject({ id: 'queued-2' })
    await service.reorderQueuedSubmissions('thread-queue', ['queued-2', 'queued-1'])
    await service.deleteQueuedSubmission('thread-queue', 'queued-1')
    await service.startQueuedSubmission('thread-queue', 'queued-2')

    expect(outbound.find((message) => message.method === 'thread/queue/add')).toMatchObject({
      params: {
        threadId: 'thread-queue',
        input: [{ type: 'text', text: 'another' }],
        clientUserMessageId: 'client-2',
      },
    })
    expect(outbound.find((message) => message.method === 'thread/queue/reorder')).toMatchObject({
      params: {
        threadId: 'thread-queue',
        queuedSubmissionIds: ['queued-2', 'queued-1'],
      },
    })
    expect(outbound.find((message) => message.method === 'thread/queue/update')).toMatchObject({
      params: {
        threadId: 'thread-queue',
        queuedSubmissionId: 'queued-2',
        input: [{ type: 'text', text: 'edited' }],
      },
    })
    expect(outbound.find((message) => message.method === 'thread/queue/delete')).toMatchObject({
      params: { threadId: 'thread-queue', queuedSubmissionId: 'queued-1' },
    })
    expect(outbound.find((message) => message.method === 'thread/queue/start')).toMatchObject({
      params: { threadId: 'thread-queue', queuedSubmissionId: 'queued-2' },
    })
    expect(service.snapshot().activeThreadIds).toEqual(['thread-queue'])
    await service.stop()
  })

  it('runs isolated text generation as an ephemeral read-only turn', async () => {
    const child = new MockProcess()
    const outbound: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        buffer = buffer.slice(newline + 1)
        outbound.push(message)
        const reply = (result: unknown): void => {
          child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
        }
        if (message.method === 'initialize') reply({ userAgent: 'test' })
        if (message.method === 'model/list') reply({ data: [] })
        if (message.method === 'config/read') reply({ config: {} })
        if (message.method === 'project/list') reply({ data: [], nextCursor: null })
        if (message.method === 'thread/start') reply({ thread: { id: 'thread-generation' } })
        if (message.method === 'turn/start') {
          reply({ turn: { id: 'turn-generation' } })
          queueMicrotask(() => child.stdout.write(`${JSON.stringify({
            method: 'turn/completed',
            params: {
              threadId: 'thread-generation',
              turn: {
                id: 'turn-generation',
                status: 'completed',
                startedAt: 1,
                completedAt: 2,
                items: [{
                  id: 'answer',
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: '{"title":"Generated tour"}',
                }],
              },
            },
          })}\n`))
        }
      }
    })

    const ctx = {
      root: new EventEmitter(),
      projects: { importProjects: async () => new Map() },
    } as unknown as Context
    const service = new CodexService(ctx, {
      projectRoot: '/tmp/generation',
      createProcess: () => child,
    })

    await service.start()
    await expect(service.generateText({
      workspace: '/tmp/generation',
      model: 'gpt-5.6-sol',
      effort: 'high',
      instructions: 'Return JSON only.',
      prompt: 'Explain the supplied diff.',
      serviceName: 'alto-code-tour',
      additionalContext: {
        code_tour_patch: { kind: 'untrusted', value: '+new behavior' },
      },
    })).resolves.toBe('{"title":"Generated tour"}')

    expect(outbound.find((message) => message.method === 'thread/start')).toMatchObject({
      params: {
        cwd: '/tmp/generation',
        model: 'gpt-5.6-sol',
        sandbox: 'read-only',
        approvalPolicy: 'never',
        dynamicTools: [],
        ephemeral: true,
        serviceName: 'alto-code-tour',
        baseInstructions: 'Return JSON only.',
      },
    })
    expect(outbound.find((message) => message.method === 'turn/start')).toMatchObject({
      params: {
        threadId: 'thread-generation',
        model: 'gpt-5.6-sol',
        effort: 'high',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        additionalContext: {
          code_tour_patch: { kind: 'untrusted', value: '+new behavior' },
        },
      },
    })
    await service.stop()
  })
})
