import { describe, expect, it, vi } from 'vitest'
import type { ClientDraft, ClientHostService } from '../src/client/plugin-api.js'
import type { ClientSessionService, ClientSessionSnapshot } from '../program/plugins/session-api.js'
import {
  STEER_QUEUE_ADD,
  STEER_QUEUE_DELETE,
  STEER_QUEUE_LIST,
  STEER_QUEUE_START,
  STEER_QUEUE_UPDATE,
} from '../program/plugins/steer-api.js'
import {
  createSteerSubmitMiddleware,
  moveQueuedSteer,
  replaceQueuedSteer,
  SteerQueue,
} from '../program/plugins/steer.client.js'
import { legacyEditedQueueOrder } from '../program/plugins/steer.js'

const messages = [
  { id: 'first' },
  { id: 'second' },
  { id: 'third' },
]

describe('steer queue ordering', () => {
  it('moves a queued message in either direction', () => {
    expect(moveQueuedSteer(messages, 'first', 'third').map(({ id }) => id))
      .toEqual(['second', 'third', 'first'])
    expect(moveQueuedSteer(messages, 'third', 'first').map(({ id }) => id))
      .toEqual(['third', 'first', 'second'])
  })

  it('preserves the queue for missing and identical targets', () => {
    expect(moveQueuedSteer(messages, 'first', 'first')).toBe(messages)
    expect(moveQueuedSteer(messages, 'missing', 'second')).toBe(messages)
  })

  it('keeps every queued submission in a compatibility edit reorder', () => {
    const current = ['before', 'edited', 'after', 'replacement']
    const reordered = legacyEditedQueueOrder(current, 'edited', 'replacement')

    expect(reordered).toEqual(['before', 'replacement', 'edited', 'after'])
    expect(new Set(reordered)).toEqual(new Set(current))
  })

  it('replaces an edited queue item when the durable id changes', () => {
    expect(replaceQueuedSteer(
      [{ id: 'before' }, { id: 'edited' }, { id: 'after' }],
      'edited',
      { id: 'replacement' },
    )).toEqual([{ id: 'before' }, { id: 'replacement' }, { id: 'after' }])
  })

  it('routes queue and steer intents independently during an active turn', async () => {
    const draft: ClientDraft = { text: 'change course', images: [], attachments: [], skills: [] }
    const state = {
      turn: { tag: 'running' },
      threadId: 'thread-1',
    } as ClientSessionSnapshot
    const session = {
      snapshot: () => state,
      steer: vi.fn(async () => undefined),
    } as unknown as ClientSessionService
    const queue = new SteerQueue()
    const middleware = createSteerSubmitMiddleware(queue, session)
    const next = vi.fn(async () => undefined)

    await middleware(draft, next, { mode: 'queue' })
    expect(queue.snapshot()).toHaveLength(1)
    expect(session.steer).not.toHaveBeenCalled()

    await middleware(draft, next, { mode: 'steer' })
    expect(queue.snapshot()).toHaveLength(1)
    expect(session.steer).toHaveBeenCalledWith(draft)
    expect(next).not.toHaveBeenCalled()
  })

  it('keeps middleware queues isolated across active pane targets', async () => {
    const draft: ClientDraft = { text: 'follow up', images: [], attachments: [], skills: [] }
    const session = {
      snapshot: () => ({ turn: { tag: 'idle' } }) as ClientSessionSnapshot,
    } as unknown as ClientSessionService
    const queue = new SteerQueue()
    const middleware = createSteerSubmitMiddleware(queue, session)
    const next = vi.fn(async () => undefined)
    const target = (threadId: string) => ({
      id: `pane:${threadId}`,
      threadId,
      activeTurn: true,
      send: vi.fn(async () => undefined),
      steer: vi.fn(async () => undefined),
    })

    await middleware(draft, next, { mode: 'queue', target: target('thread-a') })
    await middleware(draft, next, { mode: 'queue', target: target('thread-b') })

    expect(queue.snapshot().map((message) => message.threadId)).toEqual(['thread-a', 'thread-b'])
    expect(queue.takeNext('thread-b')?.threadId).toBe('thread-b')
    expect(queue.takeNext('thread-a')?.threadId).toBe('thread-a')
    expect(next).not.toHaveBeenCalled()
  })

  it('hides a durable queue preview while App Server starts it', async () => {
    let finishStart: (() => void) | undefined
    const host = {
      subscribe: () => () => undefined,
      onEvent: () => () => undefined,
      call: vi.fn((method: string) => {
        if (method === STEER_QUEUE_ADD) return Promise.resolve({
          id: 'queued-1',
          input: [{ type: 'text', text: 'Pick this up next' }],
          clientUserMessageId: 'client-1',
        })
        if (method === STEER_QUEUE_START) {
          return new Promise<void>((resolve) => { finishStart = resolve })
        }
        throw new Error(`unexpected method: ${method}`)
      }),
    } as unknown as ClientHostService
    const queue = new SteerQueue(host)

    await queue.enqueue('thread-1', {
      text: 'Pick this up next',
      images: [],
      attachments: [],
      skills: [],
    })
    const starting = queue.startNext('thread-1')

    expect(queue.snapshot()).toEqual([])
    finishStart?.()
    await expect(starting).resolves.toMatchObject({
      id: 'queued-1',
      draft: { text: 'Pick this up next' },
    })
    expect(queue.snapshot()).toEqual([])
  })

  it('restores a durable queue preview when App Server cannot remove it', async () => {
    let failDelete: ((error: Error) => void) | undefined
    const host = {
      subscribe: () => () => undefined,
      onEvent: () => () => undefined,
      call: vi.fn((method: string) => {
        if (method === STEER_QUEUE_ADD) return Promise.resolve({
          id: 'queued-1',
          input: [{ type: 'text', text: 'Change course' }],
          clientUserMessageId: 'client-1',
        })
        if (method === STEER_QUEUE_DELETE) {
          return new Promise<void>((_resolve, reject) => { failDelete = reject })
        }
        if (method === STEER_QUEUE_LIST) return Promise.resolve([{
          id: 'queued-1',
          input: [{ type: 'text', text: 'Change course' }],
          clientUserMessageId: 'client-1',
        }])
        throw new Error(`unexpected method: ${method}`)
      }),
    } as unknown as ClientHostService
    const queue = new SteerQueue(host)

    await queue.enqueue('thread-1', {
      text: 'Change course',
      images: [],
      attachments: [],
      skills: [],
    })
    const removing = queue.remove('queued-1')

    expect(queue.snapshot()).toEqual([])
    failDelete?.(new Error('queue cleanup failed'))
    await expect(removing).rejects.toThrow('queue cleanup failed')
    expect(queue.snapshot()).toMatchObject([{
      id: 'queued-1',
      state: 'queued',
      error: 'queue cleanup failed',
    }])
  })

  it('does not restore a queue preview that the server says is already gone', async () => {
    const host = {
      subscribe: () => () => undefined,
      onEvent: () => () => undefined,
      call: vi.fn((method: string) => {
        if (method === STEER_QUEUE_ADD) return Promise.resolve({
          id: 'queued-1',
          input: [{ type: 'text', text: 'Change course' }],
          clientUserMessageId: 'client-1',
        })
        if (method === STEER_QUEUE_DELETE) {
          return Promise.reject(new Error('queued submission not found: queued-1'))
        }
        if (method === STEER_QUEUE_LIST) return Promise.resolve([])
        throw new Error(`unexpected method: ${method}`)
      }),
    } as unknown as ClientHostService
    const queue = new SteerQueue(host)

    await queue.enqueue('thread-1', {
      text: 'Change course',
      images: [],
      attachments: [],
      skills: [],
    })

    await expect(queue.remove('queued-1')).resolves.toBeUndefined()
    expect(queue.snapshot()).toEqual([])
  })

  it('does not restore an auto-start preview that vanished on the server', async () => {
    const host = {
      subscribe: () => () => undefined,
      onEvent: () => () => undefined,
      call: vi.fn((method: string) => {
        if (method === STEER_QUEUE_ADD) return Promise.resolve({
          id: 'queued-1',
          input: [{ type: 'text', text: 'Pick this up next' }],
          clientUserMessageId: 'client-1',
        })
        if (method === STEER_QUEUE_START) {
          return Promise.reject(new Error('queued submission not found: queued-1'))
        }
        if (method === STEER_QUEUE_LIST) return Promise.resolve([])
        throw new Error(`unexpected method: ${method}`)
      }),
    } as unknown as ClientHostService
    const queue = new SteerQueue(host)

    await queue.enqueue('thread-1', {
      text: 'Pick this up next',
      images: [],
      attachments: [],
      skills: [],
    })

    await expect(queue.startNext('thread-1')).resolves.toBeUndefined()
    expect(queue.snapshot()).toEqual([])
  })

  it('updates a queued message in place', async () => {
    const host = {
      subscribe: () => () => undefined,
      onEvent: () => () => undefined,
      call: vi.fn((method: string, payload: unknown) => {
        if (method === STEER_QUEUE_ADD) return Promise.resolve({
          id: 'queued-1',
          input: [{ type: 'text', text: 'Before' }],
          clientUserMessageId: 'client-1',
        })
        if (method === STEER_QUEUE_UPDATE) return Promise.resolve({
          id: 'queued-1',
          input: [{ type: 'text', text: 'After' }],
          clientUserMessageId: 'client-1',
        })
        throw new Error(`unexpected method: ${method} ${JSON.stringify(payload)}`)
      }),
    } as unknown as ClientHostService
    const queue = new SteerQueue(host)

    await queue.enqueue('thread-1', {
      text: 'Before',
      images: [],
      attachments: [],
      skills: [],
    })
    await queue.update('queued-1', {
      text: 'After',
      images: [],
      attachments: [],
      skills: [],
    })

    expect(queue.snapshot()).toMatchObject([{
      id: 'queued-1',
      draft: { text: 'After' },
    }])
    expect(host.call).toHaveBeenCalledWith(STEER_QUEUE_UPDATE, {
      threadId: 'thread-1',
      queuedSubmissionId: 'queued-1',
      draft: {
        text: 'After',
        images: [],
        attachments: [],
        skills: [],
      },
    })
  })

  it('accepts a replacement id from a compatibility edit', async () => {
    const host = {
      subscribe: () => () => undefined,
      onEvent: () => () => undefined,
      call: vi.fn((method: string) => {
        if (method === STEER_QUEUE_ADD) return Promise.resolve({
          id: 'queued-1',
          input: [{ type: 'text', text: 'Before' }],
        })
        if (method === STEER_QUEUE_UPDATE) return Promise.resolve({
          id: 'queued-2',
          input: [{ type: 'text', text: 'After' }],
        })
        throw new Error(`unexpected method: ${method}`)
      }),
    } as unknown as ClientHostService
    const queue = new SteerQueue(host)

    await queue.enqueue('thread-1', {
      text: 'Before',
      images: [],
      attachments: [],
      skills: [],
    })
    await queue.update('queued-1', {
      text: 'After',
      images: [],
      attachments: [],
      skills: [],
    })

    expect(queue.snapshot()).toMatchObject([{
      id: 'queued-2',
      draft: { text: 'After' },
    }])
  })

  it('restores the previous queued message when an edit fails', async () => {
    const host = {
      subscribe: () => () => undefined,
      onEvent: () => () => undefined,
      call: vi.fn((method: string) => {
        if (method === STEER_QUEUE_ADD) return Promise.resolve({
          id: 'queued-1',
          input: [{ type: 'text', text: 'Keep this' }],
          clientUserMessageId: 'client-1',
        })
        if (method === STEER_QUEUE_UPDATE) return Promise.reject(new Error('queue update failed'))
        if (method === STEER_QUEUE_LIST) return Promise.resolve([{
          id: 'queued-1',
          input: [{ type: 'text', text: 'Keep this' }],
          clientUserMessageId: 'client-1',
        }])
        throw new Error(`unexpected method: ${method}`)
      }),
    } as unknown as ClientHostService
    const queue = new SteerQueue(host)

    await queue.enqueue('thread-1', {
      text: 'Keep this',
      images: [],
      attachments: [],
      skills: [],
    })
    await expect(queue.update('queued-1', {
      text: 'Do not keep this',
      images: [],
      attachments: [],
      skills: [],
    })).rejects.toThrow('queue update failed')

    expect(queue.snapshot()).toMatchObject([{
      id: 'queued-1',
      draft: { text: 'Keep this' },
      error: 'queue update failed',
    }])
  })

  it('drops an edited queue preview that vanished on the server', async () => {
    const host = {
      subscribe: () => () => undefined,
      onEvent: () => () => undefined,
      call: vi.fn((method: string) => {
        if (method === STEER_QUEUE_ADD) return Promise.resolve({
          id: 'queued-1',
          input: [{ type: 'text', text: 'Before' }],
          clientUserMessageId: 'client-1',
        })
        if (method === STEER_QUEUE_UPDATE) {
          return Promise.reject(new Error('queued submission not found: queued-1'))
        }
        if (method === STEER_QUEUE_LIST) return Promise.resolve([])
        throw new Error(`unexpected method: ${method}`)
      }),
    } as unknown as ClientHostService
    const queue = new SteerQueue(host)

    await queue.enqueue('thread-1', {
      text: 'Before',
      images: [],
      attachments: [],
      skills: [],
    })

    await expect(queue.update('queued-1', {
      text: 'After',
      images: [],
      attachments: [],
      skills: [],
    })).resolves.toBeUndefined()
    expect(queue.snapshot()).toEqual([])
  })
})
