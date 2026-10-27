import type { ClientHostService } from '../../src/client/plugin-api.js'
import { EMPTY_PR_SNAPSHOT, PR_STATE, type PullRequestSnapshot } from './pull-requests-api.js'

export function pullRequestViewStore(host: ClientHostService) {
  let key = ''
  let value = { snapshot: EMPTY_PR_SNAPSHOT, connected: false }
  return {
    subscribe: host.subscribe,
    snapshot: () => {
      const state = host.snapshot()
      const snapshot = (state.snapshot?.extensions[PR_STATE] as unknown as PullRequestSnapshot | undefined) ?? EMPTY_PR_SNAPSHOT
      const nextKey = JSON.stringify([state.connected, snapshot.phase, snapshot.fetchedAt, snapshot.error, snapshot.viewer, snapshot.total, snapshot.complete, snapshot.items.length])
      if (key !== nextKey) {
        key = nextKey
        value = { snapshot, connected: state.connected }
      }
      return value
    },
  }
}
