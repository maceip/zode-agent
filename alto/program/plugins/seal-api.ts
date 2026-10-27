export const SEAL_STATE = 'seal.inbox'
export const SEAL_PRESENCE = 'seal.presence'
export const SEAL_CLAIM = 'seal.claim'
export const SEAL_RESULT = 'seal.result'
export const SEAL_MAX_BYTES = 1024 * 1024

export interface SealTarget {
  clientId: string
  workspaceId: string
  paneId: string
  workspace: string
  threadId?: string
  title: string
}

export interface SealRequest {
  id: string
  text: string
  context: string
  mode: 'queue' | 'steer'
  target: SealTarget
}

export interface SealResult {
  ok: boolean
  error?: string
  target?: SealTarget
}
