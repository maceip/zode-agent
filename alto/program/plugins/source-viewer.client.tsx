import { paneToolbarStyles } from './pane-toolbar.js'
import {
  FileCode2,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Send,
  TextWrap,
  Trash2,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type {
  CodeViewFileItem,
  CodeViewLineSelection,
  LineAnnotation,
} from '@pierre/diffs'
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from '@pierre/diffs/react'
import {
  clientStyles,
  type BrowserPlugin,
  type ClientDraft,
  type ClientHostService,
  type ClientUiService,
} from '../../src/client/plugin-api.js'
import type { JsonValue } from '../../src/shared/protocol.js'
import type { ClientCodeExplorerService } from './code-explorer-api.js'
import type { MarkdownFileLinkDetails } from './markdown-api.js'
import {
  parseSourceDocument,
  parseSourceViewerResource,
  SOURCE_VIEWER_PANE_KIND,
  SOURCE_VIEWER_READ_METHOD,
  sourceViewerResource,
  type SourceDocument,
  type SourceLocation,
} from './source-viewer-api.js'
import {
  clampVimCursor,
  moveVimCursor,
  type VimCursor,
  type VimMotion,
} from './source-vim.js'
import type {
  ClientWorkspaceLayoutService,
  WorkspacePaneKindProps,
  WorkspacePaneTarget,
} from './workspace-layout-api.js'
import { useThemeAppearance } from './theme-runtime.js'
import { useLineWrapPreference } from './viewer-preferences.js'
import {
  ALTO_SHARED_CODE_THEMES,
  ensureAltoSharedCodeTheme,
} from './shared-code-theme.js'
import { useViewerActivated } from './viewer-activation.js'
import { sourcePath } from './source-paths.js'
import styles from './source-viewer.css'

ensureAltoSharedCodeTheme()

const PIERRE_SOURCE_STYLES = `
  [data-line][data-alto-vim-cursor]::before {
    content: "";
    position: absolute;
    z-index: 4;
    top: 2px;
    bottom: 2px;
    left: calc(1ch + (var(--alto-vim-column, 0) * 1ch));
    width: .78ch;
    border: 1px solid color-mix(in srgb, var(--diffs-modified-base) 72%, transparent);
    border-radius: 1.5px;
    background: color-mix(in srgb, var(--diffs-modified-base) 24%, transparent);
    pointer-events: none;
  }
  @media (prefers-reduced-motion: no-preference) {
    [data-line][data-alto-vim-cursor]::before {
      animation: alto-vim-cursor-blink 1.1s step-end infinite;
    }
  }
  @keyframes alto-vim-cursor-blink {
    0%, 48% { opacity: 1; }
    49%, 100% { opacity: .28; }
  }
  .source-review-comment {
    margin: 7px 12px 9px;
    padding: 9px 11px 10px;
    border: 1px solid color-mix(in srgb, var(--diffs-modified-base) 22%, var(--diffs-bg-context));
    border-radius: 10px;
    color: var(--diffs-fg);
    background: color-mix(in srgb, var(--diffs-modified-base) 4%, var(--diffs-bg));
    font-family: var(--diffs-header-font-family);
    font-size: 12px;
    line-height: 1.45;
  }
  .source-review-comment > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--diffs-fg-number);
    font-size: 10.5px;
  }
  .source-review-comment button {
    display: grid;
    width: 22px;
    height: 22px;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    color: var(--diffs-fg-number);
    background: transparent;
  }
  .source-review-comment button:hover {
    color: var(--diffs-fg);
    background: var(--diffs-bg-context);
  }
  .source-review-comment p { margin: 3px 0 0; white-space: pre-wrap; }
`

interface SourceComment {
  id: string
  path: string
  revision: string
  start: number
  end: number
  body: string
  createdAt: string
}

interface CommentDraft {
  start: number
  end: number
  body: string
}

type ViewerState =
  | { tag: 'idle' | 'loading' }
  | { tag: 'ready'; document: SourceDocument }
  | { tag: 'failed'; problem: string }

type CommandMode = 'find' | 'line'

function initialCursor(location: SourceLocation | undefined): VimCursor {
  return {
    line: location?.line ?? 1,
    column: Math.max(0, (location?.column ?? 1) - 1),
  }
}


function commentsKey(filePath: string): string {
  return `alto.source-review-comments.v1:${filePath}`
}

function parsedComments(value: unknown): SourceComment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((comment) => {
    if (
      !comment || typeof comment !== 'object'
      || !('id' in comment) || typeof comment.id !== 'string'
      || !('path' in comment) || typeof comment.path !== 'string'
      || !('revision' in comment) || typeof comment.revision !== 'string'
      || !('start' in comment) || typeof comment.start !== 'number'
      || !('end' in comment) || typeof comment.end !== 'number'
      || !('body' in comment) || typeof comment.body !== 'string'
      || !('createdAt' in comment) || typeof comment.createdAt !== 'string'
    ) return []
    return [{
      id: comment.id,
      path: comment.path,
      revision: comment.revision,
      start: comment.start,
      end: comment.end,
      body: comment.body,
      createdAt: comment.createdAt,
    }]
  })
}

