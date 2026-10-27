import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRpc } from '../src/server/services/remote-rpc.js'
import type { RemoteAgentBackend, RemoteAgentRecord } from '../src/server/services/remote-agent-api.js'

afterEach(() => vi.useRealTimers())
describe('remote RPC transport', () => {
  it('resumes after a dropped stream, reconnects while idle, and never resends an ambiguous write', async () => {
    let follows = 0
    const reads: Array<{ after?: string; follow: boolean }> = []
    const states: string[] = []
    const messages: unknown[] = []
    const backend = {
      id: 'test', label: 'Test', agents: [],
      async *read(_process, options) {
        reads.push({ ...(options.after ? { after: options.after } : {}), follow: options.follow })
        if (!options.follow) {
          if (!options.after) yield { stream: 'output', cursor: '1', timestamp: '', text: '{"method":"ready"}\n' } satisfies RemoteAgentRecord
          return
        }
        if (++follows === 1) throw new Error('Network dropped')
        await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      },
      send: vi.fn(async () => { throw new Error('Response lost after delivery') }),
      create: vi.fn(), terminate: vi.fn(),
    } satisfies RemoteAgentBackend
    const rpc = new RemoteRpc(backend, { id: '1', cwd: '/repo', data: {} }, {
      message: (_direction, value) => messages.push(value), connection: (state) => states.push(state),
    })
    try {
      await rpc.attach()
      await vi.waitFor(() => expect(states).toEqual(['connecting', 'connected', 'disconnected', 'connected']), { timeout: 2500 })
      expect(messages).toEqual([{ method: 'ready' }])
      expect(reads.slice(1).every((read) => read.after === '1')).toBe(true)
      await expect(rpc.send({ method: 'session/prompt' })).rejects.toThrow('Response lost')
      expect(backend.send).toHaveBeenCalledTimes(1)
    } finally { await rpc.detach() }
    expect(backend.terminate).not.toHaveBeenCalled()
  })
})
