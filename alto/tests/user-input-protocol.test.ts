import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Context } from 'cordis'
import { expect, it } from 'vitest'
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

it('returns question answers to the original RPC and clears only that pending request', async () => {
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
      const replies: Record<string, unknown> = {
        initialize: { userAgent: 'test' }, 'model/list': { data: [] },
        'config/read': { config: {} }, 'project/list': { data: [], nextCursor: null },
      }
      if (typeof message.method === 'string' && message.method in replies) {
        child.stdout.write(JSON.stringify({ id: message.id, result: replies[message.method] }) + '\n')
      }
    }
  })
  const service = new CodexService({ root: new EventEmitter() } as unknown as Context, {
    projectRoot: '/tmp/alto-question-protocol', createProcess: () => child,
  })
  try {
    await service.start()
    for (const [id, threadId, isBlocking] of [[71, 'chat-one', true], [72, 'chat-two', false]] as const) {
      const pending = once(service, 'serverRequest')
      child.stdout.write(JSON.stringify({ id, method: 'item/tool/requestUserInput', params: {
        threadId, turnId: 'turn-' + threadId, itemId: 'item-' + threadId, isBlocking,
        questions: [{ id: 'scope', header: 'Scope', question: 'Which files?', options: [
          { label: 'Workspace', description: 'Only this project' },
        ] }],
      } }) + '\n')
      await pending
    }
    expect(service.pendingRequests().map(request => request.params.threadId)).toEqual(['chat-one', 'chat-two'])
    const result = { answers: { scope: { answers: ['Workspace'] } } }
    service.resolveServerRequest(71, result)
    expect(outbound.at(-1)).toEqual({ id: 71, result })
    expect(outbound.some(message => message.method === 'turn/start' || message.method === 'turn/steer')).toBe(false)
    expect(service.pendingRequests().map(request => request.id)).toEqual([72])

    // An asynchronous question can be resolved by the server before we answer.
    const resolved = once(service, 'serverRequestResolved')
    child.stdout.write(JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: 72 } }) + '\n')
    await resolved
    expect(service.pendingRequests()).toEqual([])
  } finally {
    await service.stop()
  }
})
