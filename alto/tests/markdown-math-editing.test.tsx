import { renderToStaticMarkup } from 'react-dom/server'
import remarkMath from 'remark-math'
import { describe, expect, it } from 'vitest'
import type { MarkdownMathRenderer } from '../program/plugins/markdown-api.js'
import {
  markdownEditorMath,
  renderedMarkdownSource,
} from '../program/plugins/markdown-viewer.client.js'
import { MarkdownContent, MarkdownMathProvider } from '../program/plugins/ui/markdown.js'

const renderer: MarkdownMathRenderer = {
  id: 'test-math',
  component: () => null,
  remarkPlugins: [[remarkMath, { singleDollarTextMath: true }]],
}

function renderEditor(source: string): string {
  return renderToStaticMarkup(
    <MarkdownMathProvider renderer={markdownEditorMath(renderer)}>
      <MarkdownContent source={source} className="editor" />
    </MarkdownMathProvider>,
  )
}

describe('Markdown math editing', () => {
  it('preserves TeX, subscripts, alignment, and newlines through repeated prose edits', () => {
    const source = String.raw`# Notes

Original prose with $t_r$, $\Delta$, and $\text{two  spaces}$.

$$
\text{credential} \longrightarrow \text{run}
$$

$$
\begin{aligned}
P={}&P_{\mathrm{owner}} \cap P_{\mathrm{agent}}\\
&\cap P_{\mathrm{run}}.
\end{aligned}
$$

$$
L_{\mathrm{job}}
=
\bigcap_{x\in\mathrm{job\ context}}L(x).
$$
`
    let saved = source
    for (let edit = 1; edit <= 3; edit++) {
      const html = renderEditor(saved).replace(/(?:Original|Edited \d) prose/, `Edited ${edit} prose`)
      saved = renderedMarkdownSource(html)
      expect(saved).toBe(source.replace('Original prose', `Edited ${edit} prose`))
    }
  })

  it('keeps math in table cells while leaving literal code as code', () => {
    const source = [
      '| Permission |',
      '| --- |',
      String.raw`| $P_{\mathrm{run}}$ |`,
      '',
      'Literal `$a_b$` and `\\text{code}`.',
      '',
      '```text',
      '$$',
      String.raw`\text{not math}`,
      '$$',
      '```',
      '',
    ].join('\n')
    const html = renderEditor(source)
    expect(html.match(/data-markdown-math=/g)).toHaveLength(1)
    expect(renderedMarkdownSource(html)).toBe(source)
  })

  it('keeps editing available when the math plugin is disabled', () => {
    expect(markdownEditorMath(undefined)).toBeUndefined()
  })
})
