import { formatMarkdownInput } from './markdown-editing.js'
import type { ClientComposerService } from './composer-api.js'
import { MarkdownSelectionMenu } from './markdown-selection-menu.js'
import { markdownSelectionQuote, restoreMarkdownSelection, type MarkdownSelection, type MarkdownSelectionBookmark } from './markdown-selection.js'
import { paneToolbarStyles } from './pane-toolbar.js'
import {
  Check,
  Download,
  FileText,
  Pencil,
  RefreshCw,
  TextWrap,
} from 'lucide-react'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  clientStyles,
  type BrowserPlugin,
  type ClientHostService,
} from '../../src/client/plugin-api.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import {
  resolveMarkdownCodeBlock,
  type ClientMarkdownService,
  type ClientMarkdownSnapshot,
  type MarkdownCodeBlockProps,
  type MarkdownCodeBlockRenderer,
  type MarkdownMathProps,
  type MarkdownMathRenderer,
} from './markdown-api.js'
import {
  markdownViewerResource,
  parseMarkdownViewerResource,
  MARKDOWN_VIEWER_READ_METHOD,
  MARKDOWN_VIEWER_WRITE_METHOD,
  type MarkdownDocument,
} from './markdown-viewer-api.js'
import type {
  ClientWorkspaceLayoutService,
  WorkspacePaneKindProps,
} from './workspace-layout-api.js'
import { MarkdownContent, MarkdownMathProvider } from './ui/markdown.js'
import { useLineWrapPreference } from './viewer-preferences.js'
import { useViewerActivated } from './viewer-activation.js'
import styles from './markdown-viewer.css'

type DocumentState =
  | { tag: 'idle' | 'loading' }
  | { tag: 'ready'; document: MarkdownDocument }
  | { tag: 'failed'; problem: string }

function parsedDocument(value: JsonValue): MarkdownDocument {
  if (
    !isRecord(value)
    || typeof value.path !== 'string'
    || typeof value.name !== 'string'
    || typeof value.source !== 'string'
    || typeof value.modifiedAt !== 'number'
  ) throw new Error('Alto returned an invalid Markdown document')
  return {
    path: value.path,
    name: value.name,
    source: value.source,
    modifiedAt: value.modifiedAt,
  }
}

function CodeBlockDispatcher({
  renderers,
  ...props
}: MarkdownCodeBlockProps & {
  renderers: readonly MarkdownCodeBlockRenderer[]
}): ReactNode {
  const match = resolveMarkdownCodeBlock(renderers, props.language)
  if (match) {
    const Renderer = match.component
    return <Renderer {...props} />
  }
  const className = props.language ? `language-${props.language}` : undefined
  return <pre><code className={className}>{props.code}</code></pre>
}

function download(document: MarkdownDocument): void {
  const url = URL.createObjectURL(new Blob([document.source], { type: 'text/markdown;charset=utf-8' }))
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = document.name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const markdownConverter = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  preformattedCode: true,
})
markdownConverter.use(gfm)
markdownConverter.addRule('gfmStrikethrough', {
  filter: (node) => ['del', 's', 'strike'].includes(node.tagName.toLocaleLowerCase()),
  replacement: (content) => `~~${content}~~`,
})
markdownConverter.addRule('markdownViewerChrome', {
  filter: (node) => (
    node.tagName.toLocaleLowerCase() === 'svg'
    || node.classList.contains('markdown-table-resize-handle')
  ),
  replacement: () => '',
})

// Math stays parsed during editing; save its TeX directly instead of escaping it as prose.
markdownConverter.addRule('markdownViewerMath', {
  filter: (node) => node.hasAttribute('data-markdown-math'),
  replacement: (_content, node) => {
    const formula = node.textContent ?? ''
    return node.getAttribute('data-markdown-math') === 'display'
      ? `\n\n$$\n${formula}\n$$\n\n`
      : `$${formula}$`
  },
})

function MathSource({ formula, display }: MarkdownMathProps): ReactNode {
  return display
    ? <pre data-markdown-math="display"><code>{formula}</code></pre>
    : <code data-markdown-math="inline">{formula}</code>
}

