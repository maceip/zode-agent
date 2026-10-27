import { paneToolbarStyles } from './pane-toolbar.js'
import {
  ChevronDown,
  FileDiff,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Send,
  TextWrap,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  parsePatchFiles,
  type CodeViewLineSelection,
  type CodeViewItem,
} from '@pierre/diffs'
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from '@pierre/diffs/react'
import {
  clientStyles,
  type BrowserPlugin,
  type ClientHostService,
  type ClientUiService,
} from '../../src/client/plugin-api.js'
import type { JsonValue } from '../../src/shared/protocol.js'
import type { ClientCodeExplorerService } from './code-explorer-api.js'
import {
  FILE_REVIEW_ACTION_COMPONENT,
  type FileReviewActionProps,
} from './chat-surfaces-api.js'
import {
  commitRefFromDiffResource,
  DIFF_VIEWER_COMMITS_METHOD,
  DIFF_VIEWER_CREATE_METHOD,
  DIFF_VIEWER_PANE_KIND,
  DIFF_VIEWER_READ_METHOD,
  parseDiffCommitSummaries,
  parseDiffReviewDocument,
  parseDiffReviewReference,
  type DiffCommitSummary,
  type DiffReviewDocument,
} from './diff-viewer-api.js'
import {
  ReviewAnnotation,
  ReviewCommentComposer,
  loadReviewComments,
  normalizedReviewRange,
  reviewAnnotations,
  saveReviewComments,
  sendReviewComments,
  type ReviewComment,
  type ReviewCommentDraft,
} from './diff-review-comments.js'
export { reviewPrompt, type ReviewComment } from './diff-review-comments.js'
import type { ClientSessionService } from './session-api.js'
import type {
  ClientWorkspaceLayoutService,
  WorkspacePaneKindProps,
} from './workspace-layout-api.js'
import type { WorkspacePaneNode } from './workspace-layout-state.js'
import { useThemeAppearance } from './theme-runtime.js'
import { ConversationPaneOverlay } from './ui/conversation-overlay.js'
import { useLineWrapPreference } from './viewer-preferences.js'
import {
  ALTO_SHARED_CODE_THEMES,
  ensureAltoSharedCodeTheme,
} from './shared-code-theme.js'
import { useViewerActivated } from './viewer-activation.js'
import styles from './diff-viewer.css'

type DiffStyle = 'unified' | 'split'

ensureAltoSharedCodeTheme()
const DIFF_REVIEW_OVERLAY_ID = 'diff-review'

export interface DiffReviewOverlayRequest {
  activityId: string
  reviewId: string
  resource: string
  workspace: string
  workspaceId: string
  anchorPaneId?: string
  threadId?: string
  projectId?: string
}

export interface DiffReviewOverlayController {
  open(request: DiffReviewOverlayRequest): void
}

