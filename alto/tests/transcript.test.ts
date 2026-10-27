import { describe, expect, it } from 'vitest'
import {
  activityFrom,
  mergeActivity,
  type ActivityItem,
} from '../program/plugins/ui/activity.js'
import { activitiesFromThread } from '../program/plugins/ui/history.js'
import {
  bindPendingTurn,
  reconcileTranscriptSnapshot,
  settleTranscriptTurn,
} from '../program/plugins/ui/transcript.js'

function reduce(events: NonNullable<ReturnType<typeof activityFrom>>[]): ActivityItem[] {
  return events.reduce<ActivityItem[]>((items, event) => mergeActivity(items, event), [])
}

describe('canonical transcript reducer', () => {
  const userEvent = (id: string, turnId = 'turn-1', text = 'Again') => activityFrom({
    method: 'item/completed', params: { threadId: 'thread-1', turnId,
      item: { id, type: 'userMessage', content: [{ type: 'text', text }] },
    },
  })!

  it('acknowledges optimistic input once and preserves repeated native submissions', () => {
    const optimistic: ActivityItem = {
      id: 'user:local:1', threadId: 'thread-1', turnId: 'turn-1',
      kind: 'user', title: 'You', content: 'Again', timestamp: '',
    }
    let items = mergeActivity([optimistic], userEvent('input-1'))
    items = mergeActivity(items, userEvent('input-1'))
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe('user:thread-1:turn-1:input-1')
    items = mergeActivity(items, userEvent('input-2'))
    items = mergeActivity(items, userEvent('input-2'))
    expect(items).toHaveLength(2)
    expect(items[1]?.continuesTurn).toBe(true)
    items = mergeActivity(items, userEvent('input-1', 'turn-2'))
    expect(items).toHaveLength(3)
    expect(items[2]?.continuesTurn).toBeUndefined()
  })

  it('recovers a queued prompt ahead of output that arrived before its turn snapshot', () => {
    const output = activityFrom({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'reply', delta: 'Working on it',
    } })!
    const items = mergeActivity([output], userEvent('input-1'))
    expect(items.map((item) => item.kind)).toEqual(['user', 'agent'])
  })

  it('preserves image and file-only messages and distinguishes pending attachments', () => {
    const optimistic: ActivityItem = {
      id: 'user:local:1', threadId: 'thread-1', turnId: 'turn-1',
      kind: 'user', title: 'You', content: '', timestamp: '',
      attachments: [{ name: 'first.md', path: '/tmp/first.md' }],
    }
    const incoming = activityFrom({ method: 'item/started', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: { id: 'other-file', type: 'userMessage', content: [
        { type: 'mention', name: 'second.md', path: '/tmp/second.md' },
        { type: 'image', url: 'data:image/png;base64,AAAA' },
      ] },
    } })!
    const items = mergeActivity([optimistic], incoming)
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ content: '', attachments: [{ path: '/tmp/second.md' }], images: [{ url: 'data:image/png;base64,AAAA' }] })
  })

  it('uses the same qualified identity for live events and replayed history', () => {
    const live = activityFrom({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'agent-1', type: 'agentMessage', text: 'Done.' },
      },
    })
    const replayed = activitiesFromThread({
      summary: {
        id: 'thread-1',
        title: 'Test',
        preview: 'Test',
        cwd: '/tmp',
        createdAt: 1,
        updatedAt: 2,
      },
      messages: [{
        id: 'thread-1:turn-1:agent-1',
        role: 'agent',
        text: 'Done.',
      }],
    })

    expect(live?.id).toBe('agent:thread-1:turn-1:agent-1')
    expect(replayed[0]?.id).toBe(live?.id)
  })

  it('keeps one row while deltas arrive and accepts the completed snapshot', () => {
    const events = [{
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'agent-1', type: 'agentMessage', text: '' },
      },
    }, {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: 'Hel' },
    }, {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: 'lo' },
    }, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'agent-1', type: 'agentMessage', text: 'Hello!' },
      },
    }].map(activityFrom).filter((event): event is ActivityItem => event !== undefined)

    const transcript = reduce(events)
    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toMatchObject({
      id: 'agent:thread-1:turn-1:agent-1',
      content: 'Hello!',
      status: 'completed',
    })
  })

  it('uses a corrected final snapshot instead of whichever string is longer', () => {
    const streaming: ActivityItem = {
      id: 'agent:1',
      kind: 'agent',
      title: 'Codex',
      content: 'An incorrect and much longer streamed prefix.',
      status: 'streaming',
      timestamp: '1:00 PM',
    }
    const completed: ActivityItem = {
      ...streaming,
      content: 'Correct final.',
      status: 'completed',
      timestamp: '1:01 PM',
    }

    expect(mergeActivity([streaming], completed)[0]).toMatchObject({
      content: 'Correct final.',
      timestamp: '1:00 PM',
    })
  })

  it('retains text already displayed when an interrupted snapshot is truncated', () => {
    const streaming: ActivityItem = {
      id: 'agent:1',
      kind: 'agent',
      title: 'Codex',
      content: 'Visible before the user interrupted the turn.',
      status: 'streaming',
      timestamp: '',
    }
    const interrupted: ActivityItem = {
      ...streaming,
      content: 'Visible before the user',
      status: 'interrupted',
    }
    expect(mergeActivity([streaming], interrupted)[0]?.content).toBe(streaming.content)
  })

  it('binds optimistic prompts and settles only the accepted turn', () => {
    const prompt: ActivityItem = {
      id: 'user:local:1',
      kind: 'user',
      title: 'You',
      content: 'Do it',
      timestamp: '',
    }
    const bound = bindPendingTurn([prompt], { threadId: 'thread-1', turnId: 'turn-1' })
    const running: ActivityItem = {
      id: 'command:thread-1:turn-1:command-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      kind: 'command',
      title: 'Ran a command',
      content: '',
      status: 'running',
      timestamp: '',
    }
    const other: ActivityItem = { ...running, id: 'command:other', turnId: 'turn-2' }
    const { turnId: _turnId, ...runningWithoutTurn } = running
    const unscoped: ActivityItem = { ...runningWithoutTurn, id: 'command:unscoped' }
    const settled = settleTranscriptTurn(
      [...bound, running, other, unscoped],
      'turn-1',
      'interrupted',
    )

    expect(settled[0]).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' })
    expect(settled[1]?.status).toBe('interrupted')
    expect(settled[2]?.status).toBe('running')
    expect(settled[3]?.status).toBe('running')
  })

  it('reuses equal replay rows and preserves missing live work only while requested', () => {
    const replayed: ActivityItem = {
      id: 'agent:1',
      kind: 'agent',
      title: 'Codex',
      content: 'Done.',
      status: 'completed',
      timestamp: '',
    }
    const live: ActivityItem = {
      id: 'tool:2',
      kind: 'tool',
      title: 'Used the browser',
      content: '',
      status: 'running',
      timestamp: '',
    }

    const reconciled = reconcileTranscriptSnapshot([replayed, live], [{ ...replayed }], true)
    expect(reconciled[0]).toBe(replayed)
    expect(reconciled[1]).toBe(live)
    expect(reconcileTranscriptSnapshot([replayed, live], [{ ...replayed }], false)).toEqual([replayed])
  })
})
