import { renderToStaticMarkup } from 'react-dom/server'
import { Context, type Plugin } from 'cordis'
import { describe, expect, it } from 'vitest'
import type {
  ClientHostService,
  ClientHostSnapshot,
} from '../src/client/plugin-api.js'
import type { HarnessEvent, ThreadSummary } from '../src/shared/protocol.js'
import type {
  ClientSessionService,
  ClientSessionSnapshot,
} from '../program/plugins/session-api.js'
import { ThreadStatusService } from '../program/plugins/thread-status.client.js'
import {
  aggregateThreadWorkStatus,
  OptionalThreadStatusService,
  threadWorkStatus,
  type ClientThreadStatusService,
} from '../program/plugins/thread-status-api.js'
import { HistoryPanel } from '../program/plugins/ui/history.js'
import { ThreadStatusIndicator } from '../program/plugins/ui/thread-status.js'

function installBrowserGlobals(): () => void {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const values = new Map<string, string>()
  const browserWindow = new EventTarget() as EventTarget & {
    localStorage: Pick<Storage, 'getItem' | 'setItem'>
    setTimeout: typeof window.setTimeout
    clearTimeout: typeof window.clearTimeout
  }
  browserWindow.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  browserWindow.setTimeout = globalThis.setTimeout as unknown as typeof window.setTimeout
  browserWindow.clearTimeout = globalThis.clearTimeout as unknown as typeof window.clearTimeout
  const browserDocument = new EventTarget()
  Object.defineProperty(browserDocument, 'visibilityState', { value: 'visible' })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browserDocument })
  return () => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete (globalThis as { window?: Window }).window
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete (globalThis as { document?: Document }).document
  }
}

function sessionSnapshot(threadId = 'thread-a'): ClientSessionSnapshot {
  return {
    revision: 0,
    connected: true,
    session: { workspace: '/tmp/project', permissionMode: 'ask' },
    turn: { tag: 'idle' },
    threadId,
    agentStatus: { state: 'idle', label: 'Ready' },
    activities: [],
    hasEarlierActivities: false,
    loadingEarlierActivities: false,
    history: { tag: 'ready', entries: [] },
    threads: [],
    projects: [],
    skills: [],
  }
}