export function markdownEditorMath(renderer: MarkdownMathRenderer | undefined): MarkdownMathRenderer | undefined {
  return renderer ? { ...renderer, component: MathSource } : undefined
}

export function renderedMarkdownSource(content: string | HTMLElement): string {
  const source = markdownConverter.turndown(content).trimEnd()
  return source ? `${source}\n` : ''
}

const RenderedMarkdownEditor = memo(function RenderedMarkdownEditor({
  document,
  editing,
  saving,
  markdownState,
  codeBlock,
  editorRef,
  onDirty,
  editSelection,
}: {
  document: MarkdownDocument
  editing: boolean
  saving: boolean
  markdownState: ClientMarkdownSnapshot
  codeBlock?: ComponentType<MarkdownCodeBlockProps> | undefined
  editorRef: RefObject<HTMLDivElement | null>
  onDirty: () => void
  editSelection?: MarkdownSelectionBookmark | undefined
}): ReactNode {
  const mathRenderer = useMemo(
    () => editing ? markdownEditorMath(markdownState.math) : markdownState.math,
    [editing, markdownState.math],
  )
  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editing || !editor) return
    editor.focus({ preventScroll: true })
    if (editSelection) restoreMarkdownSelection(editor, editSelection)
  }, [editing, editorRef, editSelection])

  useEffect(() => {
    const editor = editorRef.current
    if (!editing || saving || !editor) return
    const beforeInput = (event: InputEvent): void => {
      if (formatMarkdownInput(editor, event)) onDirty()
    }
    editor.addEventListener('beforeinput', beforeInput)
    return () => editor.removeEventListener('beforeinput', beforeInput)
  }, [editing, saving, editorRef, onDirty])

  return (
    <div
      className={`markdown-viewer-rendered-editor${editing ? ' is-editing' : ''}`}
      ref={editorRef}
      contentEditable={editing && !saving}
      aria-busy={saving || undefined}
      suppressContentEditableWarning
      role={editing ? 'textbox' : undefined}
      aria-label={editing ? `Edit ${document.name}` : undefined}
      aria-multiline={editing || undefined}
      tabIndex={0}
      onInput={editing ? onDirty : undefined}
      onClick={(event) => {
        if (!editing) return
        const target = event.target
        if (target instanceof Element && target.closest('a')) event.preventDefault()
      }}
    >
      <MarkdownMathProvider
        renderer={mathRenderer}
        fileLinks={markdownState.fileLinks}
      >
        <MarkdownContent
          className="activity-markdown markdown-viewer-document"
          source={document.source}
          label={document.name}
          {...(!editing && codeBlock ? { codeBlock } : {})}
        />
      </MarkdownMathProvider>
    </div>
  )
})

