import type { SteerQueue } from './steer.client.js'

export const STEER_QUEUE_LIST = 'steer.queue.list'
export const STEER_QUEUE_ADD = 'steer.queue.add'
export const STEER_QUEUE_UPDATE = 'steer.queue.update'
export const STEER_QUEUE_DELETE = 'steer.queue.delete'
export const STEER_QUEUE_REORDER = 'steer.queue.reorder'
export const STEER_QUEUE_START = 'steer.queue.start'

export interface ClientSteerService {
  readonly queue: SteerQueue
}

declare module 'cordis' {
  interface Context {
    clientSteer: ClientSteerService
  }
}
