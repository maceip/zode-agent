import { Context } from 'cordis'
import { renderToStaticMarkup } from 'react-dom/server'
import remarkMath from 'remark-math'
import { expect, it } from 'vitest'
import { createMarkdownContentRenderer } from '../program/plugins/markdown-content.js'
import { MarkdownRendererRegistry } from '../program/plugins/markdown.client.js'

it('shares active code and math renderers with externally registered panes', async () => {
  const context = new Context()
  const markdown = new MarkdownRendererRegistry()
  const Content = createMarkdownContentRenderer(markdown)
  const fiber = await context.plugin((ctx) => {
    markdown.registerCodeBlock(ctx, {
      id: 'diagram',
      languages: ['diagram'],
      component: ({ code }) => <figure>{code}</figure>,
    })
    markdown.registerMath(ctx, {
      id: 'math',
      remarkPlugins: [remarkMath],
      component: ({ formula }) => <span data-formula={formula} />,
    })
  })
  const source = '**Shared** $x_1$\n\n```diagram\nA -> B\n```\n\n```text\nplain\n```'
  const render = () => renderToStaticMarkup(<Content source={source} className="external-markdown" label="External message" />)
  try {
    const html = render()
    expect(html).toContain('class="external-markdown"')
    expect(html).toContain('aria-label="External message"')
    expect(html).toContain('<strong>Shared</strong>')
    expect(html).toContain('data-formula="x_1"')
    expect(html).toContain('<figure>A -&gt; B</figure>')
    expect(html).toContain('<pre><code class="language-text">plain</code></pre>')

    await fiber.dispose()
    const withoutExtensions = render()
    expect(withoutExtensions).not.toContain('data-formula')
    expect(withoutExtensions).not.toContain('<figure>')
    expect(withoutExtensions).toContain('$x_1$')
    expect(withoutExtensions).toContain('language-diagram')
  } finally {
    await fiber.dispose()
    markdown.dispose()
  }
})
