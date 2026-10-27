import type { ComponentType, ReactNode } from 'react'
import type { Options as ReactMarkdownOptions } from 'react-markdown'

export interface MarkdownCodeBlockProps {
  code: string
  language?: string
  label?: string
  headerActions?: ReactNode
  wrap?: boolean
}

export interface MarkdownCodeBlockRenderer {
  id: string
  component: ComponentType<MarkdownCodeBlockProps>
  /** Lowercase fenced-code languages handled by this renderer. Omit to match every language. */
  languages?: readonly string[]
  priority?: number
}

export interface MarkdownCodeBlockRegistration {
  dispose(): Promise<void>
}

export interface MarkdownMathProps {
  formula: string
  display: boolean
}

export interface MarkdownMathRenderer {
  id: string
  component: ComponentType<MarkdownMathProps>
  remarkPlugins: NonNullable<ReactMarkdownOptions['remarkPlugins']>
  preprocess?: (source: string) => string
  priority?: number
}

export interface MarkdownMathRegistration {
  dispose(): Promise<void>
}

export interface MarkdownFileLinkDetails {
  label: string
  path: string
  purpose?: string
  line?: number
  endLine?: number
  column?: number
}

export interface MarkdownFileLinkHandler {
  id: string
  /** Lowercase filename extensions, including the leading dot. */
  extensions?: readonly string[]
  /** Handles extensionless or otherwise feature-specific filenames. */
  matches?: (filePath: string) => boolean
  priority?: number
  /** Return false to let the next matching handler open the link. */
  open(details: MarkdownFileLinkDetails, origin: HTMLElement): void | boolean
}

export interface MarkdownFileLinkRegistration {
  dispose(): Promise<void>
}

export interface ClientMarkdownSnapshot {
  revision: number
  codeBlocks: readonly MarkdownCodeBlockRenderer[]
  fileLinks: readonly MarkdownFileLinkHandler[]
  math?: MarkdownMathRenderer
}

export function normalizeMarkdownLanguage(language: string | undefined): string {
  return language?.trim().toLocaleLowerCase() ?? ''
}

export function resolveMarkdownCodeBlock(
  renderers: readonly MarkdownCodeBlockRenderer[],
  language: string | undefined,
): MarkdownCodeBlockRenderer | undefined {
  const normalized = normalizeMarkdownLanguage(language)
  return renderers.find((renderer) => (
    !renderer.languages?.length
    || renderer.languages.some((candidate) => normalizeMarkdownLanguage(candidate) === normalized)
  ))
}

export function resolveMarkdownFileLink(
  handlers: readonly MarkdownFileLinkHandler[],
  filePath: string,
): MarkdownFileLinkHandler | undefined {
  const normalized = filePath.trim().toLocaleLowerCase()
  return handlers.find((handler) => (
    handler.matches?.(filePath) === true
    || handler.extensions?.some((extension) => (
      normalized.endsWith(extension.trim().toLocaleLowerCase())
    )) === true
  ))
}

/** Resolve at click time: an editor can open or close after a link renders. */
export function openMarkdownFileLink(
  handlers: readonly MarkdownFileLinkHandler[],
  details: MarkdownFileLinkDetails,
  origin: HTMLElement,
): boolean {
  for (const handler of handlers) {
    if (resolveMarkdownFileLink([handler], details.path) && handler.open(details, origin) !== false) return true
  }
  return false
}

export interface ClientMarkdownService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientMarkdownSnapshot
  registerCodeBlock(
    owner: import('cordis').Context,
    renderer: MarkdownCodeBlockRenderer,
  ): MarkdownCodeBlockRegistration
  registerMath(
    owner: import('cordis').Context,
    renderer: MarkdownMathRenderer,
  ): MarkdownMathRegistration
  registerFileLink(
    owner: import('cordis').Context,
    handler: MarkdownFileLinkHandler,
  ): MarkdownFileLinkRegistration
}

declare module 'cordis' {
  interface Context {
    clientMarkdown: ClientMarkdownService
  }
}
