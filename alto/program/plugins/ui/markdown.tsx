import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TableHTMLAttributes,
  type ThHTMLAttributes,
} from 'react'
import {
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  ListChecks,
  Upload,
} from 'lucide-react'
import { SiGithub, SiLinear } from 'react-icons/si'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import type {
  MarkdownCodeBlockProps,
  MarkdownFileLinkHandler,
  MarkdownMathRenderer,
} from '../markdown-api.js'
import { openMarkdownFileLink, resolveMarkdownFileLink } from '../markdown-api.js'
import { MarkdownLink } from '../markdown-link.js'
import { WorkingShimmer } from './working-shimmer.js'

interface DirectiveNode {
  type: string
  name?: string
  attributes?: Record<string, string | null | undefined>
  children?: DirectiveNode[]
  data?: {
    hName?: string
    hProperties?: Record<string, string>
  }
}

const gitActions = new Set([
  'git-stage',
  'git-commit',
  'git-push',
  'git-create-branch',
  'git-create-pr',
])

function directiveHref(
  protocol: 'codex-file-citation' | 'codex-git-action',
  name: string,
  attributes: DirectiveNode['attributes'],
): string {
  const params = new URLSearchParams({ name })
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (typeof value === 'string') params.set(key, value)
  }
  return `${protocol}:?${params}`
}

