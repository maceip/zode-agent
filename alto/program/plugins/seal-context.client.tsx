import { useSyncExternalStore } from 'react'
import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import type { ClientMarkdownService, MarkdownCodeBlockProps } from './markdown-api.js'
import { SEAL_CONTEXT_LANGUAGE, summarizeSealContext } from './seal-context.js'
import styles from './seal-context.css'

function PlainCodeBlock({ code, language, label }: MarkdownCodeBlockProps) {
  return (
    <figure className="seal-context-fallback">
      <figcaption><span title={label}>{label}</span></figcaption>
      <pre><code className={language ? `language-${language}` : undefined}>{code}</code></pre>
    </figure>
  )
}

export function SealContextBlock({ code, markdown }: MarkdownCodeBlockProps & { markdown: ClientMarkdownService }) {
  const state = useSyncExternalStore(markdown.subscribe, markdown.snapshot, markdown.snapshot)
  // Selections are source text, including diagram syntax. Use the normal code renderer.
  const CodeBlock = state.codeBlocks.find((renderer) => !renderer.languages?.length)?.component ?? PlainCodeBlock
  const summary = summarizeSealContext(code)
  const filename = summary.file?.split('/').at(-1) ?? 'Editor context'
  const label = summary.lineRange ? `${filename}:${summary.lineRange}` : filename
  return (
    <div className="seal-context" aria-label="Seal editor context">
      <CodeBlock
        code={summary.selection ?? ''}
        language={summary.language ?? 'text'}
        label={`Seal · ${label}`}
        wrap
      />
    </div>
  )
}

const sealContext: BrowserPlugin = (ctx) => {
  const markdown = ctx.clientMarkdown
  const Renderer = (props: MarkdownCodeBlockProps) => <SealContextBlock {...props} markdown={markdown} />
  ctx.clientUi.registerStyle(ctx, 'seal-context', String(styles))
  markdown.registerCodeBlock(ctx, {
    id: 'seal-context',
    component: Renderer,
    languages: [SEAL_CONTEXT_LANGUAGE],
    priority: 100,
  })
}
sealContext.inject = ['clientUi', 'clientMarkdown']
export default sealContext
