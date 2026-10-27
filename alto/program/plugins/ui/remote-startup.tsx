import { Cloud } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ClientSessionSnapshot } from '../session-api.js'
import { WorkingShimmer } from './working-shimmer.js'

export function RemoteSessionStartup({
  state,
  visible,
}: {
  state: Pick<ClientSessionSnapshot, 'remoteLocation' | 'remoteStarting'>
  visible: boolean
}): ReactNode {
  if (!state.remoteLocation || !state.remoteStarting) return null

  return (
    <span className="activity-turn-label activity-turn-live-trace" role="status" aria-live="polite">
      <Cloud size="1em" aria-hidden="true" />
      <WorkingShimmer className="activity-turn-label" active={visible}>
        {`Starting ${state.remoteLocation}…`}
      </WorkingShimmer>
    </span>
  )
}