class DiffReviewOverlayStore implements DiffReviewOverlayController {
  private readonly listeners = new Set<() => void>()
  private current: DiffReviewOverlayRequest | undefined

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): DiffReviewOverlayRequest | undefined => this.current

  open(request: DiffReviewOverlayRequest): void {
    this.current = request
    this.emit()
  }

  close(expected?: DiffReviewOverlayRequest): void {
    if (expected && this.current !== expected) return
    if (!this.current) return
    this.current = undefined
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

const diffReviewOverlay = new DiffReviewOverlayStore()

export const PIERRE_REVIEW_STYLES = `
  [data-diffs-header][data-sticky] {
    background-color: color-mix(in srgb, var(--diffs-bg) 88%, transparent);
    -webkit-backdrop-filter: blur(14px) saturate(108%);
    backdrop-filter: blur(14px) saturate(108%);
  }
  .diff-review-comment {
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
  .diff-review-comment > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--diffs-fg-number);
    font-size: 10.5px;
  }
  .diff-review-comment button {
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
  .diff-review-comment button:hover {
    color: var(--diffs-fg);
    background: var(--diffs-bg-context);
  }
  .diff-review-comment p {
    margin: 3px 0 0;
    white-space: pre-wrap;
  }
`


type ViewerState =
  | { tag: 'idle' | 'loading' }
  | { tag: 'ready'; document: DiffReviewDocument }
  | { tag: 'failed'; problem: string }

export function diffReviewItems(
  document: DiffReviewDocument,
  comments: readonly ReviewComment[],
  version = 0,
): CodeViewItem<ReviewComment>[] {
  return parsePatchFiles(document.patch, document.id, true).flatMap((patch, patchIndex) => (
    patch.files.map((fileDiff, fileIndex) => ({
      id: `${document.id}:${patchIndex}:${fileIndex}`,
      type: 'diff' as const,
      fileDiff,
      annotations: reviewAnnotations(comments, fileDiff.name),
      version,
    }))
  ))
}

function DiffViewerPane({
  workspaceId,
  pane,
  visible,
  host,
  layout,
  ui,
  explorers,
  presentation = 'pane',
  onDraftChange,
  onClose,
}: WorkspacePaneKindProps & {
  host: ClientHostService
  layout: ClientWorkspaceLayoutService
  ui: ClientUiService
  explorers: ClientCodeExplorerService
  presentation?: 'pane' | 'overlay'
  onDraftChange?: (active: boolean) => void
  onClose?: () => void
}): ReactNode {
  const resourceCommit = commitRefFromDiffResource(pane.resource)
  const [commitRef, setCommitRef] = useState<string | undefined>(resourceCommit)
  const [recentCommitChoices, setRecentCommitChoices] = useState<DiffCommitSummary[]>([])
  const [commitsLoading, setCommitsLoading] = useState(false)
  const activated = useViewerActivated(visible)
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<ViewerState>({ tag: 'idle' })
  const [style, setStyle] = useState<DiffStyle>('unified')
  const [lineWrap, setLineWrap] = useLineWrapPreference('diff')
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null)
  const [draft, setDraft] = useState<ReviewCommentDraft>()
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [commentVersion, setCommentVersion] = useState(0)
  const [sendProblem, setSendProblem] = useState<string>()
  const [sending, setSending] = useState(false)
  const [activeTreePath, setActiveTreePath] = useState<string>()
  const [filesVisible, setFilesVisible] = useState(true)
  const viewer = useRef<CodeViewHandle<ReviewComment>>(null)
  const explorerState = useSyncExternalStore(explorers.subscribe, explorers.snapshot)
  const theme = useThemeAppearance()
  const hasDraft = draft !== undefined

  useEffect(() => {
    onDraftChange?.(hasDraft)
  }, [hasDraft, onDraftChange])

  useEffect(() => () => onDraftChange?.(false), [onDraftChange])

  useEffect(() => {
    setCommitRef(commitRefFromDiffResource(pane.resource))
  }, [pane.resource, pane.workspace])

  useEffect(() => {
    if (!activated) return
    let current = true
    setCommitsLoading(true)
    void host.call(DIFF_VIEWER_COMMITS_METHOD, { workspace: pane.workspace }).then((value) => {
      if (current) setRecentCommitChoices(parseDiffCommitSummaries(value))
    }).catch(() => {
      if (current) setRecentCommitChoices([])
    }).finally(() => {
      if (current) setCommitsLoading(false)
    })
    return () => { current = false }
  }, [activated, host, pane.workspace, reload])

  useEffect(() => {
    if (!activated) return
    let current = true
    setState({ tag: 'loading' })
    setActiveTreePath(undefined)
    const payload: JsonValue = commitRef !== undefined
      ? {
          workspace: pane.workspace,
          commit: commitRef,
          ...(pane.thread?.id ? { threadId: pane.thread.id } : {}),
        }
      : pane.resource
        ? { resource: pane.resource, workspace: pane.workspace }
        : {
            workspace: pane.workspace,
            ...(pane.thread?.id ? { threadId: pane.thread.id } : {}),
          }
    void host.call(DIFF_VIEWER_READ_METHOD, payload).then((value) => {
      if (!current) return
      const document = parseDiffReviewDocument(value)
      setComments(loadReviewComments(document.id))
      setCommentVersion((version) => version + 1)
      setSelection(null)
      setDraft(undefined)
      setState({ tag: 'ready', document })
    }).catch((error: unknown) => {
      if (current) setState({ tag: 'failed', problem: error instanceof Error ? error.message : String(error) })
    })
    return () => { current = false }
  }, [activated, commitRef, host, pane.resource, pane.thread?.id, pane.workspace, reload])

  const document = state.tag === 'ready' ? state.document : undefined
  const items = useMemo(() => {
    if (!document?.patch.trim()) return []
    try {
      return diffReviewItems(document, comments, commentVersion)
    } catch {
      return []
    }
  }, [commentVersion, comments, document])

  const openDraft = (next: CodeViewLineSelection): void => {
    const item = items.find((candidate) => candidate.id === next.id)
    if (!item || item.type !== 'diff') return
    setSelection(next)
    setDraft({ selection: next, path: item.fileDiff.name, body: '' })
  }

  const options = useMemo<CodeViewReactOptions<ReviewComment>>(() => ({
    diffStyle: style,
    diffIndicators: 'bars',
    layout: { paddingTop: 0, paddingBottom: 0, gap: 1 },
    overflow: lineWrap ? 'wrap' : 'scroll',
    theme: ALTO_SHARED_CODE_THEMES,
    unsafeCSS: PIERRE_REVIEW_STYLES,
    hunkSeparators: 'line-info',
    themeType: theme.mode,
    stickyHeaders: true,
    lineHoverHighlight: 'both',
    enableLineSelection: true,
    enableGutterUtility: true,
    onGutterUtilityClick: (range, context) => openDraft({ id: context.item.id, range }),
  }), [items, lineWrap, style, theme.mode])

  const diffPaths = useMemo(() => items.flatMap((item) => (
    item.type === 'diff' ? [item.fileDiff.name] : []
  )), [items])

  useEffect(() => {
    const first = diffPaths[0]
    if (!document || !first) return
    setActiveTreePath((current) => current ?? `${document.workspace.replace(/[\\/]$/u, '')}/${first}`)
  }, [diffPaths, document])

  const selectDiffFile = (filePath: string): void => {
    if (!document) return
    const root = document.workspace.replace(/[\\/]$/u, '').replaceAll('\\', '/')
    const normalized = filePath.replaceAll('\\', '/')
    const relative = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
    const item = items.find((candidate) => (
      candidate.type === 'diff'
      && (candidate.fileDiff.name === relative || candidate.fileDiff.name.endsWith(`/${relative}`))
    ))
    if (!item) return
    setActiveTreePath(filePath)
    viewer.current?.scrollTo({ type: 'item', id: item.id, align: 'start', behavior: 'smooth' })
  }

  const updateComments = (next: ReviewComment[]): void => {
    if (!document) return
    setComments(next)
    setCommentVersion((version) => version + 1)
    saveReviewComments(document.id, next)
  }

  const addComment = (body: string): void => {
    if (!draft || !document || !body.trim()) return
    const range = normalizedReviewRange(draft.selection.range)
    updateComments([...comments, {
      id: crypto.randomUUID(),
      itemId: draft.selection.id,
      path: draft.path,
      side: range.side,
      start: range.start,
      end: range.end,
      body: body.trim(),
      createdAt: new Date().toISOString(),
    }])
    setDraft(undefined)
    setSelection(null)
  }

  const removeComment = (id: string): void => updateComments(comments.filter((comment) => comment.id !== id))

  const send = async (): Promise<void> => {
    if (!document || comments.length === 0) return
    setSending(true)
    setSendProblem(undefined)
    try {
      await sendReviewComments(ui, layout, document, workspaceId, comments)
    } catch (error) {
      setSendProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  const selectedCommitIsRecent = commitRef !== undefined
    && recentCommitChoices.some((commit) => commit.sha === commitRef)

  const Explorer = explorerState.explorer?.component
  const explorerAvailable = Boolean(Explorer && document && diffPaths.length > 0)
  return (
    <section className={`${clientStyles.pane} diff-viewer-pane${presentation === 'overlay' ? ' is-overlay' : ''}`}>
      <header className={`${clientStyles.paneHeader} ${paneToolbarStyles.pane} diff-viewer-toolbar`}>
        <label
          className={`${paneToolbarStyles.picker} diff-viewer-commit-picker`}
          title={commitsLoading ? 'Loading recent commits…' : 'Choose working tree or commit'}
        >
          <select
            value={commitRef ?? ''}
            aria-label="Choose diff revision"
            onChange={(event) => setCommitRef(event.target.value || undefined)}
          >
            <option value="">
              {pane.resource && resourceCommit === undefined ? 'Review snapshot' : 'Working tree'}
            </option>
            {commitRef && !selectedCommitIsRecent && (
              <option value={commitRef}>{commitRef}</option>
            )}
            {recentCommitChoices.map((commit) => (
              <option value={commit.sha} key={commit.sha}>
                {commit.shortSha} {commit.subject}
              </option>
            ))}
          </select>
          <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
        </label>
        <div className={`${paneToolbarStyles.actions} diff-viewer-toolbar-actions`}>
          {explorerAvailable && (
            <div className={`${paneToolbarStyles.group} diff-viewer-control-group`}>
              <button
                className={clientStyles.iconButton}
                type="button"
                title={filesVisible ? 'Hide changed files' : 'Show changed files'}
                aria-label={filesVisible ? 'Hide changed files' : 'Show changed files'}
                aria-pressed={filesVisible}
                onClick={() => setFilesVisible((visible) => !visible)}
              >
                {filesVisible
                  ? <PanelLeftClose size={14} strokeWidth={1.6} />
                  : <PanelLeftOpen size={14} strokeWidth={1.6} />}
              </button>
            </div>
          )}
          <div className={`${paneToolbarStyles.modes} diff-viewer-style`} role="group" aria-label="Diff layout">
            <button className={style === 'unified' ? 'is-active' : ''} type="button" onClick={() => setStyle('unified')}>Unified</button>
            <button className={style === 'split' ? 'is-active' : ''} type="button" onClick={() => setStyle('split')}>Split</button>
          </div>
          <div className={`${paneToolbarStyles.group} diff-viewer-control-group`}>
            <button
              className={clientStyles.iconButton}
              type="button"
              title={lineWrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
              aria-label={lineWrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
              aria-pressed={lineWrap}
              onClick={() => setLineWrap(!lineWrap)}
            >
              <TextWrap size={14} strokeWidth={1.6} />
            </button>
            <button className={clientStyles.iconButton} type="button" title="Refresh diff" aria-label="Refresh diff" onClick={() => setReload((value) => value + 1)}>
              <RefreshCw size={14} strokeWidth={1.6} />
            </button>
          </div>
          {presentation === 'overlay' && onClose && (
            <div className={`${paneToolbarStyles.group} diff-viewer-control-group`}>
              <button className={clientStyles.iconButton} type="button" title="Close review" aria-label="Close diff review" onClick={onClose}>
                <X size={14} strokeWidth={1.6} />
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="diff-viewer-body">
        {filesVisible && Explorer && document && diffPaths.length > 0 && (
          <Explorer
            workspace={document.workspace}
            paths={diffPaths}
            {...(activeTreePath ? { activePath: activeTreePath } : {})}
            label="Changed files"
            select={selectDiffFile}
          />
        )}
        {state.tag === 'loading' && <div className="diff-viewer-state"><RefreshCw className="is-spinning" size={16} /> Loading diff…</div>}
        {state.tag === 'failed' && <div className="diff-viewer-state is-error" role="alert">{state.problem}</div>}
        {document && !document.patch.trim() && (
          <div className="diff-viewer-state">
            {commitRef ? 'No changes in this commit.' : 'No working tree changes.'}
          </div>
        )}
        {document?.patch.trim() && items.length === 0 && <div className="diff-viewer-state is-error">This patch could not be parsed.</div>}
        {items.length > 0 && (
          <CodeView<ReviewComment>
            ref={viewer}
            className="diff-viewer-code"
            items={items}
            options={options}
            selectedLines={selection}
            onSelectedLinesChange={(next) => {
              setSelection(next)
              if (next) openDraft(next)
              else setDraft(undefined)
            }}
            renderAnnotation={(annotation) => {
              const comment = annotation.metadata
              return comment
                ? <ReviewAnnotation comment={comment} remove={removeComment} />
                : null
            }}
          />
        )}
      </div>
      {draft && (
        <ReviewCommentComposer
          draft={draft}
          cancel={() => { setDraft(undefined); setSelection(null) }}
          add={addComment}
        />
      )}
      {comments.length > 0 && (
        <footer className="diff-viewer-footer">
          <div>
            <MessageSquarePlus size={14} strokeWidth={1.7} />
            <span>{comments.length} comment{comments.length === 1 ? '' : 's'}</span>
            {sendProblem && <span className="diff-viewer-send-error">{sendProblem}</span>}
          </div>
          <button type="button" disabled={sending} onClick={() => void send()}>
            <Send size={13} strokeWidth={1.8} />
            <span>{sending ? 'Sending…' : 'Send to chat'}</span>
          </button>
        </footer>
      )}
    </section>
  )
}

function FileReviewAction({
  activityId,
  files,
  session,
  appearance = 'label',
  host,
  layout,
  ui,
}: FileReviewActionProps & {
  host: ClientHostService
  layout: ClientWorkspaceLayoutService
  ui: ClientUiService
}): ReactNode {
  const [opening, setOpening] = useState(false)
  const [problem, setProblem] = useState<string>()
  const review = useSyncExternalStore(diffReviewOverlay.subscribe, diffReviewOverlay.snapshot)
  const activeOverlay = useSyncExternalStore(ui.overlays.subscribe, ui.overlays.snapshot)
  const active = activeOverlay === DIFF_REVIEW_OVERLAY_ID
    && review?.activityId === activityId

  const open = async (): Promise<void> => {
    if (active) {
      ui.overlays.close(DIFF_REVIEW_OVERLAY_ID)
      diffReviewOverlay.close(review)
      return
    }
    if (review?.activityId === activityId) {
      ui.overlays.open(DIFF_REVIEW_OVERLAY_ID)
      return
    }

    setOpening(true)
    setProblem(undefined)
    try {
      await openDiffReview(activityId, files, session, host, layout, diffReviewOverlay)
      ui.overlays.open(DIFF_REVIEW_OVERLAY_ID)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setOpening(false)
    }
  }

  const actionLabel = active
    ? 'Close diff review'
    : problem ?? (opening ? 'Opening diff review' : 'Open diff review')

  return (
    <button
      className={appearance === 'icon'
        ? `file-change-review ${clientStyles.iconButton}`
        : 'file-change-review'}
      type="button"
      title={appearance === 'icon' ? undefined : actionLabel}
      aria-label={actionLabel}
      aria-pressed={active}
      data-hotkey={appearance === 'icon' ? (active ? 'Close review' : problem ?? 'Review') : undefined}
      disabled={opening}
      onClick={() => void open()}
    >
      {appearance === 'icon'
        ? <FileDiff size={16} strokeWidth={1.7} />
        : opening ? 'Opening…' : active ? 'Close' : 'Review'}
    </button>
  )
}

export function diffReviewPaneRequest(review: DiffReviewOverlayRequest) {
  return {
    direction: 'horizontal' as const,
    kind: DIFF_VIEWER_PANE_KIND,
    resource: review.resource,
    ...(review.threadId ? { anchorThreadId: review.threadId } : {}),
    workspace: review.workspace,
    ...(review.projectId ? { projectId: review.projectId } : {}),
  }
}

function DiffReviewOverlayDialog({
  review,
  host,
  layout,
  ui,
  explorers,
}: {
  review: DiffReviewOverlayRequest
  host: ClientHostService
  layout: ClientWorkspaceLayoutService
  ui: ClientUiService
  explorers: ClientCodeExplorerService
}): ReactNode {
  const panel = useRef<HTMLElement>(null)
  const [hasDraft, setHasDraft] = useState(false)
  const pane = useMemo<WorkspacePaneNode>(() => ({
    type: 'pane',
    id: `diff-review-overlay:${review.reviewId}`,
    kind: DIFF_VIEWER_PANE_KIND,
    workspace: review.workspace,
    resource: review.resource,
    ...(review.projectId ? { projectId: review.projectId } : {}),
  }), [review])

  const close = (): void => {
    ui.overlays.close(DIFF_REVIEW_OVERLAY_ID)
    diffReviewOverlay.close(review)
  }

  useEffect(() => {
    panel.current?.focus({ preventScroll: true })
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [review])

  return (
    <ConversationPaneOverlay
      className={`${clientStyles.overlayLayer} diff-review-overlay-layer`}
      data-has-comment-draft={hasDraft || undefined}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !hasDraft) close()
      }}
    >
      <section
        ref={panel}
        className={`${clientStyles.floatingPanel} diff-review-overlay-panel`}
        role="dialog"
        aria-label="Review changes"
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <DiffViewerPane
          workspaceId={review.workspaceId}
          pane={pane}
          focused
          visible
          presentation="overlay"
          host={host}
          layout={layout}
          ui={ui}
          explorers={explorers}
          onDraftChange={setHasDraft}
          onClose={close}
        />
      </section>
    </ConversationPaneOverlay>
  )
}

function DiffReviewOverlayRoot({
  host,
  layout,
  ui,
  explorers,
}: {
  host: ClientHostService
  layout: ClientWorkspaceLayoutService
  ui: ClientUiService
  explorers: ClientCodeExplorerService
}): ReactNode {
  const review = useSyncExternalStore(diffReviewOverlay.subscribe, diffReviewOverlay.snapshot)
  const activeOverlay = useSyncExternalStore(ui.overlays.subscribe, ui.overlays.snapshot)
  if (!review || activeOverlay !== DIFF_REVIEW_OVERLAY_ID) return null
  return (
    <DiffReviewOverlayDialog
      review={review}
      host={host}
      layout={layout}
      ui={ui}
      explorers={explorers}
    />
  )
}

/** Creates an immutable review snapshot and opens it over the originating chat. */
export async function openDiffReview(
  activityId: string,
  files: FileReviewActionProps['files'],
  session: ClientSessionService,
  host: Pick<ClientHostService, 'call'>,
  layout: Pick<ClientWorkspaceLayoutService, 'paneTargets'>,
  overlay: DiffReviewOverlayController,
): Promise<void> {
  const state = session.snapshot()
  const workspace = state.session.workspace
  if (!workspace) throw new Error('This chat has no workspace to review.')

  const reference = parseDiffReviewReference(await host.call(DIFF_VIEWER_CREATE_METHOD, {
    title: 'Review changes',
    workspace,
    ...(state.threadId ? { threadId: state.threadId } : {}),
    activityId,
    files: files.map((file) => ({ path: file.path, kind: file.kind, diff: file.diff })),
  }))
  const targets = layout.paneTargets()
  const source = targets.find((target) => target.session === session)
    ?? targets.find((target) => target.session.snapshot().threadId === state.threadId)

  overlay.open({
    activityId,
    reviewId: reference.id,
    resource: reference.resource,
    workspace,
    workspaceId: source?.workspaceId ?? `diff-review:${state.threadId ?? workspace}`,
    ...(source ? { anchorPaneId: source.paneId } : {}),
    ...(state.threadId ? { threadId: state.threadId } : {}),
    ...(state.activeProjectId ? { projectId: state.activeProjectId } : {}),
  })
}

const diffViewerClient: BrowserPlugin = (ctx) => {
  const ReviewAction = (props: FileReviewActionProps) => (
    <FileReviewAction
      {...props}
      host={ctx.clientHost}
      layout={ctx.clientWorkspaceLayout}
      ui={ctx.clientUi}
    />
  )
  const OverlayRoot = () => (
    <DiffReviewOverlayRoot
      host={ctx.clientHost}
      layout={ctx.clientWorkspaceLayout}
      ui={ctx.clientUi}
      explorers={ctx.clientCodeExplorer}
    />
  )
  ctx.clientUi.registerComponent(ctx, FILE_REVIEW_ACTION_COMPONENT, ReviewAction)
  ctx.clientUi.registerRoot(ctx, 'diff-review-overlay', OverlayRoot)
  ctx.clientWorkspaceLayout.registerPaneKind(ctx, {
    id: DIFF_VIEWER_PANE_KIND,
    label: 'Diff',
    description: 'Review code changes and send inline comments to chat',
    shortcut: 'd',
    icon: FileDiff,
    renderer: (props) => (
      <DiffViewerPane
        {...props}
        host={ctx.clientHost}
        layout={ctx.clientWorkspaceLayout}
        ui={ctx.clientUi}
        explorers={ctx.clientCodeExplorer}
      />
    ),
  })
  ctx.clientUi.registerStyle(ctx, 'diff-viewer', String(styles))
  return () => {
    ctx.clientUi.overlays.close(DIFF_REVIEW_OVERLAY_ID)
    diffReviewOverlay.close()
  }
}

diffViewerClient.inject = ['clientCodeExplorer', 'clientHost', 'clientUi', 'clientWorkspaceLayout']
diffViewerClient.resources = {
  provides: {
    components: [FILE_REVIEW_ACTION_COMPONENT],
    roots: ['diff-review-overlay'],
  },
}

export default diffViewerClient