function codexDirectives() {
  return (tree: DirectiveNode): void => {
    const visit = (node: DirectiveNode): void => {
      const directive = node.type === 'textDirective' || node.type === 'leafDirective'
      if (directive && node.name === 'codex-file-citation') {
        node.data = {
          hName: 'a',
          hProperties: {
            href: directiveHref('codex-file-citation', node.name, node.attributes),
          },
        }
      } else if (directive && node.name && gitActions.has(node.name)) {
        node.data = {
          hName: 'a',
          hProperties: {
            href: directiveHref('codex-git-action', node.name, node.attributes),
          },
        }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

const markdownPlugins = [remarkGfm, remarkDirective, codexDirectives]

function markdownUrlTransform(url: string): string {
  return url.startsWith('codex-file-citation:') || url.startsWith('codex-git-action:')
    ? url
    : defaultUrlTransform(url)
}

const MathRendererContext = createContext<MarkdownMathRenderer | undefined>(undefined)
const FileLinkHandlersContext = createContext<readonly MarkdownFileLinkHandler[]>([])

const minimumMarkdownColumnWidth = 72

interface MarkdownTableResizeController {
  begin: (handle: HTMLSpanElement, event: ReactPointerEvent<HTMLSpanElement>) => void
  nudge: (handle: HTMLSpanElement, delta: number) => void
  reset: () => void
}

interface MarkdownColumnDrag {
  column: number
  pointerId: number
  startX: number
  widths: readonly number[]
  handle: HTMLSpanElement
}

const MarkdownTableResizeContext = createContext<MarkdownTableResizeController | undefined>(undefined)

function columnIndex(handle: HTMLSpanElement): number | undefined {
  const header = handle.closest('th')
  return header instanceof HTMLTableCellElement ? header.cellIndex : undefined
}

function measuredColumnWidths(table: HTMLTableElement | null): number[] {
  const row = table?.tHead?.rows.item(0) ?? table?.rows.item(0)
  return row ? Array.from(row.cells, (cell) => cell.getBoundingClientRect().width) : []
}

function resizedColumns(
  widths: readonly number[],
  column: number,
  delta: number,
): number[] {
  const nextColumn = column + 1
  const current = widths[column]
  const adjacent = widths[nextColumn]
  if (current === undefined || adjacent === undefined) return [...widths]
  const clamped = Math.max(
    minimumMarkdownColumnWidth - current,
    Math.min(delta, adjacent - minimumMarkdownColumnWidth),
  )
  return widths.map((width, index) => (
    index === column ? current + clamped : index === nextColumn ? adjacent - clamped : width
  ))
}

function ResizableMarkdownTable({
  children,
  className,
  node: _node,
  style,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & { node?: unknown }): ReactNode {
  const tableRef = useRef<HTMLTableElement>(null)
  const widthsRef = useRef<readonly number[] | undefined>(undefined)
  const dragRef = useRef<MarkdownColumnDrag | undefined>(undefined)
  const [widths, setWidths] = useState<readonly number[] | undefined>(undefined)
  const [resizing, setResizing] = useState(false)

  const updateWidths = useCallback((next: readonly number[] | undefined): void => {
    widthsRef.current = next
    setWidths(next)
  }, [])

  const begin = useCallback((
    handle: HTMLSpanElement,
    event: ReactPointerEvent<HTMLSpanElement>,
  ): void => {
    const column = columnIndex(handle)
    const measured = measuredColumnWidths(tableRef.current)
    if (column === undefined || column >= measured.length - 1) return
    event.preventDefault()
    handle.setPointerCapture(event.pointerId)
    dragRef.current = {
      column,
      pointerId: event.pointerId,
      startX: event.clientX,
      widths: measured,
      handle,
    }
    updateWidths(measured)
    setResizing(true)
  }, [updateWidths])

  const finishDrag = useCallback((pointerId?: number): void => {
    const drag = dragRef.current
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return
    dragRef.current = undefined
    setResizing(false)
    if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
  }, [])

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      if (event.buttons === 0) {
        finishDrag(event.pointerId)
        return
      }
      event.preventDefault()
      updateWidths(resizedColumns(drag.widths, drag.column, event.clientX - drag.startX))
    }
    const end = (event: PointerEvent): void => finishDrag(event.pointerId)
    const blur = (): void => finishDrag()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', blur)
    }
  }, [finishDrag, updateWidths])

  const nudge = useCallback((handle: HTMLSpanElement, delta: number): void => {
    const column = columnIndex(handle)
    const current = widthsRef.current ?? measuredColumnWidths(tableRef.current)
    if (column === undefined || column >= current.length - 1) return
    updateWidths(resizedColumns(current, column, delta))
  }, [updateWidths])

  const reset = useCallback((): void => {
    finishDrag()
    updateWidths(undefined)
  }, [finishDrag, updateWidths])
  const controller = useMemo<MarkdownTableResizeController>(() => ({
    begin,
    nudge,
    reset,
  }), [begin, nudge, reset])
  const tableWidth = widths?.reduce((total, width) => total + width, 0)

  return (
    <div className="markdown-table-shell">
      <MarkdownTableResizeContext value={controller}>
        <table
          {...props}
          ref={tableRef}
          className={[
            className,
            widths ? 'markdown-table-resized' : '',
            resizing ? 'markdown-table-resizing' : '',
          ].filter(Boolean).join(' ')}
          style={{
            ...style,
            ...(tableWidth ? { tableLayout: 'fixed', width: `${tableWidth}px` } : {}),
          }}
        >
          {widths && (
            <colgroup>
              {widths.map((width, index) => <col key={index} style={{ width: `${width}px` }} />)}
            </colgroup>
          )}
          {children}
        </table>
      </MarkdownTableResizeContext>
    </div>
  )
}

function ResizableMarkdownHeader({
  children,
  node: _node,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { node?: unknown }): ReactNode {
  const resize = useContext(MarkdownTableResizeContext)
  const onKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>): void => {
    if (!resize) return
    const step = event.shiftKey ? 32 : 12
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      resize.nudge(event.currentTarget, event.key === 'ArrowLeft' ? -step : step)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      resize.reset()
    }
  }
  return (
    <th {...props}>
      <span className="markdown-table-heading">{children}</span>
      {resize && (
        <span
          className="markdown-table-resize-handle"
          role="separator"
          aria-label="Resize table column"
          aria-orientation="vertical"
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onDoubleClick={resize.reset}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => resize.begin(event.currentTarget, event)}
        />
      )}
    </th>
  )
}

const markdownBlockTags = new Set([
  'blockquote',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ol',
  'p',
  'pre',
  'table',
  'ul',
])

function markdownTagName(node: ReactNode): string | undefined {
  if (!isValidElement<{ node?: { tagName?: string } }>(node)) return undefined
  if (typeof node.type === 'string') return node.type
  return node.props.node?.tagName
}

function lineFragmentChildren(children: ReactNode): ReactNode {
  const result: ReactNode[] = []
  let inline: ReactNode[] = []
  let segment = 0
  const flush = (): void => {
    if (!inline.length) return
    result.push(<WorkingShimmer className="activity-text-line" key={`line:${segment}`}>{inline}</WorkingShimmer>)
    inline = []
    segment += 1
  }
  for (const child of Children.toArray(children)) {
    const tag = markdownTagName(child)
    if (tag && markdownBlockTags.has(tag)) {
      flush()
      result.push(child)
    } else {
      inline.push(child)
    }
  }
  flush()
  return result
}

