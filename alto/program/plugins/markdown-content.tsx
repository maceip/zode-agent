import { useMemo, useSyncExternalStore, type ComponentType } from 'react'
import { resolveMarkdownCodeBlock, type ClientMarkdownService, type MarkdownCodeBlockProps } from './markdown-api.js'
import { MarkdownContent, MarkdownMathProvider } from './ui/markdown.js'

export interface MarkdownContentProps {
  source: string
  className: string
  label?: string
}

/** Keep external panes on the active Markdown, code, math, and file-link renderers. */
export function createMarkdownContentRenderer(markdown: ClientMarkdownService): ComponentType<MarkdownContentProps> {
  return function RegisteredMarkdownContent(props) {
    const state = useSyncExternalStore(markdown.subscribe, markdown.snapshot, markdown.snapshot)
    const CodeBlock = useMemo(() => {
      if (!state.codeBlocks.length) return undefined
      return function RegisteredCodeBlock(block: MarkdownCodeBlockProps) {
        const Renderer = resolveMarkdownCodeBlock(state.codeBlocks, block.language)?.component
        return Renderer
          ? <Renderer {...block} />
          : <pre><code className={block.language ? `language-${block.language}` : undefined}>{block.code}</code></pre>
      }
    }, [state.codeBlocks])
    return (
      <MarkdownMathProvider renderer={state.math} fileLinks={state.fileLinks}>
        <MarkdownContent {...props} {...(CodeBlock ? { codeBlock: CodeBlock } : {})} />
      </MarkdownMathProvider>
    )
  }
}
