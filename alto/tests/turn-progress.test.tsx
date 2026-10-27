import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  ClientHostService,
  ClientHostSnapshot,
} from '../src/client/plugin-api.js'
import type { HarnessEvent } from '../src/shared/protocol.js'
import type {
  ClientSessionService,
  ClientSessionSnapshot,
} from '../program/plugins/session-api.js'
import type { FileReviewActionProps } from '../program/plugins/chat-surfaces-api.js'
import {
  numberDigits,
  TurnProgressService,
  TurnProgressView,
} from '../program/plugins/turn-progress.client.js'

function sessionSnapshot(threadId = 'thread-a'): ClientSessionSnapshot {
  return {
    revision: 0,
    connected: true,
    session: { workspace: '/tmp/project', permissionMode: 'ask' },
    turn: { tag: 'running' },
    threadId,
    agentStatus: { state: 'working', label: 'Working' },
    activities: [],
    hasEarlierActivities: false,
    loadingEarlierActivities: false,
    history: { tag: 'ready', entries: [] },
    threads: [],
    projects: [],
    skills: [],
  }
}

describe('turn progress', () => {
  it('keeps unchanged decimal places stable between counter updates', () => {
    const before = new Map(numberDigits(15).map((digit) => [digit.place, digit.value]))
    const changed = numberDigits(18).filter((digit) => before.get(digit.place) !== digit.value)

    expect(changed).toEqual([{ place: 0, value: 8 }])
  })

  it('does not mount an empty step popover before any step completes', () => {
    const html = renderToStaticMarkup(<TurnProgressView progress={{
      revision: 1,
      visible: true,
      phase: 'active',
      threadId: 'thread-a',
      turnId: 'turn-a',
      steps: [{ step: 'Keep working', status: 'inProgress' }],
      completedSteps: 0,
      files: [{
        path: '/tmp/project/example.ts',
        kind: 'update',
        diff: '+changed',
        additions: 1,
        deletions: 0,
      }],
      filesChanged: 1,
      additions: 1,
      deletions: 0,
    }} />)

    expect(html).not.toContain('class="turn-progress-details"')
    expect(html).toContain('class="turn-progress-file-details"')
  })

  it('projects live plan and file-change notifications for the active chat', () => {
    let hostListener = (_event: HarnessEvent): void => undefined
    let sessionListener = (): void => undefined
    let currentSession = sessionSnapshot()
    const host = {
      snapshot: () => ({
        revision: 0,
        connection: 'online',
        connected: true,
      } as ClientHostSnapshot),
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
    const service = new TurnProgressService(host, session)

    try {
      hostListener({
        type: 'codex.notification',
        payload: {
          method: 'turn/started',
          params: { threadId: 'thread-a', turn: { id: 'turn-empty', items: [] } },
        },
      })
      hostListener({
        type: 'codex.notification',
        payload: {
          method: 'turn/completed',
          params: { threadId: 'thread-a', turn: { id: 'turn-empty' } },
        },
      })
      expect(service.snapshot()).toMatchObject({ visible: false, phase: 'completed' })

      hostListener({
        type: 'codex.notification',
        payload: {
          method: 'turn/started',
          params: { threadId: 'thread-a', turn: { id: 'turn-a', items: [] } },
        },
      })
      expect(service.snapshot().visible).toBe(false)
      hostListener({
        type: 'codex.notification',
        payload: {
          method: 'turn/plan/updated',
          params: {
            threadId: 'thread-a',
            turnId: 'turn-a',
            plan: [
              { step: 'Trace the bug', status: 'completed' },
              { step: 'Implement the fix', status: 'inProgress' },
              { step: 'Verify behavior', status: 'pending' },
            ],
          },
        },
      })
      const patch = {
        threadId: 'thread-a',
        turnId: 'turn-a',
        itemId: 'file-a',
        changes: [{
          path: '/tmp/project/example.ts',
          kind: { type: 'update' },
          diff: '--- a/example.ts\n+++ b/example.ts\n@@\n-old\n+new\n+another',
        }],
      }
      hostListener({
        type: 'codex.notification',
        payload: {
          method: 'item/fileChange/patchUpdated',
          params: { ...patch, turnId: 'turn-b' },
        },
      })
      expect(service.snapshot().filesChanged).toBe(0)
      hostListener({
        type: 'codex.notification',
        payload: { method: 'item/fileChange/patchUpdated', params: patch },
      })
      hostListener({
        type: 'codex.notification',
        payload: {
          method: 'item/completed',
          params: {
            threadId: 'thread-a',
            turnId: 'turn-a',
            item: { id: 'file-a', type: 'fileChange', status: 'completed', changes: patch.changes },
          },
        },
      })

      expect(service.snapshot()).toMatchObject({
        visible: true,
        phase: 'active',
        threadId: 'thread-a',
        turnId: 'turn-a',
        completedSteps: 1,
        filesChanged: 1,
        additions: 2,
        deletions: 1,
      })
      expect(service.snapshot().files).toEqual([{
        path: '/tmp/project/example.ts',
        kind: 'update',
        diff: '--- a/example.ts\n+++ b/example.ts\n@@\n-old\n+new\n+another',
        additions: 2,
        deletions: 1,
      }])
      const ReviewAction = ({ activityId, files, appearance }: FileReviewActionProps) => (
        <button data-activity-id={activityId} data-appearance={appearance}>Review {files.length}</button>
      )
      const html = renderToStaticMarkup(
        <TurnProgressView
          progress={service.snapshot()}
          reviewAction={ReviewAction}
          session={session}
        />,
      )
      expect(html).toContain('1 step')
      expect(html).toContain('1 file changed')
      expect(html).toContain('Trace the bug')
      expect(html).not.toContain('Implement the fix')
      expect(html).toContain('turn-progress-details')
      expect(html).toContain('turn-progress-ring-track')
      expect(html).toContain('turn-progress-ring-value')
      expect(html).toContain('stroke-dasharray="100 100"')
      expect(html).toContain('data-activity-id="turn:thread-a:turn-a"')
      expect(html).toContain('data-appearance="icon"')
      expect(html).toContain('Review 1')
      expect(html).not.toContain('turn-progress-separator')
      expect(html).toContain('turn-progress-rolling is-up')
      expect(html).not.toContain('turn-progress-rolling-in')
      expect([...html.matchAll(/turn-progress-rolling-value">([^<]+)</gu)].map((match) => match[1]))
        .toEqual(['1', '1', '2', '1'])
      expect(html).toContain('turn-progress-additions">+<span class="turn-progress-number')
      expect(html).toContain('turn-progress-deletions">−<span class="turn-progress-number')
      expect(html).toContain('turn-progress-file-details')
      expect(html).toContain('/tmp/project/example.ts')
      expect(html).toContain('>example.ts</span>')
      expect(html).toContain('aria-label="1 file changed. Show changed files"')

      currentSession = sessionSnapshot('thread-b')
      sessionListener()
      expect(service.snapshot().visible).toBe(false)
    } finally {
      service.dispose()
    }
  })

  it('hides the progress pill when the completed turn hands off to the transcript', () => {
    let hostListener = (_event: HarnessEvent): void => undefined
    const host = {
      snapshot: () => ({}) as ClientHostSnapshot,
      journal: () => [],
      onEvent: (listener: (event: HarnessEvent) => void) => {
        hostListener = listener
        return () => undefined
      },
    } as unknown as ClientHostService
    const session = {
      snapshot: () => sessionSnapshot(),
      subscribe: () => () => undefined,
    } as unknown as ClientSessionService
    const service = new TurnProgressService(host, session)

    try {
      hostListener({
        type: 'codex.notification',
        payload: {
          method: 'turn/plan/updated',
          params: {
            threadId: 'thread-a',
            turnId: 'turn-a',
            plan: [{ step: 'Finish', status: 'in_progress' }],
          },
        },
      })
      expect(service.snapshot().visible).toBe(false)

      hostListener({
        type: 'codex.notification',
        payload: {
          method: 'turn/plan/updated',
          params: {
            threadId: 'thread-a',
            turnId: 'turn-a',
            plan: [{ step: 'Finish', status: 'completed' }],
          },
        },
      })
      expect(service.snapshot().visible).toBe(true)

      hostListener({
        type: 'codex.notification',
        payload: {
          method: 'turn/completed',
          params: { threadId: 'thread-a', turn: { id: 'turn-a' } },
        },
      })
      expect(service.snapshot()).toMatchObject({
        visible: false,
        phase: 'completed',
        completedSteps: 1,
      })
      const completed = renderToStaticMarkup(<TurnProgressView progress={service.snapshot()} />)
      expect(completed).toBe('')

      hostListener({
        type: 'codex.notification',
        payload: {
          method: 'turn/plan/updated',
          params: {
            threadId: 'thread-a',
            turnId: 'turn-b',
            plan: [{ step: 'Reconnect', status: 'in_progress' }],
          },
        },
      })
      expect(service.snapshot()).toMatchObject({ visible: false, phase: 'active' })

      hostListener({
        type: 'codex.status',
        payload: { status: 'ready', models: [], activeThreadIds: [] },
      })
      expect(service.snapshot().visible).toBe(false)
    } finally {
      service.dispose()
    }
  })
})
