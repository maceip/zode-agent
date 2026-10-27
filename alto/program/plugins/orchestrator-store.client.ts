import type { ClientHostService } from '../../src/client/plugin-api.js'
import { EMPTY_ORCHESTRATOR, ORCHESTRATOR_STATE, type OrchestratorSnapshot } from './orchestrator-api.js'

export function agentViewStore(host: ClientHostService) {
  let previous: OrchestratorSnapshot | undefined
  let value = { snapshot: EMPTY_ORCHESTRATOR, connected: false }
  return {
    subscribe: host.subscribe,
    snapshot: () => {
      const state = host.snapshot()
      const next = (state.snapshot?.extensions[ORCHESTRATOR_STATE] as unknown as OrchestratorSnapshot | undefined) ?? EMPTY_ORCHESTRATOR
      if (previous?.revision !== next.revision || previous?.error !== next.error || value.connected !== state.connected) {
        previous = next
        value = { snapshot: next, connected: state.connected }
      }
      return value
    },
  }
}