function loadComments(filePath: string): SourceComment[] {
  try {
    return parsedComments(JSON.parse(localStorage.getItem(commentsKey(filePath)) ?? '[]'))
  } catch {
    return []
  }
}

function saveComments(filePath: string, comments: readonly SourceComment[]): void {
  try {
    localStorage.setItem(commentsKey(filePath), JSON.stringify(comments))
  } catch {
    // Source review remains usable for this session when storage is unavailable.
  }
}

function rangeLabel(start: number, end: number): string {
  return start === end ? `Line ${start}` : `Lines ${start}–${end}`
}

function sourceReviewPrompt(comments: readonly SourceComment[]): string {
  const details = comments.map((comment) => (
    `- \`${comment.path}:${comment.start}${comment.end === comment.start ? '' : `-${comment.end}`}\`\n  ${comment.body}`
  )).join('\n\n')
  return `Please address these source review comments:\n\n${details}`
}

function targetChat(
  layout: ClientWorkspaceLayoutService,
  threadId: string | undefined,
  workspaceId: string,
): WorkspacePaneTarget | undefined {
  const targets = layout.paneTargets()
  return (threadId ? targets.find((target) => target.session.snapshot().threadId === threadId) : undefined)
    ?? targets.find((target) => target.workspaceId === workspaceId && target.focused)
    ?? targets.find((target) => target.workspaceId === workspaceId)
}

function submitTarget(target: WorkspacePaneTarget) {
  const state = target.session.snapshot()
  return {
    id: `${target.workspaceId}:${target.paneId}`,
    ...(state.threadId ? { threadId: state.threadId } : {}),
    activeTurn: state.turn.tag !== 'idle',
    send: (draft: ClientDraft) => target.session.send(draft),
    steer: (draft: ClientDraft) => target.session.steer(draft),
  }
}

function SourceAnnotation({
  comment,
  remove,
}: {
  comment: SourceComment
  remove(id: string): void
}): ReactNode {
  return (
    <article className="source-review-comment">
      <div>
        <span>{rangeLabel(comment.start, comment.end)}</span>
        <button type="button" title="Remove" aria-label="Remove source comment" onClick={() => remove(comment.id)}>
          <Trash2 size={13} strokeWidth={1.7} />
        </button>
      </div>
      <p>{comment.body}</p>
    </article>
  )
}