function MarkdownViewerPane({
  pane,
  visible,
  host,
  markdown,
  workspaceId,
  layout,
  composer,
}: WorkspacePaneKindProps & {
  host: ClientHostService
  markdown: ClientMarkdownService
  layout: ClientWorkspaceLayoutService
  composer: ClientComposerService
}): ReactNode {
  const markdownState = useSyncExternalStore(markdown.subscribe, markdown.snapshot)
  const activated = useViewerActivated(visible)
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<DocumentState>({ tag: 'idle' })
  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const saveInFlight = useRef(false)
  const [saveProblem, setSaveProblem] = useState<string>()
  const [renderRevision, setRenderRevision] = useState(0)
  const [lineWrap, setLineWrap] = useLineWrapPreference('markdown')
  const editorRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const focusFrame = useRef(0)
  const [editSelection, setEditSelection] = useState<MarkdownSelectionBookmark>()
  const [selectionProblem, setSelectionProblem] = useState('')
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), [])
  const markDirty = useCallback(() => setDirty(true), [])
  const location = parseMarkdownViewerResource(pane.resource)
  const filePath = location?.path
  const CodeBlock = useMemo<ComponentType<MarkdownCodeBlockProps> | undefined>(() => {
    if (!markdownState.codeBlocks.length) return undefined
    const renderers = markdownState.codeBlocks
    return (props) => <CodeBlockDispatcher {...props} renderers={renderers} />
  }, [markdownState.codeBlocks])

  useEffect(() => {
    if (!activated || !filePath || editing) return
    let current = true
    setState({ tag: 'loading' })
    void host.call(MARKDOWN_VIEWER_READ_METHOD, { path: filePath }).then((value) => {
      if (current) setState({ tag: 'ready', document: parsedDocument(value) })
    }).catch((error: unknown) => {
      if (current) setState({ tag: 'failed', problem: error instanceof Error ? error.message : String(error) })
    })
    return () => { current = false }
  }, [activated, filePath, host, reload])

  const document = state.tag === 'ready' ? state.document : undefined

  const startEditing = (selection?: MarkdownSelectionBookmark): void => {
    if (!document) return
    setEditSelection(selection)
    setSelectionProblem('')
    setDirty(false)
    setSaveProblem(undefined)
    setEditing(true)
  }

  const addSelectionToChat = (selection: MarkdownSelection): void => {
    if (!document) return
    const targets = layout.paneTargets()
    const origin = location?.threadId ?? pane.thread?.id
    const target = origin
      ? targets.find(candidate => candidate.session.snapshot().threadId === origin)
      : targets.find(candidate => candidate.workspaceId === workspaceId && candidate.focused)
        ?? targets.find(candidate => candidate.workspaceId === workspaceId)
    if (!target || !composer.appendToSession?.(target.session, markdownSelectionQuote(document.path, selection.text))) {
      setSelectionProblem(origin ? 'Open the source chat to add this passage.' : 'Open a chat in this workspace to add this passage.')
      return
    }
    setSelectionProblem('')
    window.getSelection()?.removeAllRanges()
    layout.focusPane(target.workspaceId, target.paneId)
    cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      if (layout.paneTargets().some(candidate => candidate.paneId === target.paneId && candidate.focused)) composer.focus()
    })
  }

  const saveDocument = async (): Promise<void> => {
    const editor = editorRef.current
    if (!document || !editing || saveInFlight.current || !editor) return
    if (!dirty) {
      setEditing(false)
      return
    }
    saveInFlight.current = true
    setSaving(true)
    setSaveProblem(undefined)
    try {
      const saved = parsedDocument(await host.call(MARKDOWN_VIEWER_WRITE_METHOD, {
        path: document.path,
        source: renderedMarkdownSource(editor),
        modifiedAt: document.modifiedAt,
      }))
      setState({ tag: 'ready', document: saved })
      setDirty(false)
      setEditing(false)
      setRenderRevision((value) => value + 1)
    } catch (error: unknown) {
      setSaveProblem(error instanceof Error ? error.message : String(error))
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  return (
    <section
      ref={paneRef}
      className={`${clientStyles.pane} markdown-viewer-pane${lineWrap ? ' is-line-wrapped' : ''}`}
      onKeyDownCapture={(event) => {
        if (!editing || !(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 's') return
        event.preventDefault()
        void saveDocument()
      }}
    >
      <header className={`${clientStyles.paneHeader} ${paneToolbarStyles.pane} markdown-viewer-toolbar`}>
        <div className={`${paneToolbarStyles.title} markdown-viewer-file`} title={document?.path ?? filePath}>
          <FileText size={15} strokeWidth={1.6} />
          <span>{document?.name ?? filePath?.split('/').at(-1) ?? 'Markdown file'}{dirty ? ' •' : ''}</span>
        </div>
        <div className={`${paneToolbarStyles.actions} markdown-viewer-actions`}>
          <button
            className={clientStyles.iconButton}
            type="button"
            aria-label={lineWrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
            title={lineWrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
            aria-pressed={lineWrap}
            onClick={() => setLineWrap(!lineWrap)}
          >
            <TextWrap size={14} strokeWidth={1.6} />
          </button>
          {editing ? (
            <button className={clientStyles.iconButton} type="button" aria-label="Finish editing Markdown" title="Done (save changes)" disabled={saving} onClick={() => { void saveDocument() }}>
              {saving
                ? <RefreshCw className="markdown-viewer-save-spinner" size={14} strokeWidth={1.6} />
                : <Check size={14} strokeWidth={1.6} />}
            </button>
          ) : (
            <button className={clientStyles.iconButton} type="button" aria-label="Edit Markdown file" title="Edit" disabled={!document} onClick={() => startEditing()}>
              <Pencil size={14} strokeWidth={1.6} />
            </button>
          )}
          <button className={clientStyles.iconButton} type="button" aria-label="Reload Markdown file" title="Reload" disabled={!filePath || editing || saving} onClick={() => setReload((value) => value + 1)}>
            <RefreshCw size={14} strokeWidth={1.6} />
          </button>
          <button className={clientStyles.iconButton} type="button" aria-label="Download Markdown file" title="Download" disabled={!document || editing} onClick={() => document && download(document)}>
            <Download size={14} strokeWidth={1.6} />
          </button>
        </div>
      </header>
      <div className="markdown-viewer-scroll" ref={scrollRef}>
        {!filePath && <div className="markdown-viewer-empty">Open a Markdown file from a chat.</div>}
        {state.tag === 'loading' && <div className="markdown-viewer-loading"><RefreshCw size={16} /> Loading…</div>}
        {state.tag === 'failed' && (
          <div className="markdown-viewer-error" role="alert">
            <span>{state.problem}</span>
            <button type="button" onClick={() => setReload((value) => value + 1)}>Try again</button>
          </div>
        )}
        {document && (
          <RenderedMarkdownEditor
            codeBlock={CodeBlock}
            document={document}
            editing={editing}
            saving={saving}
            editorRef={editorRef}
            key={`${document.path}:${renderRevision}`}
            markdownState={markdownState}
            onDirty={markDirty}
            editSelection={editSelection}
          />
        )}
        {saveProblem && <div className="markdown-viewer-save-error" role="alert">{saveProblem}</div>}
        {selectionProblem && <div className="markdown-viewer-save-error" role="alert">{selectionProblem}</div>}
      </div>
      <MarkdownSelectionMenu key={filePath} rootRef={editorRef} paneRef={paneRef} scrollRef={scrollRef}
        enabled={visible && !!document && !editing} onAdd={addSelectionToChat}
        onEdit={selection => startEditing(selection.bookmark)} />
    </section>
  )
}

function openMarkdownBesideOrigin(
  layout: ClientWorkspaceLayoutService,
  path: string,
  origin: HTMLElement,
): void {
  const paneId = origin.closest<HTMLElement>('[data-workspace-pane-id]')?.dataset.workspacePaneId
  const target = paneId ? layout.paneTargets().find((candidate) => candidate.paneId === paneId) : undefined
  const session = target?.session.snapshot()
  layout.openPane({
    direction: 'horizontal',
    kind: 'markdown-viewer',
    resource: markdownViewerResource(path, session?.threadId),
    ...(session?.threadId ? { anchorThreadId: session.threadId } : {}),
    ...(session?.session.workspace ? { workspace: session.session.workspace } : {}),
    ...(session?.activeProjectId ? { projectId: session.activeProjectId } : {}),
  })
}

const markdownViewerClient: BrowserPlugin = (ctx) => {
  ctx.clientMarkdown.registerFileLink(ctx, {
    id: 'markdown-viewer',
    extensions: ['.md', '.markdown', '.mdown', '.mkd'],
    priority: 100,
    open: (details, origin) => openMarkdownBesideOrigin(ctx.clientWorkspaceLayout, details.path, origin),
  })
  ctx.clientWorkspaceLayout.registerPaneKind(ctx, {
    id: 'markdown-viewer',
    label: 'Markdown',
    description: 'Rendered Markdown files with editing and download controls',
    shortcut: 'm',
    icon: FileText,
    renderer: (props) => (
      <MarkdownViewerPane
        {...props}
        host={ctx.clientHost}
        markdown={ctx.clientMarkdown}
        layout={ctx.clientWorkspaceLayout}
        composer={ctx.clientComposer}
      />
    ),
  })
  ctx.clientUi.registerStyle(ctx, 'markdown-viewer', String(styles))
}

markdownViewerClient.inject = [
  'clientHost',
  'clientComposer',
  'clientMarkdown',
  'clientUi',
  'clientWorkspaceLayout',
]

export default markdownViewerClient
