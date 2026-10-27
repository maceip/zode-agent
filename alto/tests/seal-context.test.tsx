import { Context } from 'cordis'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createMarkdownContentRenderer } from '../program/plugins/markdown-content.js'
import { MarkdownRendererRegistry } from '../program/plugins/markdown.client.js'
import sealContextPlugin from '../program/plugins/seal-context.client.js'
import codeBlocksPlugin from '../program/plugins/code-blocks.client.js'
import { sealMessageText, summarizeSealContext } from '../program/plugins/seal-context.js'

const header = [
  'Current Neovim editor context. The buffer content is authoritative.',
  'Project root: /project',
  'File: /project/src/example.lua',
  'Language: lua',
  'Cursor: line 12, byte column 3',
  'The buffer has unsaved changes.',
].join('\n') + '\n'
const context = header + 'Selected lines: 12-13\n<selection>\nlocal answer = 42\nprint(answer)\n</selection>\n'
  + '<buffer lines="1-100">\nUNSELECTED_BUFFER_CONTENT\n```lua\nprint(answer)\n```\n</buffer>'

describe('Seal context summaries', () => {
  it('keeps the exact buffer context in one Markdown block, including embedded fences', async () => {
    const ctx = new Context()
    const markdown = new MarkdownRendererRegistry()
    const styles = new Set<string>()
    ctx.provide('clientMarkdown', markdown)
    ctx.provide('clientUi', { registerStyle: (owner: Context, id: string) => {
      owner.effect(() => { styles.add(id); return () => { styles.delete(id) } })
    } } as unknown as Context['clientUi'])
    const codeBlocks = await ctx.plugin(codeBlocksPlugin, { fontSize: 15 })
    const fiber = await ctx.plugin(sealContextPlugin, {})
    const Content = createMarkdownContentRenderer(markdown)
    const source = sealMessageText('Explain this selection.', context)
    const render = () => renderToStaticMarkup(<Content source={source} className="message" />)
    try {
      expect(source).toContain(context)
      const html = render()
      expect(html.match(/class="seal-context"/g)).toHaveLength(1)
      expect(html).toContain('Seal · example.lua:12-13')
      expect(html).not.toContain('src/example.lua')
      expect(html).not.toContain('Selected lines')
      expect(html).not.toContain('Preview')
      expect(html).toContain('local answer = 42')
      expect(html).toContain('class="cordis-code-block"')
      expect(html).toContain('--code-block-font-size:15px')
      expect(html).toContain('aria-label="Copy code"')
      expect(html).not.toContain('UNSELECTED_BUFFER_CONTENT')
      expect(html).not.toContain('<details')
      expect(html.match(/<figure/g)).toHaveLength(1)
      expect(html).toContain('data-wrap="true"')
      expect(html).not.toContain('aria-expanded')
      expect(html).not.toContain('Full context')
      expect(html.match(/<button/g)).toHaveLength(1)
      expect(styles.has('seal-context')).toBe(true)

      await fiber.dispose()
      expect(styles.has('seal-context')).toBe(false)
      expect(render()).not.toContain('class="seal-context"')
      expect(render()).toContain('UNSELECTED_BUFFER_CONTENT')
    } finally {
      await fiber.dispose()
      await codeBlocks.dispose()
      markdown.dispose()
    }
  })

  it('summarizes cursor-only handoffs without showing source text', () => {
    const summary = summarizeSealContext(header + '<buffer lines="1-3">\nFile: misleading.lua\nSelected lines: 99-100\n</buffer>')
    expect(summary).toEqual({ file: '/project/src/example.lua', path: 'src/example.lua', language: 'lua', lineRange: '12', modified: true })
    expect(sealMessageText('No context', '')).toBe('No context')
  })

  it('bounds a large selection preview while retaining all of it in the message', () => {
    const selection = Array.from({ length: 30 }, (_, index) => `line ${index} ` + 'x'.repeat(200)).join('\n')
    const code = header + `Selected lines: 1-30\n<selection>\n${selection}\n</selection>\n<buffer lines="1-30">\n${selection}\n</buffer>`
    const summary = summarizeSealContext(code)
    expect(summary.selection!.length).toBeLessThanOrEqual(600)
    expect(summary.selection!.split('\n').length).toBeLessThanOrEqual(6)
    expect(summary.selectionTruncated).toBe(true)
    expect(sealMessageText('Review this', code)).toContain(selection)
  })

  it('uses a generic context label when the payload has no recognized header', () => {
    expect(summarizeSealContext('File: not-a-header.txt\nSelected lines: 1-5')).toEqual({})
  })
})