export function MarkdownMathProvider({
  renderer,
  fileLinks = [],
  children,
}: {
  renderer: MarkdownMathRenderer | undefined
  fileLinks?: readonly MarkdownFileLinkHandler[]
  children: ReactNode
}): ReactNode {
  return (
    <MathRendererContext value={renderer}>
      <FileLinkHandlersContext value={fileLinks}>{children}</FileLinkHandlersContext>
    </MathRendererContext>
  )
}

type GitActionName =
  | 'git-stage'
  | 'git-commit'
  | 'git-push'
  | 'git-create-branch'
  | 'git-create-pr'

export type SmartLinkDetails =
  | { kind: 'github' | 'linear'; label?: string }
  | {
    kind: 'file'
    label: string
    path: string
    purpose?: string
    line?: number
    endLine?: number
    column?: number
  }
  | {
    kind: 'git'
    action: GitActionName
    label: string
    cwd?: string
    url?: string
  }

function basename(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/$/, '').split('/').at(-1) || path
}

function positiveInteger(value: string | null | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function localFileDetails(
  rawPath: string,
  explicitLine?: string,
  explicitEndLine?: string,
  explicitColumn?: string,
): Extract<SmartLinkDetails, { kind: 'file' }> {
  const fragmentLocation = /^(.*)#L(\d+)(?:C(\d+))?$/.exec(rawPath)
  const suffixLocation = fragmentLocation ? undefined : /^(.*):(\d+)(?::(\d+))?$/.exec(rawPath)
  const path = fragmentLocation?.[1] ?? suffixLocation?.[1] ?? rawPath
  const line = positiveInteger(explicitLine ?? fragmentLocation?.[2] ?? suffixLocation?.[2])
  const endLine = positiveInteger(explicitEndLine)
  const column = positiveInteger(explicitColumn ?? fragmentLocation?.[3] ?? suffixLocation?.[3])
  const location = line ? `:${line}${column ? `:${column}` : ''}` : ''
  return {
    kind: 'file',
    label: `${basename(path)}${location}`,
    path,
    ...(line ? { line } : {}),
    ...(endLine ? { endLine } : {}),
    ...(column ? { column } : {}),
  }
}

function decodedUriComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function gitActionDetails(url: URL): SmartLinkDetails | undefined {
  const action = url.searchParams.get('name')
  if (!action || !gitActions.has(action)) return undefined
  const branch = url.searchParams.get('branch') ?? undefined
  const target = url.searchParams.get('url') ?? undefined
  const draft = url.searchParams.get('isDraft') === 'true'
  const pull = target ? /\/pull\/(\d+)(?:\/|$)/.exec(target)?.[1] : undefined
  const label = action === 'git-stage'
    ? 'Staged changes'
    : action === 'git-commit'
      ? 'Committed'
      : action === 'git-push'
        ? branch ? `Pushed ${branch}` : 'Pushed'
        : action === 'git-create-branch'
          ? branch ? `Created ${branch}` : 'Created branch'
          : `${draft ? 'Opened draft' : 'Opened'} ${pull ? `#${pull}` : 'PR'}`
  return {
    kind: 'git',
    action: action as GitActionName,
    label,
    ...(url.searchParams.get('cwd') ? { cwd: url.searchParams.get('cwd')! } : {}),
    ...(target ? { url: target } : {}),
  }
}

export function smartLinkDetails(href: string, text?: string): SmartLinkDetails | undefined {
  const localPath = href.startsWith('/')
    ? decodedUriComponent(href)
    : /^[A-Za-z]:[\\/]/.test(href)
      ? href
      : undefined
  if (localPath) {
    return localFileDetails(localPath)
  }

  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }

  if (url.protocol === 'codex-file-citation:') {
    const path = url.searchParams.get('path')
    if (!path) return undefined
    const purpose = url.searchParams.get('purpose') ?? undefined
    const line = url.searchParams.get('line')
      ?? url.searchParams.get('startLine')
      ?? url.searchParams.get('lineNumber')
    const endLine = url.searchParams.get('endLine')
    const column = url.searchParams.get('column')
      ?? url.searchParams.get('startColumn')
    return {
      ...localFileDetails(path, line ?? undefined, endLine ?? undefined, column ?? undefined),
      ...(purpose ? { purpose } : {}),
    }
  }

  if (url.protocol === 'file:') {
    const path = decodedUriComponent(url.pathname)
    if (!path) return undefined
    const normalized = /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
    return localFileDetails(`${normalized}${url.hash}`)
  }

  if (url.protocol === 'codex-git-action:') return gitActionDetails(url)

  const visibleText = text?.trim()
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const issue = /\/(?:pull|issues)\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1]
    const commit = /\/commit\/([a-f\d]{7,40})(?:\/|$)/i.exec(url.pathname)?.[1]
    const compact = !visibleText || visibleText === href || visibleText === url.toString()
    return {
      kind: 'github',
      ...(compact && issue ? { label: `#${issue}` } : {}),
      ...(compact && !issue && commit ? { label: commit.slice(0, 7) } : {}),
    }
  }

  if (url.hostname === 'linear.app' || url.hostname.endsWith('.linear.app')) {
    const issue = /\/issue\/([A-Za-z][A-Za-z\d]*-\d+)(?:\/|$)/.exec(url.pathname)?.[1]
    const compact = !visibleText || visibleText === href || visibleText === url.toString()
    return {
      kind: 'linear',
      ...(compact && issue ? { label: issue.toUpperCase() } : {}),
    }
  }

  return undefined
}