function SourceCommentComposer({
  draft,
  change,
  cancel,
  add,
}: {
  draft: CommentDraft
  change(body: string): void
  cancel(): void
  add(): void
}): ReactNode {
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => input.current?.focus({ preventScroll: true }), [draft.start, draft.end])
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      add()
    }
  }
  return (
    <section className="source-review-draft">
      <div className="source-review-draft-heading">
        <span>{rangeLabel(draft.start, draft.end)}</span>
        <button type="button" aria-label="Cancel comment" onClick={cancel}><X size={13} /></button>
      </div>
      <textarea
        ref={input}
        rows={3}
        value={draft.body}
        placeholder="Ask Alto about these lines…"
        onChange={(event) => change(event.target.value)}
        onKeyDown={keyDown}
      />
      <div className="source-review-draft-actions">
        <button type="button" onClick={cancel}>Cancel</button>
        <button className="primary" type="button" disabled={!draft.body.trim()} onClick={add}>Add comment</button>
      </div>
    </section>
  )
}

function SourceViewerPane({
  workspaceId,
  pane,
  focused,
  visible,
  host,
  layout,
  ui,
  explorers,
}: WorkspacePaneKindProps & {
  host: ClientHostService
  layout: ClientWorkspaceLayoutService
  ui: ClientUiService
  explorers: ClientCodeExplorerService
}): ReactNode {
  const initial = parseSourceViewerResource(pane.resource)
  const [location, setLocation] = useState<SourceLocation | undefined>(initial)
  const activated = useViewerActivated(visible)
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<ViewerState>({ tag: 'idle' })
  const [lineWrap, setLineWrap] = useLineWrapPreference('source')
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null)
  const [cursor, setCursor] = useState<VimCursor>(() => initialCursor(initial))
  const [comments, setComments] = useState<SourceComment[]>([])
  const [commentVersion, setCommentVersion] = useState(0)
  const [draft, setDraft] = useState<CommentDraft>()
  const [command, setCommand] = useState<CommandMode>()
  const [commandValue, setCommandValue] = useState('')
  const [search, setSearch] = useState('')
  const [sendProblem, setSendProblem] = useState<string>()
  const [sending, setSending] = useState(false)
  const [pendingG, setPendingG] = useState(false)
  const [activeTreePath, setActiveTreePath] = useState(initial?.path)
  const viewer = useRef<CodeViewHandle<SourceComment>>(null)
  const paneRoot = useRef<HTMLElement>(null)
  const cursorRef = useRef(cursor)
  const countRef = useRef('')
  const commandInput = useRef<HTMLInputElement>(null)
  const gTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const explorerState = useSyncExternalStore(explorers.subscribe, explorers.snapshot)
  const theme = useThemeAppearance()

  useEffect(() => {
    const next = parseSourceViewerResource(pane.resource)
    if (!next) return
    setLocation(next)
    setActiveTreePath(next.path)
  }, [pane.resource])

  useEffect(() => {
    if (!activated || !location?.path) return
    let current = true
    setState({ tag: 'loading' })
    const payload: JsonValue = { path: location.path }
    void host.call(SOURCE_VIEWER_READ_METHOD, payload).then((value) => {
      if (!current) return
      const document = parseSourceDocument(value)
      setComments(loadComments(document.path))
      setCommentVersion((version) => version + 1)
      setSelection(null)
      setDraft(undefined)
      setCursor(clampVimCursor(document.source, initialCursor(location)))
      setState({ tag: 'ready', document })
    }).catch((error: unknown) => {
      if (current) setState({ tag: 'failed', problem: error instanceof Error ? error.message : String(error) })
    })
    return () => { current = false }
  }, [activated, host, location?.path, reload])

  const document = state.tag === 'ready' ? state.document : undefined
  const currentComments = useMemo(() => comments.filter((comment) => (
    comment.revision === document?.revision
  )), [comments, document?.revision])
  const staleComments = comments.length - currentComments.length
  const item = useMemo<CodeViewFileItem<SourceComment> | undefined>(() => {
    if (!document) return undefined
    const annotations: LineAnnotation<SourceComment>[] = currentComments.map((comment) => ({
      lineNumber: comment.end,
      metadata: comment,
    }))
    return {
      id: document.revision,
      type: 'file',
      file: {
        name: document.name,
        contents: document.source,
        cacheKey: document.revision,
      },
      annotations,
      version: commentVersion,
    }
  }, [commentVersion, currentComments, document])

  const clampLine = (line: number): number => Math.max(1, Math.min(document?.lineCount ?? 1, line))
  const reveal = (
    requested: number | VimCursor,
    behavior: 'instant' | 'smooth' = 'instant',
  ): void => {
    if (!item) return
    const next = document
      ? clampVimCursor(document.source, typeof requested === 'number'
        ? { line: requested, column: cursorRef.current.column }
        : requested)
      : typeof requested === 'number'
        ? { line: clampLine(requested), column: 0 }
        : requested
    setCursor(next)
    const selected = { id: item.id, range: { start: next.line, end: next.line } }
    setSelection(selected)
    viewer.current?.scrollTo({ type: 'line', id: item.id, lineNumber: next.line, align: 'center', behavior })
  }

  useEffect(() => {
    if (!item) return
    const start = clampLine(location?.line ?? 1)
    const end = clampLine(location?.endLine ?? start)
    const selected = { id: item.id, range: { start, end } }
    setSelection(selected)
    setCursor(document
      ? clampVimCursor(document.source, {
        line: start,
        column: Math.max(0, (location?.column ?? 1) - 1),
      })
      : { line: start, column: 0 })
    const frame = requestAnimationFrame(() => {
      viewer.current?.scrollTo({ type: 'line', id: item.id, lineNumber: start, align: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [item?.id])

  useEffect(() => {
    if (command) commandInput.current?.focus({ preventScroll: true })
  }, [command])

  cursorRef.current = cursor

  const syncVimCursor = (): void => {
    const instance = viewer.current?.getInstance()
    if (!instance) return
    for (const rendered of instance.getRenderedItems()) {
      const root = rendered.element.shadowRoot
      if (!root) continue
      for (const previous of root.querySelectorAll<HTMLElement>('[data-alto-vim-cursor]')) {
        previous.removeAttribute('data-alto-vim-cursor')
        previous.style.removeProperty('--alto-vim-column')
      }
      if (!focused || rendered.id !== item?.id) continue
      const line = root.querySelector<HTMLElement>(`[data-line="${cursorRef.current.line}"]`)
      if (!line) continue
      line.dataset.altoVimCursor = ''
      line.style.setProperty('--alto-vim-column', String(cursorRef.current.column))
    }
  }
  const syncVimCursorRef = useRef(syncVimCursor)
  syncVimCursorRef.current = syncVimCursor

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => syncVimCursorRef.current())
    const retry = window.setTimeout(() => syncVimCursorRef.current(), 60)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(retry)
    }
  }, [cursor, focused, item?.id, visible])

  useEffect(() => {
    if (!focused || !visible) return
    const active = window.document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLButtonElement || active?.getAttribute('contenteditable') === 'true') return
    paneRoot.current?.focus({ preventScroll: true })
  }, [focused, visible])

  useEffect(() => () => { if (gTimer.current) clearTimeout(gTimer.current) }, [])

  const find = (query: string, direction: 1 | -1): void => {
    if (!document || !query) return
    const lines = document.source.split('\n')
    for (let offset = 1; offset <= lines.length; offset += 1) {
      const index = (cursor.line - 1 + direction * offset + lines.length) % lines.length
      const column = lines[index]?.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) ?? -1
      if (column >= 0) {
        reveal({ line: index + 1, column }, 'smooth')
        return
      }
    }
  }

  const finishCommand = (): void => {
    if (command === 'line') {
      const line = Number(commandValue)
      if (Number.isSafeInteger(line) && line > 0) reveal(line, 'smooth')
    } else if (command === 'find' && commandValue.trim()) {
      const query = commandValue.trim()
      setSearch(query)
      find(query, 1)
    }
    setCommand(undefined)
    setCommandValue('')
    requestAnimationFrame(() => paneRoot.current?.focus({ preventScroll: true }))
  }

  const keyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!focused || command || event.metaKey || event.altKey) return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, button, [contenteditable="true"]')) return
    if (/^[1-9]$/u.test(event.key) || (event.key === '0' && countRef.current)) {
      event.preventDefault()
      countRef.current += event.key
      return
    }
    const takeCount = (): number => {
      const count = Number(countRef.current) || 1
      countRef.current = ''
      return count
    }
    const motionByKey: Partial<Record<string, VimMotion>> = {
      h: 'left',
      j: 'down',
      k: 'up',
      l: 'right',
      w: 'word-forward',
      b: 'word-backward',
      e: 'word-end',
      '0': 'line-start',
      '$': 'line-end',
    }
    const motion = motionByKey[event.key]
    if (motion && document) {
      event.preventDefault()
      reveal(moveVimCursor(document.source, cursor, motion, takeCount()))
    } else if (event.ctrlKey && (event.key === 'd' || event.key === 'u')) {
      event.preventDefault()
      reveal(cursor.line + (event.key === 'd' ? 15 : -15) * takeCount(), 'smooth')
    } else if (event.key === 'G') {
      event.preventDefault()
      const requested = countRef.current ? takeCount() : document?.lineCount ?? 1
      reveal({ line: requested, column: 0 }, 'smooth')
    } else if (event.key === 'g') {
      event.preventDefault()
      if (pendingG) {
        setPendingG(false)
        if (gTimer.current) clearTimeout(gTimer.current)
        reveal({ line: countRef.current ? takeCount() : 1, column: 0 }, 'smooth')
      } else {
        setPendingG(true)
        gTimer.current = setTimeout(() => setPendingG(false), 700)
      }
    } else if (event.key === '/') {
      event.preventDefault()
      setCommand('find')
      setCommandValue('')
    } else if (event.key === ':') {
      event.preventDefault()
      setCommand('line')
      setCommandValue('')
    } else if ((event.key === 'n' || event.key === 'N') && search) {
      event.preventDefault()
      find(search, event.key === 'n' ? 1 : -1)
    } else if (event.key === 'c' && selection) {
      event.preventDefault()
      setDraft({
        start: Math.min(selection.range.start, selection.range.end),
        end: Math.max(selection.range.start, selection.range.end),
        body: '',
      })
    } else if (event.key === 'Escape') {
      event.preventDefault()
      countRef.current = ''
      setPendingG(false)
      reveal(cursor)
    } else {
      countRef.current = ''
      setPendingG(false)
    }
  }

  const options = useMemo<CodeViewReactOptions<SourceComment>>(() => ({
    overflow: lineWrap ? 'wrap' : 'scroll',
    theme: ALTO_SHARED_CODE_THEMES,
    themeType: theme.mode,
    unsafeCSS: PIERRE_SOURCE_STYLES,
    stickyHeaders: true,
    lineHoverHighlight: 'both',
    enableLineSelection: true,
    enableGutterUtility: true,
    onPostRender: () => requestAnimationFrame(() => syncVimCursorRef.current()),
  }), [lineWrap, theme.mode])

  const updateComments = (next: SourceComment[]): void => {
    if (!document) return
    setComments(next)
    setCommentVersion((version) => version + 1)
    saveComments(document.path, next)
  }

  const addComment = (): void => {
    if (!draft?.body.trim() || !document) return
    updateComments([...comments, {
      id: crypto.randomUUID(),
      path: document.path,
      revision: document.revision,
      start: draft.start,
      end: draft.end,
      body: draft.body.trim(),
      createdAt: new Date().toISOString(),
    }])
    setDraft(undefined)
  }

  const removeComment = (id: string): void => updateComments(comments.filter((comment) => comment.id !== id))

  const send = async (): Promise<void> => {
    if (!document || currentComments.length === 0) return
    const target = targetChat(layout, pane.thread?.id, workspaceId)
    if (!target) {
      setSendProblem('Open a chat in this workspace to send the review.')
      return
    }
    const message: ClientDraft = {
      text: sourceReviewPrompt(currentComments),
      images: [], attachments: [], skills: [],
    }
    setSending(true)
    setSendProblem(undefined)
    try {
      await ui.submit(message, () => target.session.send(message), {
        mode: 'queue',
        target: submitTarget(target),
      })
      layout.focusPane(target.workspaceId, target.paneId)
    } catch (error) {
      setSendProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  const navigate = (filePath: string): void => {
    setLocation({ path: filePath })
    setActiveTreePath(filePath)
  }

  const Explorer = explorerState.explorer?.component
  return (
    <section
      ref={paneRoot}
      className={`${clientStyles.pane} source-viewer-pane`}
      tabIndex={0}
      aria-label="Read-only source viewer in Vim normal mode"
      onKeyDown={keyDown}
      onPointerUp={(event) => {
        const target = event.target as HTMLElement
        if (!target.closest('input, textarea, button, [contenteditable="true"]')) {
          requestAnimationFrame(() => paneRoot.current?.focus({ preventScroll: true }))
        }
      }}
    >
      <header className={`${clientStyles.paneHeader} ${paneToolbarStyles.pane} source-viewer-toolbar`}>
        <div className={`${paneToolbarStyles.title} source-viewer-file`} title={document?.path ?? location?.path}>
          <FileCode2 size={15} strokeWidth={1.6} />
          <span>{document?.name ?? location?.path?.split('/').at(-1) ?? 'Source'}</span>
          {document && <small>:{cursor.line},{cursor.column + 1}</small>}
        </div>
        <div className={`${paneToolbarStyles.actions} source-viewer-actions`}>
          <button
            className={clientStyles.iconButton}
            type="button"
            title={lineWrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
            aria-label={lineWrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
            aria-pressed={lineWrap}
            onClick={() => setLineWrap(!lineWrap)}
          ><TextWrap size={14} strokeWidth={1.6} /></button>
          <button
            className={clientStyles.iconButton}
            type="button"
            title="Comment on selected lines (c)"
            aria-label="Comment on selected lines"
            disabled={!selection}
            onClick={() => selection && setDraft({
              start: Math.min(selection.range.start, selection.range.end),
              end: Math.max(selection.range.start, selection.range.end),
              body: '',
            })}
          ><MessageSquarePlus size={14} strokeWidth={1.6} /></button>
          <button className={clientStyles.iconButton} type="button" title="Reload" aria-label="Reload source file" onClick={() => setReload((value) => value + 1)}>
            <RefreshCw size={14} strokeWidth={1.6} />
          </button>
        </div>
      </header>
      <div className="source-viewer-body">
        {Explorer && pane.workspace && (
          <Explorer
            workspace={pane.workspace}
            {...(activeTreePath ? { activePath: activeTreePath } : {})}
            label="Workspace files"
            select={navigate}
          />
        )}
        <div className="source-viewer-code-shell">
          {state.tag === 'loading' && <div className="source-viewer-state"><RefreshCw className="is-spinning" size={16} /> Loading source…</div>}
          {state.tag === 'failed' && <div className="source-viewer-state is-error" role="alert">{state.problem}</div>}
          {!location && <div className="source-viewer-state">Open a source file from chat or the file tree.</div>}
          {item && (
            <CodeView<SourceComment>
              ref={viewer}
              className="source-viewer-code"
              items={[item]}
              options={options}
              selectedLines={selection}
              onSelectedLinesChange={(next) => {
                setSelection(next)
                if (next) {
                  const line = Math.min(next.range.start, next.range.end)
                  setCursor((current) => current.line === line ? current : { line, column: 0 })
                }
              }}
              renderAnnotation={(annotation) => annotation.metadata
                ? <SourceAnnotation comment={annotation.metadata} remove={removeComment} />
                : null}
            />
          )}
        </div>
      </div>
      {command && (
        <form className="source-viewer-command" onSubmit={(event) => { event.preventDefault(); finishCommand() }}>
          {command === 'find' ? <Search size={13} /> : <span>:</span>}
          <input
            ref={commandInput}
            value={commandValue}
            inputMode={command === 'line' ? 'numeric' : 'search'}
            placeholder={command === 'find' ? 'Find in file' : 'Go to line'}
            aria-label={command === 'find' ? 'Find in file' : 'Go to line'}
            onChange={(event) => setCommandValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setCommand(undefined)
                setCommandValue('')
                requestAnimationFrame(() => paneRoot.current?.focus({ preventScroll: true }))
              }
            }}
          />
        </form>
      )}
      {draft && <SourceCommentComposer draft={draft} change={(body) => setDraft({ ...draft, body })} cancel={() => setDraft(undefined)} add={addComment} />}
      {(currentComments.length > 0 || staleComments > 0) && (
        <footer className="source-viewer-footer">
          <div>
            <MessageSquarePlus size={14} strokeWidth={1.7} />
            <span>{currentComments.length} comment{currentComments.length === 1 ? '' : 's'}</span>
            {staleComments > 0 && <span>{staleComments} from an older revision</span>}
            {sendProblem && <span className="source-viewer-send-error">{sendProblem}</span>}
          </div>
          <button type="button" disabled={sending || currentComments.length === 0} onClick={() => void send()}>
            <Send size={13} strokeWidth={1.8} />
            <span>{sending ? 'Sending…' : 'Ask Alto'}</span>
          </button>
        </footer>
      )}
    </section>
  )
}

function openSourceBesideOrigin(
  layout: ClientWorkspaceLayoutService,
  details: MarkdownFileLinkDetails,
  origin: HTMLElement,
): void {
  const paneId = origin.closest<HTMLElement>('[data-workspace-pane-id]')?.dataset.workspacePaneId
  const target = paneId ? layout.paneTargets().find((candidate) => candidate.paneId === paneId) : undefined
  const session = target?.session.snapshot()
  layout.openPane({
    direction: 'horizontal',
    kind: SOURCE_VIEWER_PANE_KIND,
    resource: sourceViewerResource(details),
    ...(session?.threadId ? { anchorThreadId: session.threadId } : {}),
    ...(session?.session.workspace ? { workspace: session.session.workspace } : {}),
    ...(session?.activeProjectId ? { projectId: session.activeProjectId } : {}),
  })
}

const sourceViewerClient: BrowserPlugin = (ctx) => {
  ctx.clientMarkdown.registerFileLink(ctx, {
    id: SOURCE_VIEWER_PANE_KIND,
    matches: sourcePath,
    priority: 20,
    open: (details, origin) => openSourceBesideOrigin(ctx.clientWorkspaceLayout, details, origin),
  })
  ctx.clientWorkspaceLayout.registerPaneKind(ctx, {
    id: SOURCE_VIEWER_PANE_KIND,
    label: 'Source',
    description: 'Read source files with Vim navigation and line comments',
    shortcut: 's',
    icon: FileCode2,
    renderer: (props) => <SourceViewerPane
      {...props}
      host={ctx.clientHost}
      layout={ctx.clientWorkspaceLayout}
      ui={ctx.clientUi}
      explorers={ctx.clientCodeExplorer}
    />,
  })
  ctx.clientUi.registerStyle(ctx, SOURCE_VIEWER_PANE_KIND, String(styles))
}

sourceViewerClient.inject = [
  'clientCodeExplorer',
  'clientHost',
  'clientMarkdown',
  'clientUi',
  'clientWorkspaceLayout',
]

export default sourceViewerClient
