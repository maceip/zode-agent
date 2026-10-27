import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  CodexService,
  INITIAL_THREAD_TURN_LIMIT,
} from '../src/server/services/codex-service.js'

class MockProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  kill(): boolean {
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

function turn(id: string, startedAt: number, text: string) {
  return {
    id,
    startedAt,
    itemsView: 'full',
    status: 'completed',
    items: [{ id: `${id}-user`, type: 'userMessage', content: [{ type: 'text', text }] }],
  }
}

describe('thread history pagination', () => {
  it('resumes with a bounded page and loads older turns without resuming again', async () => {
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
            id: 'thread-1',
            name: 'Paged chat',
            preview: 'Paged chat',
            cwd: '/tmp/project',
            createdAt: 1,
            updatedAt: 4,
            gitInfo: {
              branch: 'captured/branch',
              sha: 'abc123',
              originUrl: 'git@example.com:owner/project.git',
            },
          },
        })
        if (message.method === 'thread/resume') reply({
          thread: {
            id: 'thread-1',
            name: 'Paged chat',
            preview: 'Paged chat',
            cwd: '/tmp/project',
            createdAt: 1,
            updatedAt: 4,
            status: { type: 'idle' },
            canAcceptDirectInput: false,
            turns: [],
          },
          model: 'gpt-effective',
          modelProvider: 'openai',
          cwd: '/tmp/effective-workspace',
          approvalPolicy: 'never',
          approvalsReviewer: 'human',
          sandbox: { type: 'dangerFullAccess' },
          reasoningEffort: 'max',
          initialTurnsPage: {
            data: [turn('turn-4', 4, 'Newest'), turn('turn-3', 3, 'Newer')],
            nextCursor: 'older-2',
          },
        })
        if (message.method === 'thread/turns/list') reply({
          data: [turn('turn-2', 2, 'Older'), turn('turn-1', 1, 'Oldest')],
          nextCursor: null,
        })
      }
    })

    const ctx = {
      root: new EventEmitter(),
      projects: { classifyThreads: async (threads: unknown) => threads },
    } as unknown as Context
    const service = new CodexService(ctx, {
      projectRoot: '/tmp/project',
      createProcess: () => child,
    })

    await service.start()
    const opened = await service.openThread('thread-1', {
      workspace: '/tmp/stale-browser-workspace',
      permissionMode: 'auto',
      model: 'stale-browser-model',
      effort: 'low',
    })
    const older = await service.listThreadTurns('thread-1', opened.olderCursor)

    expect(opened.messages.map((message) => message.text)).toEqual(['Newer', 'Newest'])
    expect(opened.summary.gitInfo).toEqual({
      branch: 'captured/branch',
      sha: 'abc123',
      originUrl: 'git@example.com:owner/project.git',
    })
    expect(opened.olderCursor).toBe('older-2')
    expect(opened.session).toEqual({
      workspace: '/tmp/effective-workspace',
      permissionMode: 'full',
      model: 'gpt-effective',
      effort: 'max',
      modelProvider: 'openai',
      canAcceptDirectInput: false,
    })
    expect(older.messages.map((message) => message.text)).toEqual(['Oldest', 'Older'])
    expect(older.olderCursor).toBeUndefined()
    expect(outbound.find((message) => message.method === 'thread/resume')?.params).toEqual({
      threadId: 'thread-1',
      excludeTurns: true,
      initialTurnsPage: {
        limit: INITIAL_THREAD_TURN_LIMIT,
        sortDirection: 'desc',
        itemsView: 'full',
      },
    })
    expect(outbound.find((message) => message.method === 'thread/read')?.params).toEqual({
      threadId: 'thread-1',
      includeTurns: false,
    })
    expect(outbound.find((message) => message.method === 'thread/turns/list')).toMatchObject({
      params: {
        threadId: 'thread-1',
        cursor: 'older-2',
        limit: INITIAL_THREAD_TURN_LIMIT,
        sortDirection: 'desc',
        itemsView: 'full',
      },
    })
    await service.stop()
  })
})
