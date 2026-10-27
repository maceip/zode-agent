import { describe, expect, it } from 'vitest'
import {
  initialTerminalTabs,
  parseTerminalTabs,
} from '../program/plugins/ghostty-workspace.client.js'

describe('terminal workspace pane', () => {
  it('lets new and restored default tabs resolve the terminal preference at launch', () => {
    const initial = initialTerminalTabs()
    expect(initial.tabs).toEqual([{ id: 'terminal-1', title: 'Terminal' }])
    expect(parseTerminalTabs(initial)).toEqual(initial)
  })

  it('starts with one terminal named for the workspace', () => {
    expect(initialTerminalTabs('/Users/dev/projects/alto')).toEqual({
      version: 1,
      activeId: 'terminal-1',
      nextOrdinal: 2,
      tabs: [{
        id: 'terminal-1',
        title: 'alto',
        workingDirectory: '/Users/dev/projects/alto',
      }],
    })
  })

  it('restores valid tabs and repairs their active id and ordinal', () => {
    expect(parseTerminalTabs({
      version: 1,
      activeId: 'missing',
      nextOrdinal: 1,
      tabs: [
        { id: 'terminal-2', title: 'Shell', workingDirectory: '/repo' },
        { id: 'terminal-5', title: 'Tests', workingDirectory: '/repo' },
      ],
    }, '/fallback')).toMatchObject({
      activeId: 'terminal-2',
      nextOrdinal: 6,
      tabs: [{ id: 'terminal-2' }, { id: 'terminal-5' }],
    })
  })

  it('falls back cleanly when persisted state is malformed', () => {
    expect(parseTerminalTabs({ version: 1, tabs: [] }, '/repo').tabs)
      .toEqual([{ id: 'terminal-1', title: 'repo', workingDirectory: '/repo' }])
  })
})
