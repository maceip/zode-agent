import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startWorktreeStatusRefresh } from '../program/plugins/work-contexts-refresh.js'

describe('focused worktree status refresh', () => {
  let dispose: (() => void) | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers() })

  function setup() {
    let focused = true
    const visibility = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => focused })
    const focus = new EventTarget()
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    return {
      visibility, focus, refresh,
      setFocus(value: boolean) { focused = value; focus.dispatchEvent(new Event(value ? 'focus' : 'blur')) },
      start() { dispose = startWorktreeStatusRefresh(refresh, visibility, focus) },
    }
  }

  it('refreshes only the focused checkout once a minute', async () => {
    const run = setup()
    run.start()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run.refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(run.refresh).toHaveBeenCalledTimes(2)
  })

  it('does no background polling while hidden or unfocused and refreshes on return', async () => {
    const run = setup()
    run.visibility.hidden = true
    run.start()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(run.refresh).not.toHaveBeenCalled()
    run.visibility.hidden = false
    run.visibility.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(run.refresh).toHaveBeenCalledOnce()
    run.setFocus(false)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(run.refresh).toHaveBeenCalledOnce()
    run.setFocus(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.refresh).toHaveBeenCalledTimes(2)
  })

  it('does not overlap slow requests or restart polling when they finish hidden', async () => {
    const run = setup()
    let finish!: () => void
    run.refresh.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    run.start()
    await vi.advanceTimersByTimeAsync(0)
    run.focus.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(180_000)
    expect(run.refresh).toHaveBeenCalledOnce()
    run.setFocus(false)
    finish()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(run.refresh).toHaveBeenCalledOnce()
    run.setFocus(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.refresh).toHaveBeenCalledTimes(2)
  })

  it('backs off failures and stops all work when the pane is deactivated', async () => {
    const run = setup()
    run.refresh.mockRejectedValue(new Error('disconnected'))
    run.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run.refresh).toHaveBeenCalledTimes(2)
    dispose?.()
    run.visibility.dispatchEvent(new Event('visibilitychange'))
    run.focus.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(180_000)
    expect(run.refresh).toHaveBeenCalledTimes(2)
  })

  it('cancels an initial request if the pane unmounts before it starts', async () => {
    const run = setup()
    run.start()
    dispose?.()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(run.refresh).not.toHaveBeenCalled()
  })
})