describe('chat status', () => {
  it('restores unacknowledged completions newest first rather than sorting by chat ID', () => {
    const restore = installBrowserGlobals()
    const now = Date.now()
    window.localStorage.setItem('codex-cordis.thread-status', JSON.stringify({
      version: 1, finished: [['a-old', now - 2000], ['z-new', now - 1000]],
    }))
    const host = {
      snapshot: () => ({ snapshot: { codex: { activeThreadIds: [] } } }),
      journal: () => [], onEvent: () => () => {},
    } as unknown as ClientHostService
    const session = { snapshot: () => sessionSnapshot(), subscribe: () => () => {} } as unknown as ClientSessionService
    const service = new ThreadStatusService(host, session)
    try {
      expect(service.snapshot().finished).toEqual(['z-new', 'a-old'])
      service.acknowledge('z-new')
      expect(service.snapshot().finished).toEqual(['a-old'])
    } finally { service.dispose(); restore() }
  })

  it('tracks per-thread work and acknowledges a completed chat when it is opened', () => {
    const restore = installBrowserGlobals()
    let hostListener = (_event: HarnessEvent): void => undefined
    let sessionListener = (): void => undefined
    let currentSession = sessionSnapshot()
    const host = {
      snapshot: () => ({
        revision: 0,
        connection: 'online',
        connected: true,
        snapshot: {
          codex: { activeThreadIds: [] },
        },
      } as unknown as ClientHostSnapshot),
      journal: () => [],
      onEvent: (listener: (event: HarnessEvent) => void) => {
        hostListener = listener
        return () => undefined
      },
    } as unknown as ClientHostService
    const session = {
      snapshot: () => currentSession,
      subscribe: (listener: () => void) => {
        sessionListener = listener
        return () => undefined
      },
    } as unknown as ClientSessionService
    const service = new ThreadStatusService(host, session)

    try {
      hostListener({
        type: 'codex.notification',
        payload: { method: 'turn/started', params: { threadId: 'thread-b' } },
      })
      expect(threadWorkStatus(service.snapshot(), 'thread-b')).toBe('running')

      hostListener({
        type: 'codex.status',
        payload: { status: 'ready', models: [], activeThreadIds: [] },
      })
      expect(threadWorkStatus(service.snapshot(), 'thread-b')).toBe('finished')

      currentSession = sessionSnapshot('thread-b')
      sessionListener()
      expect(threadWorkStatus(service.snapshot(), 'thread-b')).toBeUndefined()
    } finally {
      service.dispose()
      restore()
    }
  })

  it('uses the same compact indicator for running and completed work', () => {
    const running = renderToStaticMarkup(<ThreadStatusIndicator status="running" />)
    const finished = renderToStaticMarkup(<ThreadStatusIndicator status="finished" />)
    expect(running).toContain('data-thread-status="running"')
    expect(running).toContain('aria-label="Working"')
    expect(running).toContain('lucide-loader-circle')
    expect(finished).toContain('data-thread-status="finished"')
    expect(finished).toContain('aria-label="Recently finished"')
  })

  it('prioritizes running work when a workspace tab contains several chats', () => {
    const status = {
      revision: 1,
      running: ['thread-running'],
      finished: ['thread-finished'],
    }

    expect(aggregateThreadWorkStatus(status, ['thread-finished'])).toBe('finished')
    expect(aggregateThreadWorkStatus(status, ['thread-finished', 'thread-running']))
      .toBe('running')
    expect(aggregateThreadWorkStatus(status, ['thread-idle'])).toBeUndefined()
  })

  it('hides work status for the selected chat in the sidebar', () => {
    const entries: ThreadSummary[] = [
      {
        id: 'thread-a',
        title: 'Selected chat',
        preview: '',
        cwd: '/tmp/project',
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'thread-b',
        title: 'Other chat',
        preview: '',
        cwd: '/tmp/project',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const statusQueries: string[] = []
    const html = renderToStaticMarkup(
      <HistoryPanel
        label=""
        state={{ tag: 'ready', entries }}
        activeThreadId="thread-a"
        projects={[]}
        disabled={false}
        statusFor={(threadId) => {
          statusQueries.push(threadId)
          return 'running'
        }}
        onNewThread={() => undefined}
        onOpen={() => undefined}
        onRename={async () => undefined}
        onRetry={() => undefined}
      />,
    )

    expect(statusQueries).toEqual(['thread-b'])
    expect(html.match(/data-thread-status="running"/g)).toHaveLength(1)
  })

  it('keeps consumers alive while the optional status provider unloads and reloads', async () => {
    const ctx = new Context()
    let reader: OptionalThreadStatusService | undefined
    const consumer: Plugin = (owner) => {
      reader = new OptionalThreadStatusService(owner)
      return () => reader?.dispose()
    }
    const consumerFiber = await ctx.plugin(consumer)
    expect(reader?.snapshot()).toMatchObject({ running: [], finished: [] })

    const status = (threadId: string): ClientThreadStatusService => ({
      subscribe: () => () => undefined,
      snapshot: () => ({ revision: 1, running: [threadId], finished: [] }),
      acknowledge: () => undefined,
    })
    const provide = (service: ClientThreadStatusService): Plugin => {
      const plugin: Plugin = (owner) => owner.provide('clientThreadStatus', service)
      plugin.provide = 'clientThreadStatus'
      return plugin
    }

    const firstProvider = await ctx.plugin(provide(status('thread-a')))
    expect(reader?.snapshot().running).toEqual(['thread-a'])

    await firstProvider.dispose()
    expect(reader?.snapshot()).toMatchObject({ running: [], finished: [] })

    const secondProvider = await ctx.plugin(provide(status('thread-b')))
    expect(reader?.snapshot().running).toEqual(['thread-b'])

    await secondProvider.dispose()
    await consumerFiber.dispose()
  })
})
