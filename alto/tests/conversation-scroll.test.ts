import { describe, expect, it } from 'vitest'
import {
  conversationAwayFromBottom,
  conversationScrollPlan,
  conversationShouldReleaseFollow,
  conversationShouldScrollUpdate,
  conversationWindowActive,
} from '../program/plugins/ui-surfaces.client.js'
import {
  CONVERSATION_FOLLOW_LATEST_EVENT,
  conversationAtBottom,
  conversationFollowingAfterScroll,
  requestConversationFollowLatest,
} from '../program/plugins/ui/conversation-scroll.js'

describe('conversation scroll plan', () => {
  it('jumps directly to the bottom when a populated chat opens', () => {
    expect(conversationScrollPlan(true, false)).toEqual({
      target: 'bottom',
      behavior: 'auto',
    })
  })

  it('smoothly lifts the transcript when a turn starts', () => {
    expect(conversationScrollPlan(true, true)).toEqual({
      target: 'bottom',
      behavior: 'smooth',
    })
  })

  it('keeps a blank chat at the top', () => {
    expect(conversationScrollPlan(false, false)).toEqual({
      target: 'top',
      behavior: 'auto',
    })
  })
})

describe('conversation jump-to-latest visibility', () => {
  it('stays hidden when the transcript does not overflow', () => {
    expect(conversationAwayFromBottom(600, 0, 600)).toBe(false)
  })

  it('stays hidden within the bottom threshold', () => {
    expect(conversationAwayFromBottom(1_000, 325, 600)).toBe(false)
  })

  it('appears when the reader moves meaningfully above the bottom', () => {
    expect(conversationAwayFromBottom(1_000, 200, 600)).toBe(true)
  })

  it('does not treat the jump-button threshold as the actual bottom', () => {
    expect(conversationAwayFromBottom(1_000, 395, 600)).toBe(false)
    expect(conversationAtBottom(1_000, 395, 600)).toBe(false)
    expect(conversationAtBottom(1_000, 399, 600)).toBe(true)
  })
})

describe('conversation streaming follow', () => {
  it('lets a composer request follow-latest from its own chat pane', () => {
    const feed = new EventTarget()
    let followed = false
    feed.addEventListener(CONVERSATION_FOLLOW_LATEST_EVENT, () => { followed = true })
    const origin = {
      closest: () => ({ querySelector: () => feed }),
    } as unknown as HTMLElement

    requestConversationFollowLatest(origin)

    expect(followed).toBe(true)
  })

  it('does not force a final scroll when a streaming turn completes', () => {
    expect(conversationShouldScrollUpdate(false, false, true, true, true)).toBe(false)
  })

  it('continues following ordinary streamed activity updates', () => {
    expect(conversationShouldScrollUpdate(false, false, false, true, true)).toBe(true)
  })

  it('releases an in-flight programmatic scroll when the reader moves upward', () => {
    expect(conversationShouldReleaseFollow(true, true)).toBe(true)
  })

  it('keeps following while a programmatic scroll moves toward the bottom', () => {
    expect(conversationShouldReleaseFollow(true, false)).toBe(false)
  })

  it('does not release follow merely because content grew above the bottom threshold', () => {
    expect(conversationShouldReleaseFollow(true, false)).toBe(false)
  })

  it('stays detached after a small upward scroll near the bottom', () => {
    expect(conversationFollowingAfterScroll(false, false, false, true)).toBe(false)
  })

  it('resumes follow only when the reader returns to the actual bottom', () => {
    expect(conversationFollowingAfterScroll(false, false, true, true)).toBe(true)
  })
})

describe('conversation window activity', () => {
  it('runs conversation updates only while Alto is visible and focused', () => {
    expect(conversationWindowActive('visible', true)).toBe(true)
    expect(conversationWindowActive('visible', false)).toBe(false)
    expect(conversationWindowActive('hidden', true)).toBe(false)
  })
})
