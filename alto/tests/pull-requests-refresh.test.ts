import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientHostService, ClientHostSnapshot } from '../src/client/plugin-api.js'
import type { HarnessSnapshot } from '../src/shared/protocol.js'
import { startPullRequestPolling } from '../program/plugins/pull-requests-refresh.js'

describe('PR refresh recovery', () => {
  let polling: ReturnType<typeof startPullRequestPolling> | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { polling?.dispose(); polling = undefined; vi.useRealTimers() })

  function setup(connected = true) {
    const listeners = new Set<() => void>()
    const visibility = Object.assign(new EventTarget(), { hidden: false })
    const state: ClientHostSnapshot = {
      revision: 0, connected, connection: connected ? 'online' : 'retrying', connectionEpoch: 1,
      snapshot: { program: { revision: 1 } } as HarnessSnapshot,
    }
    const call = vi.fn().mockResolvedValue(null)
    const host = {
      snapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      call,
    } as unknown as ClientHostService
    const report = vi.fn()
    return { state, call, report, listeners, visibility, changed: () => listeners.forEach((listener) => listener()),
      start: () => { polling = startPullRequestPolling(host, report, visibility); return polling } }
  }

  it('retries an activation mismatch without leaving a false service warning', async () => {
    const run = setup()
    run.call.mockRejectedValueOnce(new Error('browser program revision 1 is incompatible with server revision 2'))
    run.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.report).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(run.call).toHaveBeenCalledTimes(2)
    expect(run.report).toHaveBeenLastCalledWith(null)
  })

  it('waits for connection and refreshes immediately after reconnecting', async () => {
    const run = setup(false)
    run.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run.call).not.toHaveBeenCalled()
    run.state.connected = true
    run.state.connectionEpoch++
    run.changed()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.call).toHaveBeenCalledOnce()
    expect(run.report).toHaveBeenLastCalledWith(null)
  })

  it('refreshes for a new program revision but not unrelated snapshot updates', async () => {
    const run = setup()
    run.start()
    await vi.advanceTimersByTimeAsync(0)
    run.changed()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.call).toHaveBeenCalledOnce()
    run.state.snapshot!.program.revision++
    run.changed()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.call).toHaveBeenCalledTimes(2)
  })

  it('keeps the actual failure and lets manual Refresh clear it', async () => {
    const run = setup()
    run.call.mockRejectedValueOnce(new Error('service unavailable'))
    const poll = run.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.report).toHaveBeenLastCalledWith('Could not refresh pull requests: service unavailable')
    poll.refresh(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.call).toHaveBeenLastCalledWith('pull-requests.refresh', { force: true })
    expect(run.report).toHaveBeenLastCalledWith(null)
  })

  it('bounds retries if a method remains unavailable', async () => {
    const run = setup()
    run.call.mockRejectedValue(new Error('unknown client extension method: pull-requests.refresh'))
    run.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(run.call).toHaveBeenCalledTimes(4)
    expect(run.report).toHaveBeenCalledOnce()
    expect(run.report.mock.calls[0]?.[0]).toContain('unknown client extension method')
  })

  it('pauses in a hidden app and refreshes when it becomes visible', async () => {
    const run = setup()
    run.visibility.hidden = true
    run.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run.call).not.toHaveBeenCalled()
    run.visibility.hidden = false
    run.visibility.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(run.call).toHaveBeenCalledOnce()
  })

  it('ignores an old connection failure and starts again with the new connection', async () => {
    const run = setup()
    let reject: ((error: Error) => void) | undefined
    run.call.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
    run.start()
    await vi.advanceTimersByTimeAsync(0)
    run.state.connectionEpoch++
    run.changed()
    await vi.advanceTimersByTimeAsync(0)
    reject?.(new Error('connection lost before the harness replied'))
    await vi.advanceTimersByTimeAsync(1)
    expect(run.call).toHaveBeenCalledTimes(2)
    expect(run.report).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('cancels scheduled retries and subscriptions when the panel closes', async () => {
    const run = setup()
    run.call.mockRejectedValueOnce(new Error('the harness is not connected'))
    const poll = run.start()
    await vi.advanceTimersByTimeAsync(0)
    poll.dispose()
    expect(run.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run.call).toHaveBeenCalledOnce()
    expect(run.report).not.toHaveBeenCalled()
  })
})
