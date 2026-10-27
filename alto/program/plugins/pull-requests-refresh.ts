import type { ClientHostService } from '../../src/client/plugin-api.js'
import { PR_REFRESH, PR_REFRESH_INTERVAL } from './pull-requests-api.js'

export function startPullRequestPolling(
  host: ClientHostService,
  report: (error: string | null) => void,
  visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document,
): { refresh(force?: boolean): void; dispose(): void } {
  let disposed = false
  let pending = false
  let failures = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  const connectionKey = (): string => {
    const state = host.snapshot()
    return `${state.connected}:${state.connectionEpoch}:${state.snapshot?.program.revision}`
  }
  let connection = connectionKey()
  const schedule = (delay: number): void => {
    clearTimeout(retry)
    retry = setTimeout(() => refresh(), delay)
  }
  function refresh(force = false): void {
    if (disposed || pending || visibility.hidden || !host.snapshot().connected) return
    clearTimeout(retry)
    if (force) failures = 0
    pending = true
    const startedConnection = connection
    void Promise.resolve().then(() => host.call(PR_REFRESH, { force })).then(() => {
      if (disposed || connection !== startedConnection) return
      failures = 0
      report(null)
    }).catch((error: unknown) => {
      if (disposed || connection !== startedConnection) return
      const message = error instanceof Error ? error.message : String(error)
      const transient = /browser program revision .* incompatible with server revision|the harness is not connected|connection (?:closed|lost before the harness replied)|unknown client extension method: pull-requests\.refresh/.test(message)
      if (transient && failures < 3) {
        schedule([250, 750, 1500][failures++]!)
        return
      }
      report(`Could not refresh pull requests: ${message.slice(0, 240)}`)
    }).finally(() => {
      pending = false
      if (!disposed && connection !== startedConnection) schedule(0)
    })
  }
  const unsubscribe = host.subscribe(() => {
    const next = connectionKey()
    if (next === connection) return
    connection = next
    failures = 0
    schedule(0)
  })
  const onVisibility = (): void => refresh()
  visibility.addEventListener('visibilitychange', onVisibility)
  const interval = setInterval(() => refresh(), PR_REFRESH_INTERVAL)
  refresh()
  return {
    refresh,
    dispose(): void {
      disposed = true
      clearTimeout(retry)
      clearInterval(interval)
      unsubscribe()
      visibility.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