function localFileHref(path: string): string {
  const url = new URL('file:///')
  url.pathname = /^[A-Za-z]:[\\/]/.test(path) ? `/${path.replaceAll('\\', '/')}` : path
  return url.toString()
}

function GitActionIcon({ action }: { action: GitActionName }): ReactNode {
  if (action === 'git-stage') return <ListChecks size={13} aria-hidden="true" />
  if (action === 'git-commit') return <GitCommitHorizontal size={13} aria-hidden="true" />
  if (action === 'git-push') return <Upload size={13} aria-hidden="true" />
  if (action === 'git-create-branch') return <GitBranch size={13} aria-hidden="true" />
  return <GitPullRequest size={13} aria-hidden="true" />
}

function plainText(children: ReactNode): string | undefined {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (!Array.isArray(children)) return undefined
  const parts = children.map(plainText)
  return parts.every((part) => part !== undefined) ? parts.join('') : undefined
}

function hasInlineCode(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => markdownTagName(child) === 'code')
}

function siteLinkPreview(href: string | undefined): string | undefined {
  if (!href) return undefined
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? href : undefined
  } catch {
    return undefined
  }
}

function fencedCode(children: ReactNode): MarkdownCodeBlockProps | undefined {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return undefined
  const code = plainText(children.props.children)
  if (code === undefined) return undefined
  const language = /(?:^|\s)language-([^\s]+)/.exec(children.props.className ?? '')?.[1]
  const normalized = code.endsWith('\n') ? code.slice(0, -1) : code
  return {
    code: normalized,
    ...(language ? { language } : {}),
  }
}

function displayMath(children: ReactNode): string | undefined {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return undefined
  const classes = new Set((children.props.className ?? '').split(/\s+/))
  if (!classes.has('language-math') || !classes.has('math-display')) return undefined
  const formula = plainText(children.props.children)
  return formula?.endsWith('\n') ? formula.slice(0, -1) : formula
}

