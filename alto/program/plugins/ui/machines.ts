import type { HarnessSnapshot } from '../../../src/shared/protocol.js'

export type LinkState =
  | { tag: 'connecting'; problem?: string }
  | { tag: 'online'; problem?: string }
  | { tag: 'retrying'; problem?: string }

export type LinkEvent =
  | { tag: 'opened' }
  | { tag: 'protocol-failed'; problem: string }
  | { tag: 'socket-failed'; problem: string }
  | { tag: 'closed' }

export const initialLink: LinkState = { tag: 'connecting' }

export function stepLink(state: LinkState, event: LinkEvent): LinkState {
  switch (event.tag) {
    case 'opened':
      return { tag: 'online' }
    case 'protocol-failed':
      return { tag: 'online', problem: event.problem }
    case 'socket-failed':
      return { tag: 'retrying', problem: event.problem }
    case 'closed':
      return state.problem
        ? { tag: 'retrying', problem: state.problem }
        : { tag: 'retrying' }
  }
}

export type TurnState =
  | { tag: 'idle' }
  | { tag: 'sending' }
  | { tag: 'running' }

export type TurnEvent = 'submit' | 'accept' | 'settle'

export const initialTurn: TurnState = { tag: 'idle' }

export function stepTurn(state: TurnState, event: TurnEvent): TurnState {
  switch (event) {
    case 'submit':
      return state.tag === 'idle' ? { tag: 'sending' } : state
    case 'accept':
      return state.tag === 'sending' ? { tag: 'running' } : state
    case 'settle':
      return initialTurn
  }
}

export interface AgentStatus {
  state: string
  label: string
}

export function deriveAgentStatus(
  link: LinkState,
  turn: TurnState,
  codex: HarnessSnapshot['codex']['status'],
): AgentStatus {
  if (link.tag !== 'online') return { state: 'failed', label: 'Disconnected' }
  if (turn.tag === 'running') return { state: 'running', label: 'Working' }
  if (turn.tag === 'sending') return { state: 'running', label: 'Sending' }

  switch (codex) {
    case 'ready': return { state: 'ready', label: 'Ready' }
    case 'failed': return { state: 'failed', label: 'Failed' }
    case 'starting': return { state: 'starting', label: 'Starting' }
    case 'stopped': return { state: 'stopped', label: 'Stopped' }
  }
}
