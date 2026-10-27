import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ActivityTimeline,
  initialVisibleTurnStart,
  shouldObserveActivityHeight,
  type ActivityItem,
} from '../program/plugins/ui/activity.js'

function prompts(count: number): ActivityItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `user:${index}`,
    kind: 'user',
    title: 'You',
    content: `Prompt ${index}`,
    timestamp: 'now',
  }))
}

describe('activity timeline window', () => {
  it('starts with the most recent 24 turns', () => {
    expect(initialVisibleTurnStart(100)).toBe(76)
    expect(initialVisibleTurnStart(12)).toBe(0)

    const html = renderToStaticMarkup(<ActivityTimeline items={prompts(30)} markdown={false} />)
    expect(html).not.toContain('data-activity-id="user:5"')
    expect(html).toContain('data-activity-id="user:6"')
    expect(html).toContain('data-activity-id="user:29"')
    expect(html).toContain('Show earlier activity')
  })

  it('offers an older page even when every loaded turn is visible', () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline items={prompts(24)} markdown={false} hasEarlier />,
    )

    expect(html).toContain('Show earlier activity')
    expect(html).toContain('data-activity-id="user:0"')
  })
})

describe('streaming reply height observation', () => {
  it('observes only visible agent replies while they are animating', () => {
    expect(shouldObserveActivityHeight('agent', true, true)).toBe(true)
    expect(shouldObserveActivityHeight('agent', true, false)).toBe(false)
    expect(shouldObserveActivityHeight('agent', false, true)).toBe(false)
    expect(shouldObserveActivityHeight('reasoning', true, true)).toBe(false)
  })
})