function SmartLink({
  href,
  children,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>): ReactNode {
  const fileLinks = useContext(FileLinkHandlersContext)
  const details = href ? smartLinkDetails(href, plainText(children)) : undefined
  if (!details) {
    return (
      <MarkdownLink
        {...props}
        href={href}
        className={className}
        preview={siteLinkPreview(href)}
        target="_blank"
        rel="noreferrer"
      >
        {children}
      </MarkdownLink>
    )
  }

  if (details.kind === 'file') {
    const handler = resolveMarkdownFileLink(fileLinks, details.path)
    const desktopOpenFile = typeof window === 'undefined'
      ? undefined
      : window.__ALTO_DESKTOP__?.openFile
    return (
      <a
        {...props}
        href={localFileHref(details.path)}
        className={['file-citation', className].filter(Boolean).join(' ')}
        data-file-link-handler={handler?.id}
        title={details.path}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          props.onClick?.(event)
          if (event.defaultPrevented || event.button !== 0
            || event.metaKey
            || event.ctrlKey
            || event.shiftKey
            || event.altKey
          ) return
          if (!handler && !desktopOpenFile) return
          if (openMarkdownFileLink(fileLinks, details, event.currentTarget)) {
            event.preventDefault()
            return
          }
          if (desktopOpenFile) {
            event.preventDefault()
            void desktopOpenFile(details.path).catch((error: unknown) => {
              console.error(`Could not open local file ${details.path}`, error)
            })
          }
        }}
      >
        <FileText size={12} strokeWidth={1.6} aria-hidden="true" />
        <span>{details.label}</span>
      </a>
    )
  }

  if (details.kind === 'git') {
    const content = (
      <>
        <GitActionIcon action={details.action} />
        <span>{details.label}</span>
      </>
    )
    const gitClass = ['git-action', details.url ? 'git-action-link' : '', className]
      .filter(Boolean)
      .join(' ')
    return details.url ? (
      <MarkdownLink
        href={details.url}
        className={gitClass}
        preview={siteLinkPreview(details.url)}
        target="_blank"
        rel="noreferrer"
      >
        {content}
      </MarkdownLink>
    ) : (
      <span className={gitClass} title={details.cwd}>{content}</span>
    )
  }

  return (
    <MarkdownLink
      {...props}
      href={href}
      preview={siteLinkPreview(href)}
      className={[
        'smart-link',
        `smart-link-${details.kind}`,
        hasInlineCode(children) ? 'smart-link-code' : '',
        className,
      ].filter(Boolean).join(' ')}
      target="_blank"
      rel="noreferrer"
    >
      {details.kind === 'github'
        ? <SiGithub className="smart-link-icon" size={14} aria-hidden="true" />
        : <SiLinear className="smart-link-icon smart-link-linear-icon" size={14} aria-hidden="true" />}
      <span>{details.label ?? children}</span>
    </MarkdownLink>
  )
}

export function MarkdownContent({
  source,
  className,
  label,
  codeBlock: CodeBlock,
}: {
  source: string
  className: string
  label?: string
  codeBlock?: ComponentType<MarkdownCodeBlockProps>
}): ReactNode {
  const math = useContext(MathRendererContext)
  const Math = math?.component
  const markdownSource = math?.preprocess ? math.preprocess(source) : source
  const remarkPlugins = useMemo(
    () => math ? [...markdownPlugins, ...math.remarkPlugins] : markdownPlugins,
    [math],
  )
  const components = useMemo<Components>(() => ({
    a: ({ node: _node, ...props }) => <SmartLink {...props} />,
    table: ResizableMarkdownTable,
    th: ResizableMarkdownHeader,
    p: ({ node: _node, children, ...props }) => (
      <p {...props}><WorkingShimmer className="activity-text-line">{children}</WorkingShimmer></p>
    ),
    li: ({ node: _node, children, ...props }) => (
      <li {...props}>{lineFragmentChildren(children)}</li>
    ),
    pre: ({ node: _node, children, ...props }) => {
      const formula = displayMath(children)
      if (Math && formula !== undefined) return <Math formula={formula} display />
      const block = fencedCode(children)
      return CodeBlock && block
        ? <CodeBlock {...block} />
        : <pre {...props}>{children}</pre>
    },
    code: ({ node: _node, className, children, ...props }) => {
      const classes = new Set((className ?? '').split(/\s+/))
      const formula = plainText(children)
      return Math && formula !== undefined && classes.has('language-math') && classes.has('math-inline')
        ? <Math formula={formula} display={false} />
        : <code {...props} className={className}>{children}</code>
    },
  }), [CodeBlock, Math])
  return (
    <div className={className} aria-label={label}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        skipHtml
        urlTransform={markdownUrlTransform}
        components={components}
      >
        {markdownSource}
      </ReactMarkdown>
    </div>
  )
}

export function MessageMarkdown({
  source,
  codeBlock,
}: {
  source: string
  codeBlock?: ComponentType<MarkdownCodeBlockProps>
}): ReactNode {
  return (
    <MarkdownContent
      source={source}
      className="activity-content activity-markdown"
      {...(codeBlock ? { codeBlock } : {})}
    />
  )
}
