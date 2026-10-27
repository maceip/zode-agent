import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserHost, controlSecretFromHash } from '../src/client/host.js'
import type { HarnessEvent } from '../src/shared/protocol.js'

type SocketEvent = 'open' | 'message' | 'error' | 'close'

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly instances: FakeWebSocket[] = []

  readonly listeners = new Map<SocketEvent, Array<(event: { data?: unknown }) => void>>()
  readonly url: string
  readonly protocol: string
  readonly sent: string[] = []
  readyState = 0
  closed = false
  sendError?: Error

  constructor(url: string, protocol: string) {
    this.url = url
    this.protocol = protocol
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: SocketEvent, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  send(data: string): void {
    if (this.sendError) throw this.sendError
    this.sent.push(data)
  }

  emit(type: SocketEvent, event: { data?: unknown } = {}): void {
    if (type === 'open') this.readyState = FakeWebSocket.OPEN
    if (type === 'close') this.readyState = 3
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

async function startHost(host: BrowserHost): Promise<{
  socket: FakeWebSocket
  stop: () => void
}> {
  const stop = host.start()
  await vi.advanceTimersByTimeAsync(0)
  const socket = FakeWebSocket.instances.at(-1)!
  socket.emit('open')
  return { socket, stop }
}

describe('browser host transport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances.length = 0
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ protocol: 'alto.test-session' }),
    })))
    vi.stubGlobal('window', {
      location: {
        protocol: 'http:',
        host: '127.0.0.1:4317',
        hash: '#alto-control=test-control-secret',
      },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    })
  })

  it('authenticates socket bootstrap with the launch capability', async () => {
    const host = new BrowserHost()
    const run = await startHost(host)

    expect(fetch).toHaveBeenCalledWith('/__cordis/session', expect.objectContaining({
      headers: { Authorization: 'Bearer test-control-secret' },
    }))
    expect(run.socket.protocol).toBe('alto.test-session')
    run.stop()
  })

  it('parses only the dedicated launch capability fragment', () => {
    expect(controlSecretFromHash('#alto-control=secret-value')).toBe('secret-value')
    expect(controlSecretFromHash('alto-control=secret-value')).toBe('secret-value')
    expect(controlSecretFromHash('#other=value')).toBeUndefined()
    expect(controlSecretFromHash('')).toBeUndefined()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('ignores a stale close instead of opening a second live connection', async () => {
    const host = new BrowserHost()
    const firstRun = await startHost(host)
    const first = firstRun.socket

    firstRun.stop()
    const secondRun = await startHost(host)

    first.emit('close')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(host.snapshot()).toMatchObject({ connection: 'online', connected: true })
    secondRun.stop()
  })

  it('does not project messages from a replaced socket', async () => {
    const host = new BrowserHost()
    const events: HarnessEvent[] = []
    host.onEvent((event) => events.push(event))
    const firstRun = await startHost(host)
    const first = firstRun.socket

    firstRun.stop()
    const secondRun = await startHost(host)
    const second = secondRun.socket
    const event: HarnessEvent = {
      type: 'codex.notification',
      payload: {
        method: 'item/agentMessage/delta',
        params: { itemId: 'agent-1', delta: 'one chunk' },
      },
    }

    first.emit('message', { data: JSON.stringify(event) })
    second.emit('message', { data: JSON.stringify(event) })

    expect(events).toEqual([event])
    expect(host.journal()).toEqual([])
    secondRun.stop()
  })

  it('delivers raw notifications without invalidating snapshot subscribers', async () => {
    const host = new BrowserHost()
    const changed = vi.fn()
    const received = vi.fn()
    host.subscribe(changed)
    host.onEvent(received)
    const run = await startHost(host)
    changed.mockClear()
    const event: HarnessEvent = {
      type: 'codex.notification',
      payload: {
        method: 'item/agentMessage/delta',
        params: { itemId: 'agent-1', delta: 'one chunk' },
      },
    }

    run.socket.emit('message', { data: JSON.stringify(event) })

    expect(received).toHaveBeenCalledWith(event)
    expect(changed).not.toHaveBeenCalled()
    run.stop()
  })

  it('rejects in-flight commands when the connection is lost', async () => {
    const host = new BrowserHost()
    const run = await startHost(host)
    const command = host.command('thread.list', { limit: 1 })

    run.socket.emit('close')

    await expect(command).rejects.toThrow('connection lost')
    run.stop()
  })

  it('times out a command that never receives a result', async () => {
    const host = new BrowserHost()
    const run = await startHost(host)
    const command = host.command('thread.list', { limit: 1 })
    const rejection = expect(command).rejects.toThrow('harness command timed out: thread.list')

    await vi.advanceTimersByTimeAsync(120_000)

    await rejection
    run.stop()
  })

  it('removes a pending command when send throws', async () => {
    const host = new BrowserHost()
    const run = await startHost(host)
    run.socket.sendError = new Error('send failed')

    await expect(host.command('thread.list', { limit: 1 })).rejects.toThrow('send failed')
    run.socket.emit('close')
    run.stop()
  })

  it('bounds replayable events and advances the epoch for fresh snapshots', async () => {
    const host = new BrowserHost()
    const run = await startHost(host)
    const snapshot = {
      codex: { status: 'ready' as const, models: [], activeThreadIds: [] },
      program: { revision: 0, profileText: '', plugins: [], files: [], tools: [], proposals: [] },
      projects: { revision: 0, projects: [] },
      ui: { regions: [], surfaces: [], contributions: [] },
      extensions: {},
      pendingRequests: [],
      server: { port: 4317, host: '127.0.0.1', projectRoot: '/tmp/project' },
    }
    run.socket.emit('message', { data: JSON.stringify({ type: 'snapshot', payload: snapshot }) })
    for (let index = 0; index < 4_100; index += 1) {
      run.socket.emit('message', {
        data: JSON.stringify({ type: 'program.error', payload: { message: String(index) } }),
      })
    }

    expect(host.snapshot().connectionEpoch).toBe(1)
    expect(host.journal()).toHaveLength(4_096)
    expect(host.journal()[0]).toMatchObject({ payload: { message: '4' } })
    run.stop()
  })

  it('bounds the replay journal by retained payload size', async () => {
    const host = new BrowserHost()
    const run = await startHost(host)
    for (let index = 0; index < 6; index += 1) {
      run.socket.emit('message', {
        data: JSON.stringify({
          type: 'program.error',
          payload: { message: `${index}:${'x'.repeat(600_000)}` },
        }),
      })
    }

    expect(host.journal()).toHaveLength(3)
    expect(host.journal().at(-1)).toMatchObject({
      payload: { message: expect.stringMatching(/^5:/) },
    })
    run.stop()
  })
})
