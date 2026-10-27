import type { CSSProperties, ReactNode } from 'react'
import type { Plugin } from 'cordis'
import { renderToString } from 'katex'
import remarkMath from 'remark-math'
import type { MarkdownMathProps } from './markdown-api.js'
import styles from './math.css'
import katexStyles from 'katex/dist/katex.min.css'
import amsRegular from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2'
import caligraphicBold from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2'
import caligraphicRegular from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2'
import frakturBold from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2'
import frakturRegular from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2'
import mainBold from 'katex/dist/fonts/KaTeX_Main-Bold.woff2'
import mainBoldItalic from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2'
import mainItalic from 'katex/dist/fonts/KaTeX_Main-Italic.woff2'
import mainRegular from 'katex/dist/fonts/KaTeX_Main-Regular.woff2'
import mathBoldItalic from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2'
import mathItalic from 'katex/dist/fonts/KaTeX_Math-Italic.woff2'
import sansSerifBold from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2'
import sansSerifItalic from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2'
import sansSerifRegular from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2'
import scriptRegular from 'katex/dist/fonts/KaTeX_Script-Regular.woff2'
import size1Regular from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2'
import size2Regular from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2'
import size3Regular from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2'
import size4Regular from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2'
import typewriterRegular from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2'

export interface MathConfig {
  singleDollar?: boolean
  inlineScale?: number
  displayScale?: number
  macros?: Record<string, string>
}

interface BundledFont {
  family: string
  source: string
  style?: 'normal' | 'italic'
  weight?: 400 | 700
}

const bundledFonts: BundledFont[] = [
  { family: 'KaTeX_AMS', source: amsRegular },
  { family: 'KaTeX_Caligraphic', source: caligraphicBold, weight: 700 },
  { family: 'KaTeX_Caligraphic', source: caligraphicRegular },
  { family: 'KaTeX_Fraktur', source: frakturBold, weight: 700 },
  { family: 'KaTeX_Fraktur', source: frakturRegular },
  { family: 'KaTeX_Main', source: mainBold, weight: 700 },
  { family: 'KaTeX_Main', source: mainBoldItalic, style: 'italic', weight: 700 },
  { family: 'KaTeX_Main', source: mainItalic, style: 'italic' },
  { family: 'KaTeX_Main', source: mainRegular },
  { family: 'KaTeX_Math', source: mathBoldItalic, style: 'italic', weight: 700 },
  { family: 'KaTeX_Math', source: mathItalic, style: 'italic' },
  { family: 'KaTeX_SansSerif', source: sansSerifBold, weight: 700 },
  { family: 'KaTeX_SansSerif', source: sansSerifItalic, style: 'italic' },
  { family: 'KaTeX_SansSerif', source: sansSerifRegular },
  { family: 'KaTeX_Script', source: scriptRegular },
  { family: 'KaTeX_Size1', source: size1Regular },
  { family: 'KaTeX_Size2', source: size2Regular },
  { family: 'KaTeX_Size3', source: size3Regular },
  { family: 'KaTeX_Size4', source: size4Regular },
  { family: 'KaTeX_Typewriter', source: typewriterRegular },
]

function clamp(value: number | undefined, min: number, max: number): number {
  return Math.max(min, Math.min(max, value ?? 1))
}

function escapedDelimiter(line: string, index: number): boolean {
  let backslashes = 0
  while (index > 0 && line[--index] === '\\') backslashes += 1
  return backslashes % 2 === 1
}

function standaloneDisplayMath(line: string): string | undefined {
  const match = /^\$\$([^\n]+)\$\$([ \t]*\r?)$/.exec(line)
  if (!match) return undefined
  const formula = match[1]!
  // Extra dollar delimiters may be separate inline expressions or a longer
  // math fence. Neither is an unambiguous single-line display expression.
  if (!formula.trim() || formula.startsWith('$') || formula.endsWith('$')
    || formula.includes('$$') || escapedDelimiter(line, 2 + formula.length)) return undefined
  const newline = line.endsWith('\r') ? '\r\n' : '\n'
  return `$$${newline}${formula}${newline}$$${match[2]}`
}

