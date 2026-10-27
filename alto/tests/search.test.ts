import { describe, expect, it, vi } from 'vitest'
import {
  filterSearchItems,
  isSearchShortcut,
  searchThreads,
  openSearchThread,
  type SearchItem,
} from '../program/plugins/search.client.js'
import type { ThreadSummary } from '../src/shared/protocol.js'
import type { ClientWorkspaceLayoutService, WorkspaceTabTarget } from '../program/plugins/workspace-layout-api.js'

const items: SearchItem[] = [
  {
    id: 'thread:two',
    label: 'Align palette spacing',
    detail: 'Updated the result layout',
    keywords: '/workspace/alto',
    onSelect: vi.fn(),
  },
  {
    id: 'thread:one',
    label: 'Fix composer spacing',
    detail: 'Adjusted the input layout',
    keywords: '/workspace/codex-cordis',
    onSelect: vi.fn(),
  },
]

describe('command palette filtering', () => {
  it('recognizes the command palette shortcut without accepting shifted chords', () => {
    expect(isSearchShortcut({ key: 'k', metaKey: true, ctrlKey: false, shiftKey: false })).toBe(true)
    expect(isSearchShortcut({ key: 'K', metaKey: false, ctrlKey: true, shiftKey: false })).toBe(true)
    expect(isSearchShortcut({ key: 'k', metaKey: true, ctrlKey: false, shiftKey: true })).toBe(false)
  })

  it('matches labels, details, and keywords case-insensitively', () => {
    expect(filterSearchItems(items, 'input layout').map((item) => item.id))
      .toEqual(['thread:one'])
    expect(filterSearchItems(items, 'codex cordis').map((item) => item.id))
      .toEqual(['thread:one'])
  })

  it('keeps source order without truncating the results', () => {
    expect(filterSearchItems(items, '')).toEqual(items)
  })

  it('returns every conversation instead of applying a fixed cap', () => {
    const many = Array.from({ length: 24 }, (_, index): SearchItem => ({
      id: `thread:${index}`,
      label: `Conversation ${index}`,
      onSelect: vi.fn(),
    }))
    expect(filterSearchItems(many, '')).toHaveLength(24)
  })
})

describe('unread search navigation', () => {
  const thread = (id: string, updatedAt = 1): ThreadSummary => ({ id, title: id, cwd: '/repo', preview: '', createdAt: 1, updatedAt })

  it('prioritizes the newest unread completion, including chats only present in open tabs', () => {
    const tabs: WorkspaceTabTarget[] = [{ id: 'tab', title: 'Newest unread tab', active: false, threadIds: ['new-unread'], threads: [thread('new-unread')] }]
    const source = [thread('current', 100), thread('recent-read', 90), thread('old-unread', 80)]
    expect(searchThreads(source, tabs, { revision: 1, running: [], finished: ['current', 'new-unread', 'old-unread'] }, 'current').map((thread) => thread.id))
      .toEqual(['new-unread', 'old-unread', 'current', 'recent-read'])
    expect(source.map((thread) => thread.id)).toEqual(['current', 'recent-read', 'old-unread'])
  })

  it('deduplicates open chats and preserves the freshest summary', () => {
    const tabs: WorkspaceTabTarget[] = [{ id: 'tab', title: 'Open tab', active: false, threadIds: ['one'], threads: [thread('one', 10)] }]
    expect(searchThreads([thread('one', 5)], tabs, { revision: 0, running: [], finished: [] })).toEqual([thread('one', 10)])
  })

  it('focuses the existing tab without opening a duplicate', () => {
    const layout = { focusThread: vi.fn(() => true), newTab: vi.fn() }
    openSearchThread(layout as unknown as ClientWorkspaceLayoutService, thread('one'))
    expect(layout.focusThread).toHaveBeenCalledWith('one')
    expect(layout.newTab).not.toHaveBeenCalled()
  })

  it('opens a new tab for a conversation that is not already open', () => {
    const layout = { focusThread: vi.fn(() => false), newTab: vi.fn() }
    openSearchThread(layout as unknown as ClientWorkspaceLayoutService, thread('one'))
    expect(layout.newTab).toHaveBeenCalledWith(undefined, thread('one'))
  })
})
