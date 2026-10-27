import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { agentMessageMetadata, type HarnessEvent } from '../src/shared/protocol.js'
import { readThreadView } from '../src/server/services/thread-view.js'
import { activityFrom, ActivityTimeline, completeLatestTurn, mergeActivity } from '../program/plugins/ui/activity.js'
import { activitiesFromThread } from '../program/plugins/ui/history.js'
import { asyncQuestionReply, replyToAsyncQuestion } from '../program/plugins/ui/async-question.js'
import { answersFromQuestionReply, withAsyncQuestionAnswers } from '../program/plugins/ui/async-question-model.js'
import type { ClientSessionService } from '../program/plugins/session-api.js'
import type { ActivityItem } from '../program/plugins/ui/transcript.js'

const item = {
  id: 'question-1', type: 'agentMessage', phase: 'final_answer', delivery: 'async',
  text: 'Does the caret disappear, move in the draft, or move to another control?',
  questions: [{ title: 'Does the caret disappear, move in the draft, or move to another control?', options: null }],
}
const notification = { method: 'item/completed', params: { threadId: 'chat-one', turnId: 'turn-one', item } }
const event: HarnessEvent = { type: 'codex.notification', payload: notification }

describe('asynchronous agent questions', () => {
  it.each([false, true])('keeps questions before later activity, including after answering (%s)', (answered) => {
    const question: ActivityItem = { ...activityFrom(notification)!, questions: [{ title: item.text, options: ['Composer', 'Sidebar'] }] }
    const items: ActivityItem[] = [
      { id: 'before', kind: 'agent', title: 'Codex', content: 'Progress before the question', timestamp: '' },
      question,
      ...(answered ? [{ id: 'answer', kind: 'user' as const, title: 'You', content: item.text + '\nSidebar', continuesTurn: true, timestamp: '' }] : []),
      { id: 'after', kind: 'agent', title: 'Codex', content: 'Progress after the question', timestamp: '' },
    ]
    const session = { snapshot: () => ({ threadId: 'chat-one', turn: { tag: 'running' } }), subscribe: () => () => {} } as unknown as ClientSessionService
    const html = renderToStaticMarkup(<ActivityTimeline items={items} active session={session} />)
    expect(html.indexOf('Progress before the question')).toBeLessThan(html.indexOf('input-request-heading'))
    expect(html.indexOf('input-request-heading')).toBeLessThan(html.indexOf('Progress after the question'))
    if (answered) {
      expect(html).toContain('Answered agent questions')
      expect(html.indexOf('input-question-answer')).toBeLessThan(html.indexOf('data-activity-id="answer"'))
    }
  })

  it('keeps multiple answered questions and replies in order when older work folds', () => {
    const question: ActivityItem = { ...activityFrom(notification)!, questions: [{ title: 'Which panel?', options: ['Composer', 'Sidebar'] }] }
    const second: ActivityItem = { ...question, id: 'second', questions: [{ title: 'Which size?', options: ['Small', 'Large'] }] }
    const items: ActivityItem[] = [
      { id: 'start', kind: 'user', title: 'You', content: 'Start', timestamp: '' },
      question,
      { id: 'answer-one', kind: 'user', title: 'You', content: 'Which panel?\nSidebar', continuesTurn: true, timestamp: '' },
      { id: 'detail', kind: 'agent', title: 'Codex', content: 'Fold this progress', timestamp: '' },
      second,
      { id: 'answer-two', kind: 'user', title: 'You', content: 'Which size?\nSmall', continuesTurn: true, timestamp: '' },
      { id: 'final', kind: 'agent', title: 'Codex', content: 'Finished', phase: 'final_answer', durationMs: 1000, timestamp: '' },
      { id: 'next', kind: 'user', title: 'You', content: 'Next task', timestamp: '' },
    ]
    const session = { snapshot: () => ({ threadId: 'chat-one', turn: { tag: 'idle' } }), subscribe: () => () => {} } as unknown as ClientSessionService
    const html = renderToStaticMarkup(<ActivityTimeline items={items} session={session} />)
    expect(html).not.toContain('Fold this progress')
    const order = [question.id, 'answer-one', 'second', 'answer-two', 'final', 'next'].map((id) => html.indexOf(`data-activity-id="${id}"`))
    expect(order.every((position) => position >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(html.match(/Answered agent questions/g)).toHaveLength(2)
  })

  it.each([false, true])('keeps assistant context around a question when the next prompt folds its details (legacy completion: %s)', (legacyCompletion) => {
    const question: ActivityItem = { ...activityFrom(notification)!, questions: [{ title: 'Which panel?', options: ['Composer', 'Sidebar'] }] }
    const items: ActivityItem[] = [
      { id: 'start', kind: 'user', title: 'You', content: 'Explain the options', timestamp: '' },
      { id: 'reasoning', kind: 'reasoning', title: 'Thinking', content: 'Internal reasoning detail', timestamp: '' },
      { id: 'before', kind: 'agent', title: 'Codex', content: 'The composer is the best place for this.', phase: 'commentary', timestamp: '' },
      question,
      { id: 'after', kind: 'agent', title: 'Codex', content: 'The sidebar is another option.', phase: 'commentary', timestamp: '',
        ...(legacyCompletion ? { durationMs: 1000 } : {}) },
      { id: 'tool', kind: 'tool', title: 'Inspect workspace', content: 'Internal tool detail', timestamp: '' },
      { id: 'next', kind: 'user', title: 'You', content: 'Keep the current layout', timestamp: '' },
    ]
    const session = { snapshot: () => ({ threadId: 'chat-one', turn: { tag: 'running' } }), subscribe: () => () => {} } as unknown as ClientSessionService
    const html = renderToStaticMarkup(<ActivityTimeline items={items} active session={session} />)

    expect(html).toContain('The composer is the best place for this.')
    expect(html).toContain('The sidebar is another option.')
    expect(html).toContain('Agent questions')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Internal reasoning detail')
    expect(html).not.toContain('Internal tool detail')
    const order = ['before', question.id, 'after', 'next'].map((id) => html.indexOf(`data-activity-id="${id}"`))
    expect(order.every((position) => position >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))
  })

  it('preserves the actual Astra delivery shape, including questions without options', () => {
    const activity = activityFrom(notification)!
    expect(activity).toMatchObject({ delivery: 'async', questions: [{ title: item.text }] })
    expect(activity.questions?.[0]?.options).toBeUndefined()
    expect(agentMessageMetadata({ delivery: 'async', questions: [{ title: 'Pick', options: ['One', null, 'Two'] }] }))
      .toEqual({ delivery: 'async', questions: [{ title: 'Pick', options: ['One', 'Two'] }] })
    expect(agentMessageMetadata({ text: 'A normal question?' })).toEqual({})
  })

  it('updates an existing text row when the completed item adds question metadata', () => {
    const activity = activityFrom(notification)!
    const { questions: _questions, delivery: _delivery, ...plain } = activity
    const result = mergeActivity([plain], activity)
    expect(result).not.toEqual([plain])
    expect(result[0]?.questions).toEqual([{ title: item.text }])
  })

  it('preserves questions through history and never treats them as the final handoff', () => {
    const view = readThreadView({ id: 'chat-one', cwd: '/tmp', turns: [{
      id: 'turn-one', startedAt: 10, durationMs: 4000, items: [
        { type: 'agentMessage', id: 'reply', text: 'Done', phase: 'final_answer' }, item,
      ],
    }] })
    expect(view.messages[0]?.durationMs).toBe(4000)
    expect(view.messages[1]).toMatchObject({ delivery: 'async', questions: [{ title: item.text }] })
    expect(view.messages[1]?.durationMs).toBeUndefined()
    const activities = activitiesFromThread(view)
    expect(activities[1]?.questions).toEqual([{ title: item.text }])
    expect(completeLatestTurn(activities, 5000)[1]?.durationMs).toBeUndefined()
  })

  it('recovers the fields from recent events when a running older host omits them', () => {
    const view = { summary: { id: 'chat-one' }, messages: [{ id: 'chat-one:turn-one:question-1', role: 'agent', text: item.text }] }
    const activities = activitiesFromThread(view as Parameters<typeof activitiesFromThread>[0], [event])
    expect(activities[0]?.questions).toEqual([{ title: item.text }])
    expect(activitiesFromThread(view as Parameters<typeof activitiesFromThread>[0], [{
      ...event, payload: { ...notification, params: { ...notification.params, threadId: 'other-chat' } },
    }])[0]?.questions).toBeUndefined()
  })

  it('keeps a question visible outside folded work without inventing a completed turn', () => {
    const question = activityFrom(notification)!
    const session = { snapshot: () => ({ threadId: 'chat-one', turn: { tag: 'running' } }), subscribe: () => () => {} } as unknown as ClientSessionService
    const html = renderToStaticMarkup(<ActivityTimeline items={[question]} active session={session} />)
    expect(html).toContain(item.text)
    expect(html).toContain('activity-markdown')
    expect(html).not.toContain('input-request')
    expect(html).not.toContain('A question for you')
    expect(html).not.toContain('Reply in composer')
    expect(html).not.toContain('type="text"')
    expect(html).not.toContain('type="radio"')
    expect(html).not.toContain('Worked for')
    const idle = renderToStaticMarkup(<ActivityTimeline items={[question]} session={session} />)
    expect(idle).not.toContain('>Stopped<')
    expect(idle).toContain(item.text)
    expect(idle).not.toContain('input-request')
    const recovered = renderToStaticMarkup(<ActivityTimeline items={[{ ...question, content: '', questionAnswers: ['It disappears'] }]} session={session} />)
    expect(recovered).toContain(item.text)
    expect(recovered).not.toContain('input-request')
  })

  it('retains an answered picker after history replaces a live call ID with an item ID', () => {
    const view = readThreadView({ id: 'chat-one', cwd: '/tmp', turns: [{ id: 'turn-one', items: [
      { ...item, id: 'item-1415', delivery: undefined, questions: undefined },
    ] }, { id: 'next-turn', items: [
      { type: 'userMessage', id: 'item-1', content: [{ type: 'text', text: item.text + '\nToo large' }] },
    ] }] })
    const choiceEvent = { ...event, payload: { ...notification, params: { ...notification.params,
      item: { ...item, questions: [{ title: item.text, options: ['Looks good', 'Too large'] }] },
    } } }
    const activities = activitiesFromThread(view, [choiceEvent])
    const answered = withAsyncQuestionAnswers(activities)
    expect(answered[0]).toMatchObject({ delivery: 'async', questionAnswers: ['Too large'] })
    expect(withAsyncQuestionAnswers(activities)[0]).toBe(answered[0])
    const session = { snapshot: () => ({ threadId: 'chat-one', turn: { tag: 'idle' } }), subscribe: () => () => {} } as unknown as ClientSessionService
    const html = renderToStaticMarkup(<ActivityTimeline items={activities} session={session} />)
    expect(html).toContain('Answered agent questions')
    expect(html).toContain('input-question-answer')
    expect(html).toContain('Too large')
    expect(html).not.toContain('<form')
    const otherTurn = { ...event, payload: { ...notification, params: { ...notification.params, turnId: 'other-turn' } } }
    expect(activitiesFromThread(view, [otherTurn])[0]?.questions).toBeUndefined()
  })

  it('matches complete question replies, not arbitrary later prompts', () => {
    const questions = [{ title: 'Which file?' }, { title: 'Which mode?' }]
    expect(answersFromQuestionReply(questions, 'Which file?\napp.ts\n\nWhich mode?\nStrict')).toEqual(['app.ts', 'Strict'])
    expect(answersFromQuestionReply(questions, 'Which file?\napp.ts')).toBeUndefined()
    expect(answersFromQuestionReply(questions, 'Fix the other bug')).toBeUndefined()
    const question = activityFrom(notification)!
    const reply = { id: 'user:reply', kind: 'user' as const, title: 'You', content: item.text + '\nIt disappears', timestamp: '' }
    expect(withAsyncQuestionAnswers([reply, question])[1]?.questionAnswers).toBeUndefined()
    expect(withAsyncQuestionAnswers([question, { ...reply, threadId: 'other-chat' }])[0]?.questionAnswers).toBeUndefined()
  })

  it('steers the owning chat when active and sends directly when idle, without touching a draft', async () => {
    const state = { threadId: 'chat-one', turn: { tag: 'running' }, connected: true, canAcceptDirectInput: true }
    const send = vi.fn().mockResolvedValue(undefined)
    const steer = vi.fn().mockResolvedValue(undefined)
    const session = { snapshot: () => state, send, steer } as unknown as ClientSessionService
    const text = asyncQuestionReply(activityFrom(notification)!, { answers: { 0: { answers: ['It disappears'] } } })
    await replyToAsyncQuestion(session, 'chat-one', text)
    expect(steer).toHaveBeenCalledWith({ text: item.text + '\nIt disappears', images: [], attachments: [], skills: [] })
    expect(send).not.toHaveBeenCalled()
    state.turn = { tag: 'idle' }
    await replyToAsyncQuestion(session, 'chat-one', text)
    expect(send).toHaveBeenCalledTimes(1)
    state.threadId = 'other-chat'
    await expect(replyToAsyncQuestion(session, 'chat-one', text)).rejects.toThrow('original chat')
    expect(send).toHaveBeenCalledTimes(1)
    state.threadId = 'chat-one'
    state.connected = false
    await expect(replyToAsyncQuestion(session, 'chat-one', text)).rejects.toThrow('original chat')
  })
})