export function normalizeLatexDelimiters(source: string): string {
  let fence: { marker: '`' | '~'; length: number } | undefined
  let codeTicks = 0
  let mathFence: { length: number; latex: boolean } | undefined
  let containerParagraph = false

  return source.split('\n').map((line) => {
    if (mathFence) {
      // Math block contents are TeX, so backticks there must not open a
      // Markdown code span that leaks into the following prose.
      const closing = mathFence.latex && /^ {0,3}\\\][ \t]*\r?$/.test(line)
        ? line.replace('\\]', () => '$$') : line
      const dollars = /^ {0,3}(\${2,})[ \t]*\r?$/.exec(closing)
      if (dollars && dollars[1]!.length >= mathFence.length) mathFence = undefined
      return closing
    }
    const fenceRun = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fenceRun) {
      const marker = fenceRun[0] as '`' | '~'
      if (!fence && codeTicks === 0) fence = { marker, length: fenceRun.length }
      else if (fence?.marker === marker && fenceRun.length >= fence.length) fence = undefined
      return line
    }
    if (fence) return line

    if (codeTicks === 0) {
      if (!line.trim()) containerParagraph = false
      else if (/^ {0,3}(?:>|[-+*][ \t]|\d+[.)][ \t])/.test(line)) containerParagraph = true
    }
    const continuedCodeSpan = codeTicks > 0
    let normalized = ''
    for (let index = 0; index < line.length;) {
      if (line[index] === '`') {
        let end = index + 1
        while (line[end] === '`') end += 1
        const run = end - index
        if (codeTicks === 0) codeTicks = run
        else if (codeTicks === run) codeTicks = 0
        normalized += line.slice(index, end)
        index = end
        continue
      }

      const delimiter = line.slice(index, index + 2)
      const unescaped = index === 0 || line[index - 1] !== '\\'
      if (codeTicks === 0 && unescaped && (delimiter === '\\(' || delimiter === '\\)')) {
        normalized += '$'
        index += 2
        continue
      }
      if (codeTicks === 0 && unescaped && (delimiter === '\\[' || delimiter === '\\]')) {
        normalized += '$$'
        index += 2
        continue
      }

      normalized += line[index]
      index += 1
    }

    if (!continuedCodeSpan && codeTicks === 0 && !containerParagraph) {
      // Only expand a column-zero line. Adding unprefixed lines inside a list
      // or blockquote would change its structure, including lazy continuations.
      const display = standaloneDisplayMath(normalized)
      if (display !== undefined) return display
      const openingFence = /^ {0,3}(\${2,})[^$]*$/.exec(normalized)
      if (openingFence) mathFence = {
        length: openingFence[1]!.length,
        latex: line.trimStart().startsWith('\\['),
      }
    }
    return normalized
  }).join('\n')
}

function fontFaces(): string {
  return bundledFonts.map((font) => [
    '@font-face{',
    'font-display:block;',
    `font-family:${JSON.stringify(font.family)};`,
    `font-style:${font.style ?? 'normal'};`,
    `font-weight:${font.weight ?? 400};`,
    `src:url(${JSON.stringify(font.source)}) format("woff2")`,
    '}',
  ].join('')).join('\n')
}

export function bundledMathStyles(): string {
  const layout = String(katexStyles).replace(/@font-face\{[^}]*\}/g, '')
  return `${fontFaces()}\n${layout}\n${String(styles)}`
}

export function mathMarkup(
  formula: string,
  display: boolean,
  macros: Record<string, string> = {},
): string {
  return renderToString(formula, {
    displayMode: display,
    macros,
    maxExpand: 1_000,
    maxSize: 24,
    output: 'htmlAndMathml',
    strict: 'ignore',
    throwOnError: false,
    trust: false,
  })
}

export function DefaultMath({
  formula,
  display,
  config,
}: MarkdownMathProps & { config: MathConfig }): ReactNode {
  const scale = clamp(display ? config.displayScale : config.inlineScale, 0.75, 1.5)
  const style: CSSProperties = { fontSize: `${scale}em` }
  const className = display ? 'cordis-math cordis-math-display' : 'cordis-math cordis-math-inline'
  const html = mathMarkup(formula, display, config.macros)

  return display
    ? <div className={className} style={style} dangerouslySetInnerHTML={{ __html: html }} />
    : <span className={className} style={style} dangerouslySetInnerHTML={{ __html: html }} />
}

const mathClient: Plugin<MathConfig> = (ctx, config) => {
  const Renderer = (props: MarkdownMathProps) => <DefaultMath {...props} config={config} />
  ctx.clientMarkdown.registerMath(ctx, {
    id: 'default-katex-math',
    component: Renderer,
    remarkPlugins: [[remarkMath, { singleDollarTextMath: config.singleDollar !== false }]],
    preprocess: normalizeLatexDelimiters,
    priority: 0,
  })
  ctx.clientUi.registerStyle(ctx, 'default-katex-math', bundledMathStyles())
}

mathClient.inject = ['clientMarkdown', 'clientUi']

export default mathClient
