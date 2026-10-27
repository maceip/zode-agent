import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { CodexService } from '../src/server/services/codex-service.js'

class MockProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  kill(): boolean {
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

describe('Codex thread summaries', () => {
  it('reads one thread directly and caches it without listing or classifying history', async () => {
    const child = new MockProcess()
    const methods: string[] = []
    let buffer = ''
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const message = JSON.parse(buffer.slice(0, newline)) as {
          id: number
          method: string
          params?: unknown
        }
        buffer = buffer.slice(newline + 1)
        methods.push(message.method)
        const reply = (result: unknown): void => {
          child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
        }
        if (message.method === 'initialize') reply({ userAgent: 'test' })
        if (message.method === 'model/list') reply({ data: [] })
        if (message.method === 'config/read') reply({ config: {} })
        if (message.method === 'project/list') reply({
          data: [{
            id: 'project-canonical',
            name: 'Focused project',
            roots: [{ path: '/repo/focused' }],
          }],
          nextCursor: null,
        })
        if (message.method === 'thread/start') reply({ thread: { id: 'thread-new' } })
        if (message.method === 'thread/read') reply({
          thread: {
            id: 'thread-1',
            name: 'Focused chat',
            preview: 'Focused chat',
            cwd: '/repo/focused',
            createdAt: 1,
            updatedAt: 2,
            recencyAt: 3,
            projectId: 'project-canonical',
            modelProvider: 'openai',
            gitInfo: {
              branch: 'captured-branch',
              sha: 'abc123',
              originUrl: 'git@example.com:owner/repo.git',
            },
            status: { type: 'idle' },
            canAcceptDirectInput: true,
            turns: [],
          },
        })
      }
    })

    const classifyThreads = vi.fn(async (threads: unknown) => threads)
    const importProjects = vi.fn(async () => new Map())
    const ctx = {
      root: new EventEmitter(),
      projects: { classifyThreads, importProjects },
      tools: { toAppServerSpecs: () => [] },
    } as unknown as Context
    const service = new CodexService(ctx, {
      projectRoot: '/repo/default',
      createProcess: () => child,
    })

    await service.start()
    await expect(service.threadSummary('thread-1')).resolves.toMatchObject({
      id: 'thread-1',
      cwd: '/repo/focused',
      updatedAt: 2,
      recencyAt: 3,
      projectRef: { source: 'codex-app', id: 'project-canonical' },
      gitInfo: { branch: 'captured-branch', sha: 'abc123' },
      status: { type: 'idle' },
      canAcceptDirectInput: true,
    })
    await expect(service.threadSummary('thread-1')).resolves.toMatchObject({
      id: 'thread-1',
      cwd: '/repo/focused',
    })
    await service.startThread({ workspace: '/repo/new', permissionMode: 'ask' })
    await expect(service.threadSummary('thread-new')).resolves.toMatchObject({
      id: 'thread-new',
      cwd: '/repo/new',
    })

    expect(methods.filter((method) => method === 'thread/read')).toHaveLength(1)
    expect(methods).not.toContain('thread/list')
    expect(classifyThreads).not.toHaveBeenCalled()
    expect(importProjects).toHaveBeenCalledWith('codex-app', [{
      id: 'project-canonical',
      name: 'Focused project',
      primaryRoot: '/repo/focused',
      roots: ['/repo/focused'],
    }])
    await service.stop()
  })
})
