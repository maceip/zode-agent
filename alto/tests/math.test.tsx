import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import remarkMath from 'remark-math'
import {
  DefaultMath,
  bundledMathStyles,
  mathMarkup,
  normalizeLatexDelimiters,
} from '../program/plugins/math.client.js'
import { MarkdownMathProvider, MessageMarkdown } from '../program/plugins/ui/markdown.js'

describe('KaTeX math renderer', () => {
  it('emits accessible HTML and MathML without trusting TeX commands', () => {
    const html = mathMarkup(String.raw`R(f(x,y)) = R(x) \cap R(y)`, false)

    expect(html).toContain('class="katex"')
    expect(html).toContain('class="katex-mathml"')
    expect(html).toContain('<math')
  })

  it('renders centered display math with fiber-owned styling', () => {
    const html = renderToStaticMarkup(
      <DefaultMath formula={String.raw`U \cap \{Alice\}`} display config={{}} />,
    )

    expect(html).toContain('cordis-math-display')
    expect(html).toContain('katex-display')
    expect(bundledMathStyles()).toContain('KaTeX_Main')
  })

  it('accepts ChatGPT-style LaTeX delimiters without rewriting code', () => {
    const source = [
      String.raw`Inline \(R(x) \cap R(y)\).`,
      '',
      String.raw`\[`,
      String.raw`R(x) \cap R(y)`,
      String.raw`\]`,
      '',
      'Keep `\\(literal\\)` inside inline code.',
      '',
      '```text',
      String.raw`\[also literal\]`,
      '```',
    ].join('\n')

    expect(normalizeLatexDelimiters(source)).toBe([
      String.raw`Inline $R(x) \cap R(y)$.`,
      '',
      '$$',
      String.raw`R(x) \cap R(y)`,
      '$$',
      '',
      'Keep `\\(literal\\)` inside inline code.',
      '',
      '```text',
      String.raw`\[also literal\]`,
      '```',
    ].join('\n'))
  })

  it.each(['$$a + b$$', String.raw`\[a + b\]`])(
    'renders a standalone %s as display math between paragraphs', (formula) => {
      const source = `Before.\n${formula}\nAfter.`
      expect(normalizeLatexDelimiters(source)).toBe('Before.\n$$\na + b\n$$\nAfter.')
      const html = renderToStaticMarkup(
        <MarkdownMathProvider renderer={{
          id: 'test-math',
          component: (props) => <DefaultMath {...props} config={{}} />,
          remarkPlugins: [remarkMath],
          preprocess: normalizeLatexDelimiters,
        }}>
          <MessageMarkdown source={source} />
        </MarkdownMathProvider>,
      )
      expect(html).toContain('cordis-math-display')
      expect(html).not.toContain('cordis-math-inline')
      expect(html.match(/<p>/g)).toHaveLength(2)
      expect(html.indexOf('Before.')).toBeLessThan(html.indexOf('cordis-math-display'))
      expect(html.indexOf('After.')).toBeGreaterThan(html.indexOf('cordis-math-display'))
    },
  )

  it('leaves inline math and ambiguous dollar runs inline', () => {
    const source = String.raw`Inline $x$, \(y\), $$z$$ and $$a$$$$b$$.`
    expect(normalizeLatexDelimiters(source)).toBe('Inline $x$, $y$, $$z$$ and $$a$$$$b$$.')
    for (const line of ['$$$$', '$$x$$$$y$$', '$$$x$$$', String.raw`$$x\$$`]) {
      expect(normalizeLatexDelimiters(line)).toBe(line)
    }
  })

  it('preserves existing multiline display fences', () => {
    const source = '$$\na + b\n$$x$$\n\\(literal\\)\n`\n$$\n\n$$$\nc + d\n$$$\nInline \\(x\\).'
    expect(normalizeLatexDelimiters(source)).toBe(source.replace('Inline \\(x\\).', 'Inline $x$.'))
  })

  it.each(['```text', '~~~~'])('preserves standalone delimiters inside %s fences', (fence) => {
    const source = [fence, '$$x$$', String.raw`\[y\]`, fence[0]!.repeat(fence.startsWith('`') ? 3 : 4)].join('\n')
    expect(normalizeLatexDelimiters(source)).toBe(source)
  })

  it('preserves code spans spanning lines', () => {
    const source = ['`literal', '$$x$$', String.raw`\[y\]`, 'end`'].join('\n')
    expect(normalizeLatexDelimiters(source)).toBe(source)
  })

  it('does not promote indented expressions to display math', () => {
    const source = ['    $$a$$', '  $$b$$', '\t$$c$$', String.raw`    \[d\]`].join('\n')
    expect(normalizeLatexDelimiters(source)).toBe(['    $$a$$', '  $$b$$', '\t$$c$$', '    $$d$$'].join('\n'))
  })

  it('preserves escaped LaTeX delimiters', () => {
    const source = [String.raw`\$$x$$`, String.raw`\\[x\\]`, String.raw`$$x\$$`].join('\n')
    expect(normalizeLatexDelimiters(source)).toBe(source)
  })

  it('does not insert unprefixed lines into lists or blockquotes', () => {
    const source = ['- Item', '$$lazy$$', '  $$nested$$', '', '> Quote', '$$lazy$$', '> $$nested$$', '', '$$top$$'].join('\n')
    expect(normalizeLatexDelimiters(source)).toBe(source.replace('$$top$$', () => '$$\ntop\n$$'))
  })

  it('still normalizes inline math in indented list continuation prose', () => {
    expect(normalizeLatexDelimiters('- Item\n    with \\(x\\).')).toBe('- Item\n    with $x$.')
    expect(normalizeLatexDelimiters('A continuation:\n    \\(x\\)')).toBe('A continuation:\n    $x$')
  })

  it('retains CRLF line endings when expanding a display expression', () => {
    expect(normalizeLatexDelimiters('Before.\r\n$$x$$\r\nAfter.')).toBe('Before.\r\n$$\r\nx\r\n$$\r\nAfter.')
  })
})
