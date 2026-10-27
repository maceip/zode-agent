import { paneToolbarStyles } from './pane-toolbar.js'
import {
  ChevronDown,
  GitCommit,
  Map as MapIcon,
  MessageSquarePlus,
  RefreshCw,
  Send,
  TextWrap,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type {
  CodeViewLineSelection,
  DiffLineAnnotation,
  FileDiffOptions,
  SelectedLineRange,
} from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import {
  clientStyles,
  type BrowserPlugin,
  type ClientHostService,
  type ClientUiService,
} from '../../src/client/plugin-api.js'
import type { JsonValue } from '../../src/shared/protocol.js'
import {
  CODE_TOUR_GENERATE_METHOD,
  CODE_TOUR_PANE_KIND,
  parseCodeTourGenerationResponse,
} from './code-tour-api.js'
import {
  codeTourPaths,
  emptyCodeTour,
  materializeCodeTour,
  type CodeTourDocument,
} from './code-tour-model.js'
import {
  commitRefFromDiffResource,
  DIFF_VIEWER_COMMITS_METHOD,
  DIFF_VIEWER_READ_METHOD,
  parseDiffCommitSummaries,
  parseDiffReviewDocument,
  type DiffCommitSummary,
  type DiffReviewDocument,
} from './diff-viewer-api.js'
import { PIERRE_REVIEW_STYLES } from './diff-viewer.client.js'
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
import type { ClientMarkdownService } from './markdown-api.js'
import type {
  ClientWorkspaceLayoutService,
  WorkspacePaneKindProps,
} from './workspace-layout-api.js'
import type { ClientSessionRouterService } from './session-api.js'
import { useThemeAppearance } from './theme-runtime.js'
import { MarkdownContent, MarkdownMathProvider } from './ui/markdown.js'
import { useLineWrapPreference } from './viewer-preferences.js'
import {
  ALTO_SHARED_CODE_THEMES,
  ensureAltoSharedCodeTheme,
} from './shared-code-theme.js'
import styles from './code-tour.css'

ensureAltoSharedCodeTheme()
const BRANCH_CHOICE = '@branch'
const REVIEW_CHOICE = '@review'
const TOUR_PROMPT_VERSION = 4
const EMPTY_REVIEW_ANNOTATIONS: DiffLineAnnotation<ReviewComment>[] = []

type DiffStyle = 'unified' | 'split'
type TourState =
  | { tag: 'idle' | 'loading' | 'generating' }
  | { tag: 'ready'; document: DiffReviewDocument; tour: CodeTourDocument }
  | { tag: 'failed'; problem: string }

interface CodeTourGenerationSettings {
  model: string
  effort: string
}

function sourceGenerationSettings(
  sessionRouter: ClientSessionRouterService,
): CodeTourGenerationSettings {
  const source = sessionRouter.activeSession().snapshot()
  const model = source.session.model
    ?? source.harness?.codex.models.find((candidate) => candidate.isDefault)?.id
  const selected = source.harness?.codex.models.find((candidate) => candidate.id === model)
    ?? source.harness?.codex.models.find((candidate) => candidate.isDefault)
  const effort = source.session.effort ?? selected?.defaultReasoningEffort
  if (!model || !effort) {
    throw new Error('Code Tour could not read the source chat model and reasoning effort')
  }
  return { model, effort }
}

const tourCache = new Map<string, CodeTourDocument>()
const pendingTours = new Map<string, Promise<CodeTourDocument>>()

function initialChoice(resource: string | undefined): string {
  if (!resource) return BRANCH_CHOICE
  return commitRefFromDiffResource(resource) ?? REVIEW_CHOICE
}

function tourCacheKey(
  document: DiffReviewDocument,
  generation: CodeTourGenerationSettings,
): string {
  let hash = 2_166_136_261
  for (let index = 0; index < document.patch.length; index += 1) {
    hash ^= document.patch.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return [
    TOUR_PROMPT_VERSION,
    generation.model,
    generation.effort,
    document.id,
    document.patch.length,
    hash >>> 0,
  ].join(':')
}

async function generateTour(
  host: ClientHostService,
  document: DiffReviewDocument,
  generation: CodeTourGenerationSettings,
): Promise<CodeTourDocument> {
  const key = tourCacheKey(document, generation)
  const cached = tourCache.get(key)
  if (cached) return cached
  const pending = pendingTours.get(key)
  if (pending) return pending
  const request = host.call(CODE_TOUR_GENERATE_METHOD, {
    document: document as unknown as JsonValue,
    paths: codeTourPaths(document),
    model: generation.model,
    effort: generation.effort,
  }).then((value) => {
    const generated = parseCodeTourGenerationResponse(value)
    const tour = materializeCodeTour(
      document,
      generated.tour,
      generated.model,
      generated.effort,
    )
    tourCache.set(key, tour)
    return tour
  }).finally(() => pendingTours.delete(key))
  pendingTours.set(key, request)
  return request
}

function TourPane({
  workspaceId,
  pane,
  visible,
  host,
  layout,
  markdown,
  sessionRouter,
  ui,
}: WorkspacePaneKindProps & {
  host: ClientHostService
  layout: ClientWorkspaceLayoutService
  markdown: ClientMarkdownService
  sessionRouter: ClientSessionRouterService
  ui: ClientUiService
}): ReactNode {
  const markdownState = useSyncExternalStore(markdown.subscribe, markdown.snapshot)
  const [choice, setChoice] = useState(() => initialChoice(pane.resource))
  const [recentCommits, setRecentCommits] = useState<DiffCommitSummary[]>([])
  const [commitsLoading, setCommitsLoading] = useState(false)
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<TourState>({ tag: 'idle' })
  const [style, setStyle] = useState<DiffStyle>('unified')
  const [lineWrap, setLineWrap] = useLineWrapPreference('diff')
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null)
  const [draft, setDraft] = useState<ReviewCommentDraft>()
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [sendProblem, setSendProblem] = useState<string>()
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inheritedGeneration = useRef<CodeTourGenerationSettings | undefined>(undefined)
  const theme = useThemeAppearance()

  useEffect(() => setChoice(initialChoice(pane.resource)), [pane.resource, pane.workspace])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return

    const handleDiffWheel = (event: WheelEvent): void => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.code-tour-diff')) return
      if (event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return

      const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? scroll.clientHeight
          : 1
      const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
      const next = Math.max(0, Math.min(maximum, scroll.scrollTop + event.deltaY * multiplier))
      if (next === scroll.scrollTop) return

      event.preventDefault()
      event.stopPropagation()
      scroll.scrollTop = next
    }

    let hoveredDiff: Element | undefined
    let hoveredRow: Element | undefined
    const handleDiffPointerMove = (event: PointerEvent): void => {
      const path = event.composedPath()
      const diff = path.find((target): target is Element => (
        target instanceof Element && target.classList.contains('code-tour-diff')
      ))
      if (!diff) {
        hoveredDiff = undefined
        hoveredRow = undefined
        return
      }
      const row = path.find((target): target is Element => (
        target instanceof Element
        && (target.hasAttribute('data-line') || target.hasAttribute('data-column-number'))
      ))
      // Pierre walks the composed path on every raw pointer move. The comment
      // affordance changes only when the hovered row changes, so repeated
      // events inside one row do not need to reach each Tour diff instance.
      if (hoveredDiff === diff && hoveredRow === row) {
        event.stopPropagation()
        return
      }
      hoveredDiff = diff
      hoveredRow = row
    }

    scroll.addEventListener('wheel', handleDiffWheel, { capture: true, passive: false })
    scroll.addEventListener('pointermove', handleDiffPointerMove, true)
    return () => {
      scroll.removeEventListener('wheel', handleDiffWheel, true)
      scroll.removeEventListener('pointermove', handleDiffPointerMove, true)
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    let current = true
    setCommitsLoading(true)
    void host.call(DIFF_VIEWER_COMMITS_METHOD, { workspace: pane.workspace }).then((value) => {
      if (current) setRecentCommits(parseDiffCommitSummaries(value))
    }).catch(() => {
      if (current) setRecentCommits([])
    }).finally(() => {
      if (current) setCommitsLoading(false)
    })
    return () => { current = false }
  }, [host, pane.workspace, visible])

  useEffect(() => {
    if (!visible) return
    let current = true
    const load = async (): Promise<void> => {
      try {
        setState({ tag: 'loading' })
        const payload: JsonValue = choice === REVIEW_CHOICE && pane.resource
          ? { resource: pane.resource, workspace: pane.workspace }
          : choice === BRANCH_CHOICE
            ? {
                workspace: pane.workspace,
                comparison: 'branch',
                ...(pane.thread?.id ? { threadId: pane.thread.id } : {}),
              }
            : choice
              ? {
                  workspace: pane.workspace,
                  commit: choice,
                  ...(pane.thread?.id ? { threadId: pane.thread.id } : {}),
                }
              : {
                  workspace: pane.workspace,
                  ...(pane.thread?.id ? { threadId: pane.thread.id } : {}),
                }
        const document = parseDiffReviewDocument(await host.call(DIFF_VIEWER_READ_METHOD, payload))
        if (!current) return
        const generation = inheritedGeneration.current ?? sourceGenerationSettings(sessionRouter)
        inheritedGeneration.current = generation
        setComments(loadReviewComments(document.id))
        setSelection(null)
        setDraft(undefined)
        setSendProblem(undefined)
        if (!document.patch.trim()) {
          setState({
            tag: 'ready',
            document,
            tour: emptyCodeTour(document, generation.model, generation.effort),
          })
          return
        }
        setState({ tag: 'generating' })
        const tour = await generateTour(host, document, generation)
        if (current) setState({ tag: 'ready', document, tour })
      } catch (error) {
        if (current) setState({ tag: 'failed', problem: error instanceof Error ? error.message : String(error) })
      }
    }
    void load()
    return () => { current = false }
  }, [choice, host, pane.resource, pane.thread?.id, pane.workspace, reload, sessionRouter, visible])

  const document = state.tag === 'ready' ? state.document : undefined
  const tour = state.tag === 'ready' ? state.tour : undefined

  const openDraft = useCallback((itemId: string, path: string, range: SelectedLineRange): void => {
    const next = { id: itemId, range }
    setSelection(next)
    setDraft({ selection: next, path, body: '' })
  }, [])

  const options = useMemo<FileDiffOptions<ReviewComment>>(() => ({
    diffStyle: style,
    diffIndicators: 'bars',
    overflow: lineWrap ? 'wrap' : 'scroll',
    theme: ALTO_SHARED_CODE_THEMES,
    hunkSeparators: 'line-info',
    themeType: theme.mode,
    unsafeCSS: PIERRE_REVIEW_STYLES,
    stickyHeader: false,
    lineHoverHighlight: 'both',
    enableLineSelection: true,
    enableGutterUtility: true,
  }), [lineWrap, style, theme.mode])

  const stopOptions = useMemo(() => new Map<string, FileDiffOptions<ReviewComment>>(
    (tour?.stops ?? []).map((stop) => [stop.id, {
      ...options,
      onGutterUtilityClick: (range) => openDraft(stop.id, stop.path, range),
      onLineSelected: (range) => {
        if (range) {
          openDraft(stop.id, stop.path, range)
          return
        }
        setSelection((current) => current?.id === stop.id ? null : current)
        setDraft((current) => current?.selection.id === stop.id ? undefined : current)
      },
    }]),
  ), [openDraft, options, tour])

  const annotationsByPath = useMemo(() => new Map(
    (tour?.stops ?? []).map((stop) => [stop.path, reviewAnnotations(comments, stop.path)]),
  ), [comments, tour])

  const updateComments = (next: ReviewComment[]): void => {
    if (!document) return
    setComments(next)
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

  const removeComment = (id: string): void => {
    updateComments(comments.filter((comment) => comment.id !== id))
  }

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

  const selectedCommitIsRecent = choice !== BRANCH_CHOICE
    && choice !== REVIEW_CHOICE
    && choice !== ''
    && recentCommits.some((commit) => commit.sha === choice)
  const regenerate = (): void => {
    if (state.tag === 'ready') {
      tourCache.delete(tourCacheKey(state.document, {
        model: state.tour.model,
        effort: state.tour.effort,
      }))
    }
    setReload((value) => value + 1)
  }

  return (
    <section className={`${clientStyles.pane} code-tour-pane`}>
      <header className={`${clientStyles.paneHeader} ${paneToolbarStyles.pane} diff-viewer-toolbar code-tour-toolbar`}>
        <span className={`${paneToolbarStyles.title} diff-viewer-summary`} title={tour?.title}>
          {tour ? tour.title : 'Code tour'}
        </span>
        <label
          className={`${paneToolbarStyles.picker} diff-viewer-commit-picker has-leading-icon`}
          title={commitsLoading ? 'Loading recent commits…' : 'Choose branch, working tree, or commit'}
        >
          <GitCommit size={13} strokeWidth={1.7} aria-hidden="true" />
          <select value={choice} aria-label="Choose tour revision" onChange={(event) => setChoice(event.target.value)}>
            {pane.resource && commitRefFromDiffResource(pane.resource) === undefined && (
              <option value={REVIEW_CHOICE}>Review snapshot</option>
            )}
            <option value={BRANCH_CHOICE}>Branch vs origin/main</option>
            <option value="">Working tree</option>
            {choice && choice !== BRANCH_CHOICE && choice !== REVIEW_CHOICE && !selectedCommitIsRecent && (
              <option value={choice}>{choice}</option>
            )}
            {recentCommits.map((commit) => (
              <option value={commit.sha} key={commit.sha}>
                {commit.shortSha} {commit.subject}
              </option>
            ))}
          </select>
          <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
        </label>
        <div className={`${paneToolbarStyles.actions} diff-viewer-toolbar-actions`}>
          <div className={`${paneToolbarStyles.modes} diff-viewer-style`} role="group" aria-label="Tour diff layout">
            <button className={style === 'unified' ? 'is-active' : ''} type="button" onClick={() => setStyle('unified')}>Unified</button>
            <button className={style === 'split' ? 'is-active' : ''} type="button" onClick={() => setStyle('split')}>Split</button>
          </div>
          <button
            className={clientStyles.iconButton}
            type="button"
            title={lineWrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
            aria-label={lineWrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
            aria-pressed={lineWrap}
            onClick={() => setLineWrap(!lineWrap)}
          >
            <TextWrap size={14} strokeWidth={1.7} />
          </button>
          <button
            className={clientStyles.iconButton}
            type="button"
            title="Regenerate tour"
            aria-label="Regenerate tour"
            disabled={state.tag === 'generating'}
            onClick={regenerate}
          >
            <RefreshCw size={14} strokeWidth={1.7} />
          </button>
        </div>
      </header>
      <div className="code-tour-scroll" ref={scrollRef}>
        {state.tag === 'loading' && <div className="diff-viewer-state"><RefreshCw className="is-spinning" size={16} /> Reading diff…</div>}
        {state.tag === 'generating' && <div className="diff-viewer-state"><RefreshCw className="is-spinning" size={16} /> Building tour…</div>}
        {state.tag === 'failed' && <div className="diff-viewer-state is-error" role="alert">{state.problem}</div>}
        {tour && tour.stops.length === 0 && (
          <div className="diff-viewer-state">
            {choice === BRANCH_CHOICE
              ? 'No changes between this branch and origin/main.'
              : choice
                ? 'No changes in this commit.'
                : 'No working tree changes.'}
          </div>
        )}
        {tour && tour.stops.length > 0 && (
          <MarkdownMathProvider renderer={markdownState.math} fileLinks={markdownState.fileLinks}>
            <article className="code-tour-document">
              <header className="code-tour-intro">
                <MarkdownContent className="activity-markdown code-tour-markdown" source={tour.intro} label="Tour overview" />
              </header>
              <ol className="code-tour-stops">
                {tour.stops.map((stop, index) => (
                  <li className="code-tour-stop" id={`code-tour-stop-${index + 1}`} key={stop.id}>
                    <div className="code-tour-narrative">
                      <MarkdownContent
                        className="activity-markdown code-tour-markdown"
                        source={`## ${stop.heading}\n\n${stop.markdown}`}
                        label={`Tour stop ${index + 1}: ${stop.path}`}
                      />
                    </div>
                    <FileDiff<ReviewComment>
                      className="diff-viewer-code code-tour-diff"
                      fileDiff={stop.fileDiff}
                      lineAnnotations={annotationsByPath.get(stop.path) ?? EMPTY_REVIEW_ANNOTATIONS}
                      selectedLines={selection?.id === stop.id ? selection.range : null}
                      options={stopOptions.get(stop.id) ?? options}
                      renderAnnotation={(annotation) => (
                        annotation.metadata
                          ? <ReviewAnnotation comment={annotation.metadata} remove={removeComment} />
                          : null
                      )}
                    />
                  </li>
                ))}
              </ol>
            </article>
          </MarkdownMathProvider>
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

const codeTourClient: BrowserPlugin = (ctx) => {
  ctx.clientWorkspaceLayout.registerPaneKind(ctx, {
    id: CODE_TOUR_PANE_KIND,
    label: 'Tour',
    description: 'LLM-guided Markdown walkthrough interleaved with focused diffs',
    shortcut: 'u',
    icon: MapIcon,
    renderer: (props) => (
      <TourPane
        {...props}
        host={ctx.clientHost}
        layout={ctx.clientWorkspaceLayout}
        markdown={ctx.clientMarkdown}
        sessionRouter={ctx.clientSessionRouter}
        ui={ctx.clientUi}
      />
    ),
  })
  ctx.clientUi.registerStyle(ctx, 'code-tour', String(styles))
}

codeTourClient.inject = [
  'clientHost',
  'clientMarkdown',
  'clientSessionRouter',
  'clientUi',
  'clientWorkspaceLayout',
]

export default codeTourClient
