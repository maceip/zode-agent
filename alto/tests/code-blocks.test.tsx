import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DefaultCodeBlock,
  codeLanguageLabel,
  highlightedCode,
} from '../program/plugins/code-blocks.client.js'

describe('default code-block plugin', () => {
  it('highlights Rust and uses friendly, configurable language labels', () => {
    const highlighted = highlightedCode('struct DomainKey { value: usize }', 'rs')

    expect(highlighted).toContain('token keyword')
    expect(highlighted).toContain('DomainKey')
    expect(codeLanguageLabel('rs')).toBe('Rust')
    expect(codeLanguageLabel('acme', { acme: 'Acme DSL' })).toBe('Acme DSL')
  })

  it('highlights unified diffs on the same configurable code surface', () => {
    const highlighted = highlightedCode('@@ -1 +1 @@\n-old\n+new', 'diff')

    expect(highlighted).toContain('token coord')
    expect(highlighted).toContain('token deleted-sign deleted')
    expect(highlighted).toContain('token inserted-sign inserted')
    expect(codeLanguageLabel('diff')).toBe('Diff')
  })

  it('renders the light card controls and respects display configuration', () => {
    const visible = renderToStaticMarkup(
      <DefaultCodeBlock code="let value = 1;" language="rust" config={{}} />,
    )
    const minimal = renderToStaticMarkup(
      <DefaultCodeBlock
        code="plain"
        config={{ showLanguage: false, showCopyButton: false, fontSize: 16, radius: 18 }}
      />,
    )

    expect(visible).toContain('class="cordis-code-block"')
    expect(visible).toContain('Rust')
    expect(visible).toContain('aria-label="Copy code"')
    expect(visible).toContain('token keyword')
    expect(minimal).not.toContain('Plain text')
    expect(minimal).not.toContain('Copy code')
    expect(minimal).toContain('--code-block-font-size:16px')
    expect(minimal).toContain('--code-block-radius:18px')
  })
})
