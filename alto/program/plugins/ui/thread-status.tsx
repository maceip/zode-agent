import { LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ThreadWorkStatus } from '../thread-status-api.js'

export function ThreadStatusIndicator({
  status,
}: {
  status: ThreadWorkStatus | undefined
}): ReactNode {
  if (!status) return null
  const label = status === 'running' ? 'Working' : 'Recently finished'
  return (
    <span
      className={`thread-status-indicator ${status}`}
      data-thread-status={status}
      aria-label={label}
      title={label}
    >
      {status === 'running'
        ? <LoaderCircle size={12} strokeWidth={2} aria-hidden="true" />
        : <i aria-hidden="true" />}
    </span>
  )
}
