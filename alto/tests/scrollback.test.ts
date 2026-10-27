import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '../program/plugins/ui/activity.js'
import {
  currentPromptAt,
  scrollbackMarkerIndices,
  scrollbackPreview,
  scrollbackTickCount,
  scrollbackTickWidth,
  scrollTopForPrompt,
} from '../program/plugins/scrollback.client.js'

const activities: ActivityItem[] = [
  {
    id: 'user:1',
    kind: 'user',
    title: 'You',
    content: 'Build a long conversation minimap',
    timestamp: 'now',
  },
  {
    id: 'command:1',
    kind: 'command',
    title: 'Command',
    content: 'npm test',
    timestamp: 'now',
  },
  {
    id: 'agent:1',
    kind: 'agent',
    title: 'Codex',
    content: 'Implemented the minimap and verified the scroll behavior.',
    timestamp: 'now',
  },
]

describe('scrollback minimap', () => {
  it('stays hidden until multiple prompts span a genuinely long conversation', () => {
    expect(scrollbackTickCount(600, 600, 3)).toBe(0)
    expect(scrollbackTickCount(1_079, 600, 3)).toBe(0)
    expect(scrollbackTickCount(2_400, 600, 1)).toBe(0)
    expect(scrollbackTickCount(2_400, 600, 3)).toBe(3)
  })

  it('fits long histories to the rail while preserving the current prompt', () => {
    expect(scrollbackMarkerIndices(4, 600, 2)).toEqual([0, 1, 2, 3])

    const markers = scrollbackMarkerIndices(90, 250, 47)
    expect(markers).toHaveLength(20)
    expect(markers[0]).toBe(0)
    expect(markers.at(-1)).toBe(89)
    expect(markers).toContain(47)
    expect(markers).toEqual([...markers].sort((left, right) => left - right))
  })

  it('jumps to the exact prompt while respecting the scroll range', () => {
    expect(scrollTopForPrompt(0, 2_000, 500)).toBe(0)
    expect(scrollTopForPrompt(770, 2_000, 500)).toBe(750)
    expect(scrollTopForPrompt(1_900, 2_000, 500)).toBe(1_500)
  })

  it('only tapers marker widths around an interacted prompt', () => {
    expect(scrollbackTickWidth(5)).toBe(6)
    expect([0, 1, 2, 3, 4, 5].map((distance) => (
      scrollbackTickWidth(5 + distance, 5)
    ))).toEqual([20, 18, 13, 9, 7, 6])
  })

  it('finds the current prompt with a binary search over measured positions', () => {
    const positions = Array.from({ length: 1_000 }, (_, index) => ({
      index,
      top: index * 120,
    }))

    expect(currentPromptAt(positions, 0)).toBe(0)
    expect(currentPromptAt(positions, 11_999)).toBe(99)
    expect(currentPromptAt(positions, Number.POSITIVE_INFINITY)).toBe(999)
    expect(currentPromptAt([], 100)).toBe(0)
  })

  it('previews the user prompt with its nearby response', () => {
    expect(scrollbackPreview(activities, 1)).toEqual({
      title: 'Build a long conversation minimap',
      detail: 'Implemented the minimap and verified the scroll behavior.',
    })
  })
})
