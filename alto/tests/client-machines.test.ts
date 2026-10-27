import { describe, expect, it } from 'vitest'
import {
  deriveAgentStatus,
  initialLink,
  initialTurn,
  stepLink,
  stepTurn,
} from '../program/plugins/ui/machines.js'

describe('client state machines', () => {
  it('allows only the turn lifecycle idle → sending → running → idle', () => {
    expect(stepTurn(initialTurn, 'accept')).toBe(initialTurn)

    const sending = stepTurn(initialTurn, 'submit')
    expect(sending).toEqual({ tag: 'sending' })
    expect(stepTurn(sending, 'submit')).toBe(sending)

    const running = stepTurn(sending, 'accept')
    expect(running).toEqual({ tag: 'running' })
    expect(stepTurn(running, 'accept')).toBe(running)
    expect(stepTurn(running, 'settle')).toBe(initialTurn)
  })

  it('keeps link failures attached while reconnecting and clears them on open', () => {
    const failed = stepLink(initialLink, {
      tag: 'socket-failed',
      problem: 'offline',
    })
    expect(stepLink(failed, { tag: 'closed' })).toEqual({
      tag: 'retrying',
      problem: 'offline',
    })
    expect(stepLink(failed, { tag: 'opened' })).toEqual({ tag: 'online' })
  })

  it('projects lifecycle state into one user-facing status', () => {
    expect(deriveAgentStatus({ tag: 'online' }, { tag: 'sending' }, 'ready')).toEqual({
      state: 'running',
      label: 'Sending',
    })
    expect(deriveAgentStatus({ tag: 'retrying' }, initialTurn, 'ready')).toEqual({
      state: 'failed',
      label: 'Disconnected',
    })
  })
})
