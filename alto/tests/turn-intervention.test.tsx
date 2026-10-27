import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ClientDraft } from '../src/client/plugin-api.js'
import type { HarnessSnapshot, PendingServerRequest } from '../src/shared/protocol.js'
import type { ClientSessionService, ClientSessionSnapshot } from '../program/plugins/session-api.js'
import { createSteerSubmitMiddleware, SteerQueue } from '../program/plugins/steer.client.js'
import { ActivityTimeline, type ActivityItem } from '../program/plugins/ui/activity.js'
import { acceptsImmediateReply, threadIntervention } from '../program/plugins/ui/turn-intervention.js'

function harness(flags: string[] = [], pendingRequests: PendingServerRequest[] = []): HarnessSnapshot {
  return {
    codex: {
      status: 'ready', models: [], activeThreadIds: ['waiting', 'working'],
      threadStates: {
        waiting: { status: { type: 'active', activeFlags: flags } },
        working: { status: { type: 'active', activeFlags: [] } },
      },
    },
    pendingRequests,
    program: { revision: 0, profileText: '', plugins: [], files: [], tools: [], proposals: [] },
    projects: { revision: 0, projects: [] },
    ui: { regions: [], surfaces: [], contributions: [] },
    extensions: {},
    server: { port: 4317, host: '127.0.0.1', projectRoot: '/tmp/project' },
  }
}

function question(isBlocking = true): PendingServerRequest {
  return { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'waiting', isBlocking }, receivedAt: '' }
}

describe('turn interventions', () => {
  it('uses live wait flags for the addressed thread and ignores stale flags on idle threads', () => {
    const state = harness(['waitingOnUserInput'])
    expect(threadIntervention(state, 'waiting')).toBe('input')
    expect(acceptsImmediateReply(state, 'waiting')).toBe(true)
    expect(threadIntervention(state, 'working')).toBeUndefined()
    expect(acceptsImmediateReply(state, 'working')).toBe(false)
    expect(threadIntervention(state, undefined)).toBeUndefined()
    state.codex.threadStates!.waiting!.status.type = 'idle'
    expect(threadIntervention(state, 'waiting')).toBeUndefined()
  })

  it('pauses for blocking native requests without treating ordinary chat input as their answer', () => {
    const state = harness([], [question()])
    expect(threadIntervention(state, 'waiting')).toBe('input')
    expect(acceptsImmediateReply(state, 'waiting')).toBe(false)
    state.codex.threadStates!.waiting!.status.activeFlags = ['waitingOnUserInput']
    expect(acceptsImmediateReply(state, 'waiting')).toBe(false)
    expect(threadIntervention(harness([], [question(false)]), 'waiting')).toBeUndefined()
    state.pendingRequests = [{ ...question(), method: 'item/commandExecution/requestApproval' }]
    expect(threadIntervention(state, 'waiting')).toBe('approval')
    expect(acceptsImmediateReply(state, 'waiting')).toBe(false)
    expect(threadIntervention(harness(['waitingOnApproval']), 'waiting')).toBe('approval')
  })

  it('sends replies to the waiting pane without creating a queue entry, and resumes queueing after the wait', async () => {
    const state = { threadId: 'working', turn: { tag: 'running' }, harness: harness(['waitingOnUserInput']) } as ClientSessionSnapshot
    const session = { snapshot: () => state, steer: vi.fn() } as unknown as ClientSessionService
    const queue = new SteerQueue()
    const enqueue = vi.spyOn(queue, 'enqueue')
    const middleware = createSteerSubmitMiddleware(queue, session)
    const next = vi.fn()
    const target = { id: 'pane-waiting', threadId: 'waiting', activeTurn: true, steer: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
    const draft: ClientDraft = { text: 'Use the current workspace', images: [], attachments: [], skills: [] }

    await middleware(draft, next, { mode: 'queue', target })
    expect(target.steer).toHaveBeenCalledWith(draft)
    expect(session.steer).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()

    target.steer.mockRejectedValueOnce(new Error('Connection lost'))
    await expect(middleware(draft, next, { mode: 'queue', target })).rejects.toThrow('Connection lost')
    expect(enqueue).not.toHaveBeenCalled()

    state.harness = harness([])
    await middleware(draft, next, { mode: 'queue', target })
    expect(enqueue).toHaveBeenCalledWith('waiting', draft)
    expect(queue.snapshot()).toHaveLength(1)

    target.activeTurn = false
    state.harness = harness(['waitingOnUserInput'])
    await middleware(draft, next, { mode: 'queue', target })
    expect(next).toHaveBeenCalledWith(draft)
  })

  it('does not make another pane send immediately because the focused pane is waiting', async () => {
    const state = { threadId: 'waiting', turn: { tag: 'running' }, harness: harness(['waitingOnUserInput']) } as ClientSessionSnapshot
    const session = { snapshot: () => state } as ClientSessionService
    const queue = new SteerQueue()
    const target = { id: 'pane-working', threadId: 'working', activeTurn: true, steer: vi.fn(), send: vi.fn() }
    await createSteerSubmitMiddleware(queue, session)(
      { text: 'Later', images: [], attachments: [], skills: [] }, vi.fn(), { mode: 'queue', target },
    )
    expect(target.steer).not.toHaveBeenCalled()
    expect(queue.snapshot().map((message) => message.threadId)).toEqual(['working'])
  })

  it('replaces the working timer and trace shimmer while keeping the active turn expanded', () => {
    const items: ActivityItem[] = [
      { id: 'user', kind: 'user', title: 'You', content: 'Make the change', timestamp: '' },
      { id: 'trace', kind: 'reasoning', title: 'Thinking', content: 'Checking the scope', status: 'completed', timestamp: '' },
      { id: 'question', kind: 'agent', title: 'Astra', content: 'Which workspace?', timestamp: '', phase: 'final_answer' },
    ]
    const working = renderToStaticMarkup(<ActivityTimeline items={items} active />)
    expect(working).toContain('activity-turn-live-trace')
    for (const waitingFor of ['input', 'approval'] as const) {
      const html = renderToStaticMarkup(<ActivityTimeline items={items} active waitingFor={waitingFor} />)
      expect(html).toContain(waitingFor === 'input' ? 'Waiting for your reply' : 'Waiting for approval')
      expect(html).toContain('activity-turn-running')
      expect(html).toContain('Checking the scope')
      expect(html).toContain('Which workspace?')
      expect(html).not.toContain('activity-turn-live-trace')
      expect(html).not.toContain('activity-active-trace')
      expect(html).not.toContain('Working for')
      expect(html).not.toContain('Stopped')
    }
  })
})
