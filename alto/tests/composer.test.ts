import { describe, expect, it } from 'vitest'
import type { SkillOption } from '../src/shared/protocol.js'
import {
  composerHtml,
  composerCommandSubmitMode,
  composerEditorHeight,
  composerEditorOverflows,
  composerExpands,
  composerInsertsNewline,
  composerInsertionNeedsProjection,
  composerMeasurementText,
  composerSubmitMode,
  composerSteerShortcut,
  composerTokens,
  composerValueIsExternal,
  composerWorkspaceLabel,
  hasMarkdown,
  insertSkillToken,
  selectedSkillsFor,
  shouldAutoFocusComposer,
  skillQueryAt,
} from '../program/plugins/ui/composer.js'

const skills: SkillOption[] = [
  {
    name: 'imagegen',
    description: 'Generate an image.',
    path: '/skills/imagegen/SKILL.md',
    scope: 'system',
  },
  {
    name: 'openai-docs',
    description: 'Read OpenAI documentation.',
    path: '/skills/openai-docs/SKILL.md',
    scope: 'system',
  },
]

describe('dynamic composer', () => {
  it('grows with its content up to the configured maximum', () => {
    expect(composerEditorHeight(18, 180)).toBe(31)
    expect(composerEditorHeight(72.2, 180)).toBe(73)
    expect(composerEditorHeight(240, 180)).toBe(180)
    expect(composerEditorOverflows(180, 180)).toBe(false)
    expect(composerEditorOverflows(181, 180)).toBe(true)
  })

  it('keeps a measurable final line after a trailing newline', () => {
    expect(composerMeasurementText('hello')).toBe('hello')
    expect(composerMeasurementText('hello\n')).toBe('hello\n\u200b')
  })

  it('projects inserted newlines immediately', () => {
    expect(composerInsertionNeedsProjection('\n')).toBe(true)
    expect(composerInsertionNeedsProjection('pasted\ntext')).toBe(true)
    expect(composerInsertionNeedsProjection('plain text')).toBe(false)
  })

  it('only reconciles genuinely external value changes', () => {
    expect(composerValueIsExternal('draft', '', 'draft', 0, 0)).toBe(false)
    expect(composerValueIsExternal('', '', 'draft', 1, 0)).toBe(true)
    expect(composerValueIsExternal('restored', '', 'draft', 0, 0)).toBe(true)
  })

  it('only expands while editing when the preference is enabled', () => {
    expect(composerExpands(true, false)).toBe(false)
    expect(composerExpands(false, true)).toBe(false)
    expect(composerExpands(true, true)).toBe(true)
  })

  it('auto-focuses once when a ready chat pane becomes active', () => {
    expect(shouldAutoFocusComposer(false, true, false)).toBe(true)
    expect(shouldAutoFocusComposer(true, true, false)).toBe(false)
    expect(shouldAutoFocusComposer(false, false, false)).toBe(false)
    expect(shouldAutoFocusComposer(false, true, true)).toBe(false)
  })

  it('queues Enter, steers Control-Enter, and reserves Shift-Enter for newlines', () => {
    expect(composerSubmitMode({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false })).toBe('queue')
    expect(composerSubmitMode({ key: 'Enter', ctrlKey: true, metaKey: false, shiftKey: false })).toBe('steer')
    expect(composerSubmitMode({ key: 'Enter', ctrlKey: false, metaKey: true, shiftKey: false })).toBeUndefined()
    expect(composerSubmitMode({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: true })).toBeUndefined()
    expect(composerSubmitMode({ key: 'a', ctrlKey: false, metaKey: true, shiftKey: false })).toBeUndefined()

    expect(composerInsertsNewline({ key: 'Enter', metaKey: true, shiftKey: false })).toBe(false)
    expect(composerInsertsNewline({ key: 'Enter', metaKey: false, shiftKey: true })).toBe(true)
    expect(composerInsertsNewline({ key: 'Enter', metaKey: false, shiftKey: false })).toBe(false)
  })

  it('steers an active turn with Command-Enter', () => {
    const commandEnter = {
      key: 'Enter',
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    }
    expect(composerSteerShortcut(commandEnter)).toBe(true)
    expect(composerSteerShortcut({ ...commandEnter, shiftKey: true })).toBe(false)
    expect(composerSteerShortcut({ ...commandEnter, ctrlKey: true })).toBe(false)
    expect(composerCommandSubmitMode(commandEnter, true, true, true)).toBe('steer')
    expect(composerCommandSubmitMode(commandEnter, false, true, true)).toBeUndefined()
    expect(composerCommandSubmitMode(commandEnter, true, false, true)).toBeUndefined()
    expect(composerCommandSubmitMode(commandEnter, true, true, false)).toBeUndefined()
  })

  it('shows the named workspace and falls back to the folder name', () => {
    expect(composerWorkspaceLabel('Atlas', '/work/atlas')).toBe('Atlas')
    expect(composerWorkspaceLabel(undefined, '/work/codex-cordis/')).toBe('codex-cordis')
    expect(composerWorkspaceLabel(' ', '')).toBe('No workspace')
  })

  it('finds and replaces the skill token at the caret', () => {
    const value = 'Please use $ima to make this'
    const query = skillQueryAt(value, 'Please use $ima'.length)

    expect(query).toEqual({ start: 11, end: 15, query: 'ima' })
    expect(insertSkillToken(value, query!, 'imagegen')).toEqual({
      value: 'Please use $imagegen to make this',
      caret: 21,
    })
  })

  it('only attaches skills that remain in the submitted text', () => {
    expect(selectedSkillsFor('$imagegen make art with $missing', skills)).toEqual([skills[0]])
    expect(selectedSkillsFor('Price is $5', skills)).toEqual([])
  })

  it('detects actual Markdown without treating plain punctuation as Markdown', () => {
    expect(hasMarkdown('Use **care** and then:\n\n```ts\nconst x = 1\n```')).toBe(true)
    expect(hasMarkdown('Use $imagegen, please.')).toBe(false)
  })

  it('decorates Markdown and known skills without changing the submitted source', () => {
    const value = 'Use *care*, **bold**, `code`, [docs](https://openai.com), and $imagegen now.\n```ts\nconst x = 1\n```'
    const tokens = composerTokens(value, skills.map((skill) => skill.name))

    expect(tokens.map((token) => token.raw).join('')).toBe(value)
    expect(tokens.map((token) => token.kind)).toEqual([
      'text',
      'emphasis',
      'text',
      'strong',
      'text',
      'inline-code',
      'text',
      'link',
      'text',
      'skill',
      'text',
      'code-block',
    ])
  })

  it('can decorate skills while leaving Markdown as plain editable text', () => {
    expect(composerTokens('*plain* $imagegen', ['imagegen'], false)).toEqual([
      { kind: 'text', raw: '*plain* ' },
      { kind: 'skill', raw: '$imagegen' },
    ])
  })

  it('projects only escaped, visible rich text into the editable surface', () => {
    const html = composerHtml('<script>*hello*</script> $imagegen', ['imagegen'])

    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<em data-composer-markdown="emphasis">hello</em>')
    expect(html).toContain('<span class="composer-inline-skill">$imagegen</span>')
    expect(html).not.toContain('*hello*')
  })

  it('projects a trailing newline as a visible editable line', () => {
    expect(composerHtml('First line\n', [], false)).toBe(
      'First line<br><br data-composer-trailing-break>',
    )
  })
})
