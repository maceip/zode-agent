import { Check, Copy } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { Plugin } from 'cordis'
import Prism from 'prismjs'
import 'prismjs/components/prism-bash.js'
import 'prismjs/components/prism-c.js'
import 'prismjs/components/prism-cpp.js'
import 'prismjs/components/prism-diff.js'
import 'prismjs/components/prism-go.js'
import 'prismjs/components/prism-java.js'
import 'prismjs/components/prism-json.js'
import 'prismjs/components/prism-kotlin.js'
import 'prismjs/components/prism-markdown.js'
import 'prismjs/components/prism-python.js'
import 'prismjs/components/prism-rust.js'
import 'prismjs/components/prism-sql.js'
import 'prismjs/components/prism-swift.js'
import 'prismjs/components/prism-typescript.js'
import 'prismjs/components/prism-jsx.js'
import 'prismjs/components/prism-tsx.js'
import 'prismjs/components/prism-yaml.js'
import type { MarkdownCodeBlockProps } from './markdown-api.js'
import styles from './code-blocks.css'

export interface CodeBlockConfig {
  showLanguage?: boolean
  showCopyButton?: boolean
  fontSize?: number
  radius?: number
  languageLabels?: Record<string, string>
}

const aliases: Record<string, string> = {
  cxx: 'cpp',
  js: 'javascript',
  jsx: 'jsx',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  tsx: 'tsx',
  yml: 'yaml',
}

const labels: Record<string, string> = {
  bash: 'Shell',
  c: 'C',
  cpp: 'C++',
  diff: 'Diff',
  go: 'Go',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  jsx: 'JSX',
  kotlin: 'Kotlin',
  markdown: 'Markdown',
  python: 'Python',
  rust: 'Rust',
  sql: 'SQL',
  swift: 'Swift',
  tsx: 'TSX',
  typescript: 'TypeScript',
  yaml: 'YAML',
}

function normalizedLanguage(language: string | undefined): string {
  const normalized = language?.trim().toLocaleLowerCase() || 'plain'
  return aliases[normalized] ?? normalized
}

export function codeLanguageLabel(
  language: string | undefined,
  customLabels: Record<string, string> = {},
): string {
  const normalized = normalizedLanguage(language)
  return customLabels[normalized]
    ?? labels[normalized]
    ?? (normalized === 'plain' || normalized === 'text' || normalized === 'plaintext'
      ? 'Plain text'
      : `${normalized.charAt(0).toLocaleUpperCase()}${normalized.slice(1)}`)
}

export function highlightedCode(code: string, language: string | undefined): string | undefined {
  const normalized = normalizedLanguage(language)
  const grammar = Prism.languages[normalized]
  return grammar ? Prism.highlight(code, grammar, normalized) : undefined
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value ?? fallback))
}

export function DefaultCodeBlock({
  code,
  language,
  label: customLabel,
  headerActions,
  wrap,
  config,
}: MarkdownCodeBlockProps & { config: CodeBlockConfig }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | undefined>(undefined)
  const highlighted = highlightedCode(code, language)
  const label = customLabel ?? codeLanguageLabel(language, config.languageLabels)
  const style = {
    '--code-block-font-size': `${clamp(config.fontSize, 13, 10, 18)}px`,
    '--code-block-radius': `${clamp(config.radius, 12, 6, 24)}px`,
  } as CSSProperties

  useEffect(() => () => {
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
  }, [])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <figure className="cordis-code-block" data-language={normalizedLanguage(language)} data-wrap={wrap || undefined} style={style}>
      <figcaption>
        {customLabel !== undefined || config.showLanguage !== false ? <span title={label}>{label}</span> : <span />}
        <div className="cordis-code-block-actions">
          {headerActions}
          {config.showCopyButton !== false && (
            <button
              type="button"
              title={copied ? 'Copied' : 'Copy code'}
              aria-label={copied ? 'Copied' : 'Copy code'}
              onClick={() => void copy()}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}
        </div>
      </figcaption>
      <pre><code dangerouslySetInnerHTML={highlighted ? { __html: highlighted } : undefined}>{highlighted ? undefined : code}</code></pre>
    </figure>
  )
}

const codeBlocksClient: Plugin<CodeBlockConfig> = (ctx, config) => {
  const Renderer = (props: MarkdownCodeBlockProps) => <DefaultCodeBlock {...props} config={config} />
  ctx.clientMarkdown.registerCodeBlock(ctx, {
    id: 'default-light-code-block',
    component: Renderer,
    priority: 0,
  })
  ctx.clientUi.registerStyle(ctx, 'default-code-blocks', String(styles))
}

codeBlocksClient.inject = ['clientMarkdown', 'clientUi']

export default codeBlocksClient
