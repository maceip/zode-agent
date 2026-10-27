import type { ReactNode } from 'react'
import type { ClientSessionService } from './session-api.js'

export const TURN_PROGRESS_ACCESSORY = 'turn-progress-accessory'
export interface TurnProgressAccessory {
  content: ReactNode
  details?: ReactNode
  label: string
}
export interface TurnProgressAccessoryProps {
  session: ClientSessionService
  render(accessory?: TurnProgressAccessory): ReactNode
}
