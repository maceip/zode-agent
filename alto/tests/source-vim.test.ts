import { describe, expect, it } from 'vitest'
import { clampVimCursor, moveVimCursor } from '../program/plugins/source-vim.js'

const SOURCE = 'const answer = 42\n\nreturn answer'

describe('source viewer Vim motions', () => {
  it('clamps character and vertical motions to source lines', () => {
    expect(clampVimCursor(SOURCE, { line: 99, column: 99 })).toEqual({ line: 3, column: 12 })
    expect(moveVimCursor(SOURCE, { line: 1, column: 12 }, 'down')).toEqual({ line: 2, column: 0 })
    expect(moveVimCursor(SOURCE, { line: 1, column: 12 }, 'down', 2)).toEqual({ line: 3, column: 12 })
    expect(moveVimCursor(SOURCE, { line: 1, column: 3 }, 'line-end')).toEqual({ line: 1, column: 16 })
  })

  it('moves by Vim-style word groups across lines', () => {
    expect(moveVimCursor(SOURCE, { line: 1, column: 0 }, 'word-forward')).toEqual({ line: 1, column: 6 })
    expect(moveVimCursor(SOURCE, { line: 1, column: 6 }, 'word-forward', 2)).toEqual({ line: 1, column: 15 })
    expect(moveVimCursor(SOURCE, { line: 3, column: 7 }, 'word-backward')).toEqual({ line: 3, column: 0 })
    expect(moveVimCursor(SOURCE, { line: 1, column: 0 }, 'word-end')).toEqual({ line: 1, column: 4 })
  })
})
