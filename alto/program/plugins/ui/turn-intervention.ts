import type { HarnessSnapshot } from '../../../src/shared/protocol.js'

export type TurnIntervention = 'input' | 'approval'

export function threadIntervention(
  harness: HarnessSnapshot | undefined,
  threadId: string | undefined,
): TurnIntervention | undefined {
  if (!harness || !threadId) return undefined
  const status = harness.codex.threadStates?.[threadId]?.status
  const flags = status?.type === 'active' ? status.activeFlags ?? [] : []
  const requests = (harness.pendingRequests ?? []).filter((request) => (
    request.params.threadId === threadId && request.params.isBlocking !== false
  ))
  if (flags.includes('waitingOnApproval') || requests.some((request) => request.method.endsWith('/requestApproval'))) {
    return 'approval'
  }
  if (flags.includes('waitingOnUserInput') || requests.some((request) => (request.method === 'item/tool/requestUserInput' || request.method === 'agent/requestUserInput'))) {
    return 'input'
  }
  return undefined
}

export function acceptsImmediateReply(
  harness: HarnessSnapshot | undefined,
  threadId: string | undefined,
): boolean {
  if (threadIntervention(harness, threadId) !== 'input') return false
  // Native questions need a response to their request ID. Only an agent
  // waiting for ordinary chat input can be resumed by steering the turn.
  return !harness?.pendingRequests?.some((request) => (
    request.params.threadId === threadId && (request.method === 'item/tool/requestUserInput' || request.method === 'agent/requestUserInput')
  ))
}
