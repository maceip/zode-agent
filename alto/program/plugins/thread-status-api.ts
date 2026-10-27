import type { Context } from 'cordis'

export type ThreadWorkStatus = 'running' | 'finished'

export interface ClientThreadStatusSnapshot {
  revision: number
  running: readonly string[]
  /** Unacknowledged completions, newest first. */
  finished: readonly string[]
}

export interface ClientThreadStatusService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientThreadStatusSnapshot
  acknowledge(threadId: string): void
}

const EMPTY_THREAD_STATUS: ClientThreadStatusSnapshot = Object.freeze({
  revision: 0,
  running: Object.freeze([]),
  finished: Object.freeze([]),
})

/**
 * Chat lists are useful without the optional status plugin. This adapter follows
 * the service as its fiber is loaded or unloaded, while presenting one stable
 * external store to React consumers.
 */
export class OptionalThreadStatusService implements ClientThreadStatusService {
  private readonly listeners = new Set<() => void>()
  private current: ClientThreadStatusService | undefined
  private currentSnapshot: ClientThreadStatusSnapshot = EMPTY_THREAD_STATUS
  private disposeCurrent: (() => void) | undefined
  private readonly disposeServiceEvents: () => unknown
  private disposed = false

  constructor(private readonly ctx: Context) {
    this.rebind()
    this.disposeServiceEvents = ctx.on('internal/service', (name) => {
      if (name === 'clientThreadStatus') this.rebind()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientThreadStatusSnapshot => this.currentSnapshot

  acknowledge(threadId: string): void {
    this.current?.acknowledge(threadId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeServiceEvents()
    this.disposeCurrent?.()
    this.listeners.clear()
  }

  private rebind(): void {
    if (this.disposed) return
    const next = this.ctx.get('clientThreadStatus', false) as ClientThreadStatusService | undefined
    if (next !== this.current) {
      this.disposeCurrent?.()
      this.current = next
      this.disposeCurrent = next?.subscribe(() => this.syncSnapshot())
    }
    this.syncSnapshot()
  }

  private syncSnapshot(): void {
    const next = this.current?.snapshot() ?? EMPTY_THREAD_STATUS
    if (next === this.currentSnapshot) return
    this.currentSnapshot = next
    for (const listener of this.listeners) listener()
  }
}

export function threadWorkStatus(
  snapshot: ClientThreadStatusSnapshot,
  threadId: string,
): ThreadWorkStatus | undefined {
  if (snapshot.running.includes(threadId)) return 'running'
  if (snapshot.finished.includes(threadId)) return 'finished'
  return undefined
}

export function aggregateThreadWorkStatus(
  snapshot: ClientThreadStatusSnapshot,
  threadIds: readonly string[],
): ThreadWorkStatus | undefined {
  let finished = false
  for (const threadId of threadIds) {
    const status = threadWorkStatus(snapshot, threadId)
    if (status === 'running') return 'running'
    if (status === 'finished') finished = true
  }
  return finished ? 'finished' : undefined
}

declare module 'cordis' {
  interface Context {
    clientThreadStatus: ClientThreadStatusService
  }
}
