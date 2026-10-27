export interface VimCursor {
  /** One-based line number. */
  line: number
  /** Zero-based character offset. */
  column: number
}

export type VimMotion =
  | 'left'
  | 'right'
  | 'down'
  | 'up'
  | 'line-start'
  | 'line-end'
  | 'word-forward'
  | 'word-backward'
  | 'word-end'

function sourceLines(source: string): string[] {
  return source.split('\n')
}

function lastColumn(line: string): number {
  return Math.max(0, line.length - 1)
}

export function clampVimCursor(source: string, cursor: VimCursor): VimCursor {
  const lines = sourceLines(source)
  const line = Math.max(1, Math.min(lines.length, cursor.line))
  return {
    line,
    column: Math.max(0, Math.min(lastColumn(lines[line - 1] ?? ''), cursor.column)),
  }
}

function positionToOffset(source: string, cursor: VimCursor): number {
  const lines = sourceLines(source)
  const position = clampVimCursor(source, cursor)
  let offset = 0
  for (let line = 1; line < position.line; line += 1) {
    offset += (lines[line - 1]?.length ?? 0) + 1
  }
  return Math.min(Math.max(0, source.length - 1), offset + position.column)
}

function offsetToPosition(source: string, requestedOffset: number): VimCursor {
  if (!source) return { line: 1, column: 0 }
  const offset = Math.max(0, Math.min(source.length - 1, requestedOffset))
  const before = source.slice(0, offset)
  const line = before.split('\n').length
  const lineStart = before.lastIndexOf('\n') + 1
  if (source[offset] === '\n') return clampVimCursor(source, { line: line + 1, column: 0 })
  return clampVimCursor(source, { line, column: offset - lineStart })
}

function characterClass(character: string | undefined): 0 | 1 | 2 {
  if (!character || /\s/u.test(character)) return 0
  return /[\p{L}\p{N}_]/u.test(character) ? 1 : 2
}

function nextWordStart(source: string, offset: number): number {
  if (!source) return 0
  let next = Math.min(source.length - 1, offset)
  const currentClass = characterClass(source[next])
  if (currentClass === 0) {
    while (next < source.length && characterClass(source[next]) === 0) next += 1
  } else {
    while (next < source.length && characterClass(source[next]) === currentClass) next += 1
    while (next < source.length && characterClass(source[next]) === 0) next += 1
  }
  return Math.min(source.length - 1, next)
}

function previousWordStart(source: string, offset: number): number {
  if (!source) return 0
  let next = Math.max(0, offset - 1)
  while (next > 0 && characterClass(source[next]) === 0) next -= 1
  const nextClass = characterClass(source[next])
  while (next > 0 && characterClass(source[next - 1]) === nextClass) next -= 1
  return next
}

function nextWordEnd(source: string, offset: number): number {
  if (!source) return 0
  let next = Math.min(source.length - 1, offset + 1)
  while (next < source.length - 1 && characterClass(source[next]) === 0) next += 1
  const nextClass = characterClass(source[next])
  while (next < source.length - 1 && characterClass(source[next + 1]) === nextClass) next += 1
  return next
}

export function moveVimCursor(
  source: string,
  cursor: VimCursor,
  motion: VimMotion,
  requestedCount = 1,
): VimCursor {
  const lines = sourceLines(source)
  const current = clampVimCursor(source, cursor)
  const count = Math.max(1, Math.floor(requestedCount))

  switch (motion) {
    case 'left':
      return clampVimCursor(source, { ...current, column: current.column - count })
    case 'right':
      return clampVimCursor(source, { ...current, column: current.column + count })
    case 'down':
      return clampVimCursor(source, { ...current, line: current.line + count })
    case 'up':
      return clampVimCursor(source, { ...current, line: current.line - count })
    case 'line-start':
      return { ...current, column: 0 }
    case 'line-end':
      return { ...current, column: lastColumn(lines[current.line - 1] ?? '') }
    case 'word-forward': {
      let offset = positionToOffset(source, current)
      for (let index = 0; index < count; index += 1) offset = nextWordStart(source, offset)
      return offsetToPosition(source, offset)
    }
    case 'word-backward': {
      let offset = positionToOffset(source, current)
      for (let index = 0; index < count; index += 1) offset = previousWordStart(source, offset)
      return offsetToPosition(source, offset)
    }
    case 'word-end': {
      let offset = positionToOffset(source, current)
      for (let index = 0; index < count; index += 1) offset = nextWordEnd(source, offset)
      return offsetToPosition(source, offset)
    }
  }
}
