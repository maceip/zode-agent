import { isAgentChatId } from '../agent-chats-api.js'
import {
  Activity,
  BookOpen,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  FileText,
  Pencil,
  Search,
  Sparkles,
  TerminalSquare,
  User,
  Wrench,
} from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { withAsyncQuestionAnswers } from './async-question-model.js'
import { AsyncQuestionRequest } from './async-question.js'
import type { TurnIntervention } from './turn-intervention.js'
import { MessageMarkdown } from './markdown.js'
import { WorkingShimmer, WorkingShimmerContext } from './working-shimmer.js'
import type { MarkdownCodeBlockProps } from '../markdown-api.js'
import type {
  FileReviewActionProps,
} from '../chat-surfaces-api.js'
import type { ClientSessionService } from '../session-api.js'
import {
  type ActivityItem,
  type FileChangeEntry,
} from './transcript.js'
export type { ActivityItem, FileChangeEntry } from './transcript.js'
import { summarizeFileChanges } from './activity-model.js'
export { activityFrom, completeLatestTurn, fileChanges, mergeActivity, summarizeFileChanges, type FileChangeSummary } from './activity-model.js'

export const ACTIVITY_REVEAL_EVENT = 'cordis:activity-reveal'
export const INITIAL_VISIBLE_TURNS = 24

export const EARLIER_TURN_BATCH = 24
const STREAM_INITIAL_CHARACTERS = 12
function completeCodePoint(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end
  const previous = text.charCodeAt(end - 1)
  const next = text.charCodeAt(end)
  return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF
    ? end + 1
    : end
}

export function nextStreamRevealEnd(
  text: string,
  revealed: number,
  elapsedMs: number,
): number {
  const current = Math.max(0, Math.min(revealed, text.length))
  const backlog = text.length - current
  if (backlog <= 0) return text.length

  // Normal deltas arrive at a calm reading pace. Larger bursts accelerate so
  // the animation smooths transport jitter without leaving the UI seconds
  // behind the actual response.
  const charactersPerSecond = Math.min(900, 75 + backlog * 3.5)
  const elapsed = Math.max(8, Math.min(elapsedMs, 80))
  const advance = Math.max(1, Math.round(charactersPerSecond * elapsed / 1_000))
  return completeCodePoint(text, Math.min(text.length, current + advance))
}

function initialStreamText(source: string, streaming: boolean): string {
  if (!streaming || typeof window === 'undefined' || source.length <= STREAM_INITIAL_CHARACTERS) {
    return source
  }
  return source.slice(0, completeCodePoint(source, STREAM_INITIAL_CHARACTERS))
}

function useSmoothedStreamText(source: string, streaming: boolean, enabled = true): string {
  const [displayed, setDisplayed] = useState(() => initialStreamText(source, streaming))
  const displayedRef = useRef(displayed)
  const targetRef = useRef(source)
  const frameRef = useRef<number | undefined>(undefined)
  const lastRevealRef = useRef<number>(0)

  const commit = (value: string): void => {
    displayedRef.current = value
    setDisplayed(value)
  }

  const cancel = (): void => {
    if (frameRef.current === undefined) return
    window.cancelAnimationFrame(frameRef.current)
    frameRef.current = undefined
  }

  const schedule = (): void => {
    if (frameRef.current !== undefined || displayedRef.current.length >= targetRef.current.length) return
    if (!lastRevealRef.current) lastRevealRef.current = window.performance.now()
    frameRef.current = window.requestAnimationFrame((time) => {
      frameRef.current = undefined
      const target = targetRef.current
      const end = nextStreamRevealEnd(
        target,
        displayedRef.current.length,
        time - lastRevealRef.current,
      )
      lastRevealRef.current = time
      commit(target.slice(0, end))
      schedule()
    })
  }

  useLayoutEffect(() => {
    targetRef.current = source
    if (!enabled) {
      cancel()
      lastRevealRef.current = 0
      if (displayedRef.current !== source) commit(source)
      return
    }
    // Keep draining a buffered final delta after the provider marks the item
    // complete. Snapping to the target makes the last line pop in and changes
    // the turn's height in one frame.
    if (!source.startsWith(displayedRef.current)) {
      cancel()
      lastRevealRef.current = 0
      commit(source)
      return
    }
    schedule()
  }, [enabled, source, streaming])

  useEffect(() => () => cancel(), [])
  return displayed
}

export interface StreamingMarkdownParts {
  blocks: readonly string[]
  tail: string
}

interface MarkdownFence {
  marker: '`' | '~'
  length: number
}

function markdownFence(line: string): MarkdownFence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
  const fence = match?.[1]
  if (!fence) return undefined
  return {
    marker: fence[0] as '`' | '~',
    length: fence.length,
  }
}

function closesMarkdownFence(line: string, fence: MarkdownFence): boolean {
  const match = /^ {0,3}(`+|~+)\s*$/u.exec(line)
  return match?.[1]?.[0] === fence.marker && match[1].length >= fence.length
}

const STREAMING_DIRECTIVE_OPENERS = [
  ':codex-file-citation{',
  '::git-stage{',
  '::git-commit{',
  '::git-push{',
  '::git-create-branch{',
  '::git-create-pr{',
] as const

function escapedMarkdownCharacter(source: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    slashes += 1
  }
  return slashes % 2 === 1
}

function markdownMarkerRun(source: string, index: number, marker: string): number {
  let end = index
  while (source[end] === marker) end += 1
  return end - index
}

function closingMarkdownDelimiter(
  source: string,
  start: number,
  opening: '[' | '(',
  closing: ']' | ')',
): number | undefined {
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    if (escapedMarkdownCharacter(source, index)) continue
    if (opening === '[' && source[index] === '`') {
      const codeEnd = closingCodeSpan(source, index)
      if (codeEnd === undefined) return undefined
      index = codeEnd - 1
      continue
    }
    if (source[index] === opening) depth += 1
    if (source[index] !== closing) continue
    depth -= 1
    if (depth === 0) return index
  }
  return undefined
}

function closingCodeSpan(source: string, start: number): number | undefined {
  const length = markdownMarkerRun(source, start, '`')
  let index = start + length
  while (index < source.length) {
    if (source[index] !== '`' || escapedMarkdownCharacter(source, index)) {
      index += 1
      continue
    }
    const candidateLength = markdownMarkerRun(source, index, '`')
    if (candidateLength === length) return index + candidateLength
    index += candidateLength
  }
  return undefined
}

function closingDirective(source: string, start: number): number | undefined {
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote) {
      if (character === '\\') escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '}') return index + 1
  }
  return undefined
}

type MarkdownLinkScan =
  | { kind: 'complete'; end: number }
  | { kind: 'text'; end: number }
  | { kind: 'incomplete' }

function markdownLink(source: string, start: number): MarkdownLinkScan {
  const labelEnd = closingMarkdownDelimiter(source, start, '[', ']')
  if (labelEnd === undefined || labelEnd + 1 >= source.length) {
    return { kind: 'incomplete' }
  }

  const destinationStart = labelEnd + 1
  const destinationMarker = source[destinationStart]
  if (destinationMarker !== '(' && destinationMarker !== '[') {
    return { kind: 'text', end: destinationStart }
  }

  const destinationEnd = destinationMarker === '('
    ? closingMarkdownDelimiter(source, destinationStart, '(', ')')
    : closingMarkdownDelimiter(source, destinationStart, '[', ']')
  return destinationEnd === undefined
    ? { kind: 'incomplete' }
    : { kind: 'complete', end: destinationEnd + 1 }
}

/**
 * Returns the portion of a growing Markdown tail that cannot change meaning
 * when more text arrives. Incomplete rich constructs stay out of the DOM until
 * their closing delimiter arrives, so internal directives and link syntax
 * never flash as plain text before becoming interactive UI.
 */
export function stableStreamingMarkdownPrefix(source: string): string {
  let index = 0
  let lineStart = 0
  let fence: MarkdownFence | undefined

  while (index < source.length) {
    if (index === lineStart) {
      const newline = source.indexOf('\n', lineStart)
      const lineEnd = newline < 0 ? source.length : newline
      const line = source.slice(lineStart, lineEnd)
      if (fence) {
        if (closesMarkdownFence(line, fence)) fence = undefined
        if (newline < 0) return source
        index = newline + 1
        lineStart = index
        continue
      }
      const opening = markdownFence(line)
      if (opening) {
        fence = opening
        if (newline < 0) return source
        index = newline + 1
        lineStart = index
        continue
      }
    }

    const character = source[index]
    if (character === '\n') {
      index += 1
      lineStart = index
      continue
    }
    if (escapedMarkdownCharacter(source, index)) {
      index += 1
      continue
    }

    if (character === '`') {
      const end = closingCodeSpan(source, index)
      if (end === undefined) return source.slice(0, index)
      index = end
      continue
    }

    const image = character === '!' && source[index + 1] === '['
    if (character === '!' && index + 1 >= source.length) {
      return source.slice(0, index)
    }
    if (character === '[' || image) {
      const start = image ? index + 1 : index
      const link = markdownLink(source, start)
      if (link.kind === 'incomplete') return source.slice(0, index)
      index = link.end
      continue
    }

    if (character === ':') {
      const remaining = source.slice(index)
      if (STREAMING_DIRECTIVE_OPENERS.some((opener) => opener.startsWith(remaining))) {
        return source.slice(0, index)
      }
      const opener = STREAMING_DIRECTIVE_OPENERS.find((candidate) => (
        source.startsWith(candidate, index)
      ))
      if (opener) {
        const end = closingDirective(source, index + opener.length)
        if (end === undefined) return source.slice(0, index)
        index = end
        continue
      }
    }

    index += 1
  }

  return source
}

/**
 * Splits a growing Markdown response into completed blocks and one mutable
 * tail. Completed blocks never need to be parsed again, so streaming cost is
 * proportional to the current block instead of the full response prefix.
 */
export class StreamingMarkdownBuffer {
  private source = ''
  private blocks: string[] = []
  private blockStart = 0
  private scanStart = 0
  private fence?: MarkdownFence

  update(source: string, stabilize = false): StreamingMarkdownParts {
    if (!source.startsWith(this.source)) this.reset()
    this.source = source

    const visibleEnd = stabilize
      ? this.blockStart + stableStreamingMarkdownPrefix(source.slice(this.blockStart)).length
      : source.length
    let lineStart = this.scanStart
    while (lineStart < visibleEnd) {
      const newline = source.indexOf('\n', lineStart)
      if (newline < 0 || newline >= visibleEnd) break
      const line = source.slice(lineStart, newline)
      if (this.fence) {
        if (closesMarkdownFence(line, this.fence)) {
          delete this.fence
          this.commit(newline + 1)
        }
      } else {
        const opening = markdownFence(line)
        if (opening) this.fence = opening
        else if (!line.trim()) this.commit(newline + 1)
      }
      lineStart = newline + 1
      this.scanStart = lineStart
    }

    return {
      blocks: this.blocks,
      tail: source.slice(this.blockStart, visibleEnd),
    }
  }

  private commit(end: number): void {
    if (end <= this.blockStart) return
    const block = this.source.slice(this.blockStart, end)
    if (block.trim()) this.blocks = [...this.blocks, block]
    this.blockStart = end
  }

  private reset(): void {
    this.source = ''
    this.blocks = []
    this.blockStart = 0
    this.scanStart = 0
    delete this.fence
  }
}

export function initialVisibleTurnStart(
  turnCount: number,
  visibleTurns = INITIAL_VISIBLE_TURNS,
): number {
  return Math.max(0, turnCount - Math.max(1, visibleTurns))
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (!minutes) return `${seconds}s`
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}

function sameActivityItems(
  left: readonly ActivityItem[],
  right: readonly ActivityItem[],
): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

export function activityTurns(
  items: ActivityItem[],
  previous: readonly ActivityItem[][] = [],
): ActivityItem[][] {
  const turns: ActivityItem[][] = []
  let currentTurnId: string | undefined
  for (const item of items) {
    const startsPrompt = item.kind === 'user' && !item.continuesTurn
    const startsServerTurn = Boolean(
      item.turnId && currentTurnId && item.turnId !== currentTurnId,
    )
    if (startsPrompt || startsServerTurn || turns.length === 0) turns.push([item])
    else turns.at(-1)?.push(item)
    if (item.turnId) currentTurnId = item.turnId
  }
  const previousById = new Map(previous.flatMap((turn) => (
    turn[0] ? [[turn[0].id, turn] as const] : []
  )))
  return turns.map((turn) => {
    const prior = turn[0] ? previousById.get(turn[0].id) : undefined
    return prior && sameActivityItems(prior, turn) ? prior : turn
  })
}

export type ActivityWorkEntry =
  | { kind: 'activity'; item: ActivityItem }
  | { kind: 'tool-group'; items: ActivityItem[] }

export function groupToolActivities(
  items: ActivityItem[],
): ActivityWorkEntry[] {
  const entries: ActivityWorkEntry[] = []
  let tools: ActivityItem[] = []
  const flushTools = (): void => {
    if (!tools.length) return
    entries.push({ kind: 'tool-group', items: tools })
    tools = []
  }
  for (const item of items) {
    if (item.kind === 'command' || item.kind === 'tool') {
      tools.push(item)
      continue
    }
    flushTools()
    entries.push({ kind: 'activity', item })
  }
  flushTools()
  return entries
}

function icon(kind: ActivityItem['kind']): ReactNode {
  switch (kind) {
    case 'user': return <User size={15} />
    case 'agent': return <Sparkles size={15} />
    case 'reasoning': return <Braces size={15} />
    case 'command': return <TerminalSquare size={15} />
    case 'file': return <FileDiff size={15} />
    case 'tool': return <Wrench size={15} />
    case 'status': return <Activity size={15} />
  }
}

function ChangeCount({ additions, deletions }: { additions: number; deletions: number }): ReactNode {
  return (
    <span className="file-change-counts" aria-label={`${additions} additions, ${deletions} deletions`}>
      <span className="file-change-additions">+{additions}</span>
      <span className="file-change-deletions">−{deletions}</span>
    </span>
  )
}

function displayFileChangePath(path: string, workspace?: string): string {
  const root = workspace?.replace(/\/+$/u, '')
  return root && path.startsWith(`${root}/`)
    ? path.slice(root.length + 1)
    : path
}

function FileChangeCard({
  item,
  codeBlock,
  reviewAction: ReviewAction,
  session,
}: {
  item: ActivityItem
  codeBlock?: import('react').ComponentType<MarkdownCodeBlockProps> | undefined
  reviewAction?: ComponentType<FileReviewActionProps> | undefined
  session?: ClientSessionService | undefined
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const files = item.files ?? []
  const summaries = summarizeFileChanges(files)
  const workspace = session?.snapshot().session.workspace
  const additions = summaries.reduce((sum, file) => sum + file.additions, 0)
  const deletions = summaries.reduce((sum, file) => sum + file.deletions, 0)
  const label = summaries.length === 1
    ? 'Edited 1 file'
    : summaries.length > 1
      ? `Edited ${summaries.length} files`
      : item.status === 'running'
        ? 'Editing files'
        : 'Files updated'

  return (
    <article className={`file-change-card${expanded ? ' is-expanded' : ''}`} data-activity-id={item.id}>
      <header className="file-change-summary">
        <button
          className="file-change-disclosure"
          type="button"
          title={expanded ? 'Hide changed files' : 'Show changed files'}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="file-change-icon"><FileDiff size={15} /></span>
          <span className="file-change-heading">
            <strong>{label}</strong>
            {files.length > 0 && <ChangeCount additions={additions} deletions={deletions} />}
          </span>
          {summaries.length > 0 && <ChevronRight className="file-change-chevron" size={14} />}
        </button>
        {files.length > 0 && (
          ReviewAction && session
            ? <ReviewAction activityId={item.id} files={files} session={session} />
            : (
              <button
                className="file-change-review"
                type="button"
                aria-expanded={reviewing}
                onClick={() => {
                  setExpanded(true)
                  setReviewing((value) => !value)
                }}
              >
                {reviewing ? 'Hide diff' : 'Review'}
              </button>
            )
        )}
      </header>
      {expanded && summaries.length > 0 ? (
        <div className="file-change-files">
          {summaries.map((file) => (
            <div className="file-change-entry" key={file.path}>
              <div className="file-change-row">
                <span className="file-change-path" title={file.path}>
                  {displayFileChangePath(file.path, workspace)}
                </span>
                <ChangeCount additions={file.additions} deletions={file.deletions} />
              </div>
              {!ReviewAction && reviewing && file.changes.map((change, index) => (
                change.diff
                  ? <DiffView diff={change.diff} codeBlock={codeBlock} key={`${change.path}:${index}`} />
                  : null
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </article>
  )
}

export function DiffView({
  diff,
  codeBlock: CodeBlock,
}: {
  diff: string
  codeBlock?: import('react').ComponentType<MarkdownCodeBlockProps> | undefined
}): ReactNode {
  if (CodeBlock) {
    return (
      <div className="file-change-diff-view">
        <CodeBlock code={diff} language="diff" />
      </div>
    )
  }

  return (
    <pre className="file-change-diff">
      {diff.split('\n').map((line, index) => {
        const kind = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')
          ? 'meta'
          : line.startsWith('+')
            ? 'addition'
            : line.startsWith('-')
              ? 'deletion'
              : 'context'
        return <span className={`file-change-diff-${kind}`} key={`${index}:${line}`}>{line}{'\n'}</span>
      })}
    </pre>
  )
}

async function writeMessageToClipboard(content: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(content)
    return
  } catch {
    // Chromium can deny the async clipboard API in embedded or controlled
    // views. Keep the click useful by falling back to the legacy user-gesture
    // path, which does not require a separate permission grant.
  }

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.inset = '-10000px auto auto -10000px'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  active?.focus()
  if (!copied) throw new Error('Clipboard write was rejected')
}

function MessageCopyButton({
  content,
  subject,
}: {
  content: string
  subject: 'prompt' | 'reply'
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => {
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
  }, [])

  const copy = async (): Promise<void> => {
    try {
      await writeMessageToClipboard(content)
      setCopied(true)
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      className={`activity-message-copy${copied ? ' is-copied' : ''}`}
      type="button"
      title={copied ? 'Copied' : `Copy ${subject}`}
      aria-label={copied ? `Copied ${subject}` : `Copy ${subject}`}
      onClick={() => void copy()}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

const MemoizedMessageMarkdown = memo(MessageMarkdown)

function BufferedMessageMarkdown({
  source,
  stabilize,
  codeBlock,
}: {
  source: string
  stabilize: boolean
  codeBlock?: ComponentType<MarkdownCodeBlockProps> | undefined
}): ReactNode {
  const buffer = useRef<StreamingMarkdownBuffer | null>(null)
  if (!buffer.current) buffer.current = new StreamingMarkdownBuffer()
  const parts = buffer.current.update(source, stabilize)

  return (
    <div className="activity-streaming-markdown">
      {parts.blocks.map((block, index) => (
        <MemoizedMessageMarkdown
          source={block}
          key={`block:${index}`}
          {...(codeBlock ? { codeBlock } : {})}
        />
      ))}
      {parts.tail && (
        <MemoizedMessageMarkdown
          source={parts.tail}
          key={`block:${parts.blocks.length}`}
          {...(codeBlock ? { codeBlock } : {})}
        />
      )}
    </div>
  )
}

export function shouldObserveActivityHeight(
  kind: ActivityItem['kind'],
  visible: boolean,
  animating: boolean,
): boolean {
  return kind === 'agent' && visible && animating
}

export function ActivityCard({
  item,
  markdown = true,
  showMeta = true,
  compact = false,
  copyMessage = true,
  activeTrace = false,
  codeBlock,
  reviewAction,
  session,
  visible = true,
}: {
  item: ActivityItem
  markdown?: boolean
  showMeta?: boolean
  compact?: boolean
  copyMessage?: boolean
  activeTrace?: boolean
  codeBlock?: import('react').ComponentType<MarkdownCodeBlockProps> | undefined
  reviewAction?: ComponentType<FileReviewActionProps> | undefined
  session?: ClientSessionService | undefined
  visible?: boolean
}): ReactNode {
  const [expanded, setExpanded] = useState(
    item.kind === 'user'
      || item.kind === 'agent'
      || item.kind === 'reasoning'
      || item.kind === 'file'
      || item.kind === 'status',
  )
  const collapsible = !compact && (item.kind === 'reasoning' || item.kind === 'command' || item.kind === 'tool')
  const conversational = item.kind === 'user' || item.kind === 'agent'
  const prose = conversational || item.kind === 'reasoning'
  const showContent = expanded && (!compact || prose || item.kind === 'status')
  const streaming = item.kind === 'agent' && item.status === 'streaming'
  // Some history entries retain only question metadata, without message text.
  const content = item.delivery === 'async' && !item.content.trim()
    ? item.questions?.map((question) => question.title).join('\n\n') ?? item.content
    : item.content
  const displayedContent = useSmoothedStreamText(content, streaming, visible)
  const revealing = item.kind === 'agent' && displayedContent !== content
  const animating = streaming || revealing
  const articleRef = useRef<HTMLElement>(null)
  const heightFloorRef = useRef(0)
  const questionSession = item.delivery === 'async' && ((item.questionAnswers && isAgentChatId(item.threadId ?? '')) || item.questions?.some((question) => question.options?.length))
    ? session
    : undefined
  const workingTrace = item.kind === 'reasoning' || item.kind === 'command' || item.kind === 'tool'
  const messageSubject = item.kind === 'user'
    ? 'prompt'
    : item.kind === 'agent'
      ? 'reply'
      : undefined
  const showMessageActions = copyMessage && messageSubject !== undefined && !animating
    && Boolean(item.timestamp || content)
  const copyable = showMessageActions && Boolean(content)

  useLayoutEffect(() => {
    const article = articleRef.current
    if (!article) return
    // Question forms shrink after submission. A height captured while their
    // message was streaming must not reserve space for the removed choices.
    if (questionSession) {
      heightFloorRef.current = 0
      article.style.removeProperty('min-height')
      return
    }
    if (!shouldObserveActivityHeight(item.kind, visible, animating)) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const height = Math.ceil(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height)
      if (height <= heightFloorRef.current) return
      heightFloorRef.current = height
      article.style.minHeight = `${height}px`
    })
    observer.observe(article)
    return () => observer.disconnect()
  }, [animating, item.kind, questionSession, visible])

  if (item.kind === 'file') {
    // File patches can arrive repeatedly throughout a turn. The completed turn
    // renders one aggregate review card after all of them have settled.
    return null
  }
  return (
    <article ref={articleRef} className={`activity-card activity-${item.kind}${item.phase ? ` activity-agent-${item.phase}` : ''}${animating ? ' activity-streaming' : ''}${workingTrace ? ' activity-working-trace' : ''}${activeTrace ? ' activity-active-trace' : ''}`} data-activity-id={item.id}>
      {showMeta && item.kind === 'agent' && item.durationMs && (
        <div className="activity-response-meta">
          <span>Worked for {formatDuration(item.durationMs)}</span>
          <ChevronRight size={14} />
        </div>
      )}
      {!prose && (
        <header>
          <span className="activity-icon">{icon(item.kind)}</span>
          <WorkingShimmer className="activity-title" active={activeTrace && visible}>{item.title}</WorkingShimmer>
          {collapsible && (
            <button
              className="icon-button compact"
              type="button"
              aria-label={expanded ? 'Collapse' : 'Expand'}
              onClick={() => setExpanded((value) => !value)}
            >
              <ChevronDown size={14} className={expanded ? 'rotated' : ''} />
            </button>
          )}
        </header>
      )}
      {showContent && (
        <>
          {item.images && item.images.length > 0 && (
            <div className="activity-images">
              {item.images.map((image, index) => (
                <img src={image.url} alt={image.name} key={`${image.name}:${index}`} />
              ))}
            </div>
          )}
          {item.attachments && item.attachments.length > 0 && (
            <div className="activity-attachments" aria-label="Attached files">
              {item.attachments.map((attachment, index) => (
                <span title={attachment.path} key={`${attachment.path}:${index}`}>
                  <FileText size={14} strokeWidth={1.6} />
                  <span>{attachment.name}</span>
                </span>
              ))}
            </div>
          )}
          {questionSession
            ? <AsyncQuestionRequest item={item} session={questionSession} />
            : displayedContent && (
            prose && markdown
              ? (
                  <WorkingShimmerContext.Provider value={activeTrace && visible}>
                    <BufferedMessageMarkdown
                      source={displayedContent}
                      stabilize={animating}
                      {...(codeBlock ? { codeBlock } : {})}
                    />
                  </WorkingShimmerContext.Provider>
                )
              : <pre className="activity-content">{displayedContent}</pre>
          )}
        </>
      )}
      {showMessageActions && (
        <div className="activity-message-actions">
          {item.timestamp && <span className="activity-message-timestamp">{item.timestamp}</span>}
          {copyable && messageSubject && (
            <MessageCopyButton content={content} subject={messageSubject} />
          )}
        </div>
      )}
    </article>
  )
}

const MemoizedActivityCard = memo(ActivityCard)

function ToolActivityGroup({
  items,
  markdown,
  activeTraceId,
  codeBlock,
  visible,
}: {
  items: ActivityItem[]
  markdown: boolean
  activeTraceId?: string | undefined
  codeBlock?: import('react').ComponentType<MarkdownCodeBlockProps> | undefined
  visible: boolean
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const titles = [...new Set(items.map((item) => item.title))]
  const groupActive = activeTraceId !== undefined
    && items.some((item) => item.id === activeTraceId)
  const label = titles.map((title, index) => (
    index === 0 ? title : `${title.charAt(0).toLowerCase()}${title.slice(1)}`
  )).join(', ')
  const identity = titles.join(' ').toLowerCase()
  const ToolIcon = identity.includes('search')
    ? Search
    : identity.includes('edit')
      ? Pencil
      : identity.includes('read')
        ? BookOpen
        : identity.includes('command')
          ? TerminalSquare
          : Wrench
  return (
    <section className="activity-tool-group">
      <button
        className="activity-tool-group-summary activity-working-trace"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ToolIcon size={14} />
        <WorkingShimmer
          className={`activity-tool-group-label${groupActive ? ' activity-active-trace' : ''}`}
          active={groupActive && visible}
        >
          {label}
        </WorkingShimmer>
        <ChevronRight className={expanded ? 'rotated' : ''} size={14} />
      </button>
      {expanded && (
        <div className="activity-tool-group-items">
          {items.map((item) => (
            <MemoizedActivityCard
              item={item}
              markdown={markdown}
              activeTrace={item.id === activeTraceId}
              codeBlock={codeBlock}
              visible={visible}
              key={item.id}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function sameToolActivityGroup(
  left: Parameters<typeof ToolActivityGroup>[0],
  right: Parameters<typeof ToolActivityGroup>[0],
): boolean {
  return left.markdown === right.markdown
    && left.activeTraceId === right.activeTraceId
    && left.codeBlock === right.codeBlock
    && left.visible === right.visible
    && sameActivityItems(left.items, right.items)
}

const MemoizedToolActivityGroup = memo(ToolActivityGroup, sameToolActivityGroup)

function WorkingDuration({ startedAt, visible }: { startedAt: number; visible: boolean }): ReactNode {
  const [elapsed, setElapsed] = useState(() => Math.max(1_000, Date.now() - startedAt))

  useEffect(() => {
    if (!visible) return
    const update = (): void => setElapsed(Math.max(1_000, Date.now() - startedAt))
    update()
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt, visible])

  return <>Working for {formatDuration(elapsed)}</>
}

function completedTurnFileChange(items: readonly ActivityItem[]): ActivityItem | undefined {
  const fileItems = items.filter((item) => item.kind === 'file' && item.files?.length)
  const first = fileItems[0]
  const last = fileItems.at(-1)
  if (!first || !last) return undefined
  const threadId = fileItems.findLast((item) => item.threadId)?.threadId
  const turnId = fileItems.findLast((item) => item.turnId)?.turnId

  return {
    id: `file-summary:${threadId ?? 'local'}:${turnId ?? first.id}`,
    kind: 'file',
    title: 'Files',
    content: '',
    status: 'completed',
    timestamp: last.timestamp,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    files: fileItems.flatMap((item) => item.files ?? []),
  }
}

function completedLogicalTurnFiles(
  turns: readonly ActivityItem[][],
  turnIndex: number,
): ActivityItem[] | undefined {
  const turn = turns[turnIndex]
  const hasFinalAnswer = turn?.some((item) => (
    item.kind === 'agent' && item.delivery !== 'async' && (item.phase === 'final_answer' || Boolean(item.durationMs))
  ))
  if (!turn || !hasFinalAnswer) return undefined

  let start = turnIndex
  while (start > 0) {
    if (turns[start]?.some((item) => item.kind === 'user' && !item.continuesTurn)) break
    const previous = turns[start - 1]
    if (previous?.some((item) => (
      item.kind === 'agent' && item.delivery !== 'async' && (item.phase === 'final_answer' || Boolean(item.durationMs))
    ))) break
    start -= 1
  }

  return turns.slice(start, turnIndex + 1).flatMap((segment) => (
    segment.filter((item) => item.kind === 'file')
  ))
}

function ActivityTurn({
  items,
  markdown,
  active,
  waitingFor,
  activeLabel,
  latest,
  codeBlock,
  reviewAction,
  session,
  completedFileItems,
  visible,
}: {
  items: ActivityItem[]
  markdown: boolean
  active: boolean
  waitingFor?: TurnIntervention | undefined
  activeLabel?: ReactNode
  latest: boolean
  codeBlock?: import('react').ComponentType<MarkdownCodeBlockProps> | undefined
  reviewAction?: ComponentType<FileReviewActionProps> | undefined
  session?: ClientSessionService | undefined
  completedFileItems?: ActivityItem[] | undefined
  visible: boolean
}): ReactNode {
  const phasedFinalAgents = items.filter((item) => (
    item.kind === 'agent' && item.delivery !== 'async' && item.phase === 'final_answer'
  ))
  const legacyFinalAgent = phasedFinalAgents.length === 0
    ? items.findLast((item) => item.kind === 'agent' && item.delivery !== 'async' && item.durationMs)
    : undefined
  const finalAgents = legacyFinalAgent ? [legacyFinalAgent] : phasedFinalAgents
  // A question can be the last thing an agent sends before the next prompt.
  // Until there is a separate final answer, its preceding prose is still the
  // response to read, even when the turn's tool and reasoning details fold.
  const preserveQuestionContext = phasedFinalAgents.length === 0 && items.some((item) => (
    item.kind === 'agent' && item.delivery === 'async' && item.questions?.length
  ))
  const finalAgentIds = new Set(finalAgents.map((item) => item.id))
  const finalAgent = finalAgents.at(-1)
  const completed = Boolean(finalAgent?.durationMs)
  const stopped = !active && finalAgents.length === 0 && !items.some((item) => item.delivery === 'async')
  const [expanded, setExpanded] = useState(active || latest || stopped)
  const previous = useRef({ active, latest })

  useLayoutEffect(() => {
    if (active || stopped) setExpanded(true)
    else if (previous.current.latest && !latest) {
      setExpanded(false)
    } else if (!previous.current.latest && latest && !stopped) {
      setExpanded(true)
    }
    previous.current = { active, latest }
  }, [active, latest, stopped])

  const prompts = items.filter((item) => item.kind === 'user' && !item.continuesTurn)
  const fallbackStartedAt = useRef(Date.now())
  const startedAt = prompts[0]?.createdAtMs ?? fallbackStartedAt.current
  // App Server identifies final answers when their item starts. Mount them in
  // their permanent lane immediately. Questions stay between the work that
  // preceded and followed them, even after their answers arrive or work folds.
  const sequence = items.filter((item) => (
    (item.kind !== 'user' || item.continuesTurn)
    && !(
      (item.kind === 'agent' || item.kind === 'reasoning')
      && !item.content.trim()
      && !item.images?.length
      && !item.questions?.length
    )
  ))
  const workSequence = sequence.filter((item) => !finalAgentIds.has(item.id))
  const finalSequence = sequence.filter((item) => finalAgentIds.has(item.id))
  const completedFileChange = active || !completedFileItems
    ? undefined
    : completedTurnFileChange(completedFileItems)
  // Split work at questions and user replies so collapsing the details never
  // changes their order or remounts a question's selected answer.
  const workSections: Array<
    | { kind: 'work'; items: ActivityItem[] }
    | { kind: 'question' | 'continuation'; item: ActivityItem }
  > = []
  for (const item of workSequence) {
    if (item.delivery === 'async' && item.questions?.length) {
      workSections.push({ kind: 'question', item })
    } else if (item.kind === 'user' && item.continuesTurn) {
      workSections.push({ kind: 'continuation', item })
    } else {
      const previousSection = workSections.at(-1)
      if (previousSection?.kind === 'work') previousSection.items.push(item)
      else workSections.push({ kind: 'work', items: [item] })
    }
  }
  const expandable = workSections.some((section) => section.kind === 'work')
  const working = active && !waitingFor
  const liveTrace = working
    ? workSequence.findLast((item) => (
        (item.kind === 'reasoning' || item.kind === 'command' || item.kind === 'tool')
        && (item.status === 'running' || item.status === 'streaming')
      ))
    : undefined
  // Tool completion and the next server event arrive separately. Keep the
  // newest work row active during that gap so the shimmer reflects the turn's
  // state instead of blinking off between events.
  const activeTrace = working
    ? liveTrace ?? workSequence.findLast((item) => (
        item.kind === 'reasoning' || item.kind === 'command' || item.kind === 'tool'
      ))
    : undefined
  const activeTraceId = activeTrace?.id
  const hasLiveTrace = activeTraceId !== undefined
  // Group boundaries depend only on arrival order. A running item may change
  // appearance, but completion never reparents it into a different row.
  const summary = completed && finalAgent?.durationMs
    ? `Worked for ${formatDuration(finalAgent.durationMs)}`
    : stopped
      ? 'Stopped'
      : 'Details'

  return (
    <section className={`activity-turn ${active ? 'activity-turn-running' : 'activity-turn-completed'}${latest ? ' activity-turn-latest' : ''}${stopped ? ' activity-turn-stopped' : ''}${hasLiveTrace ? ' activity-turn-live-trace' : ''}`}>
      {prompts.map((item) => <MemoizedActivityCard item={item} markdown={markdown} codeBlock={codeBlock} visible={visible} key={item.id} />)}
      <button
        className={`activity-turn-summary${active || !expandable ? ' activity-turn-summary-static' : ''}`}
        type="button"
        aria-expanded={expandable ? expanded : undefined}
        aria-disabled={active || !expandable}
        tabIndex={active || !expandable ? -1 : 0}
        onClick={() => {
          if (!active && expandable) setExpanded((value) => !value)
        }}
      >
        <span className="activity-turn-label">
          {active && activeLabel ? activeLabel : <span>{active
            ? waitingFor
              ? waitingFor === 'approval' ? 'Waiting for approval' : 'Waiting for your reply'
              : <WorkingDuration startedAt={startedAt} visible={visible} />
            : summary}</span>}
        </span>
        {!active && expandable && (
          <ChevronRight size={15} className={expanded ? 'rotated' : ''} />
        )}
      </button>
      {workSections.map((section) => section.kind === 'work'
        ? (expanded || preserveQuestionContext && section.items.some((item) => item.kind === 'agent')) && (
          <div className="activity-turn-work" key={`work:${section.items[0]!.id}`}>
            {groupToolActivities(section.items.filter((item) => expanded || item.kind === 'agent')).map((entry) => (
              entry.kind === 'tool-group'
                ? (
                    <MemoizedToolActivityGroup
                      items={entry.items}
                      markdown={markdown}
                      activeTraceId={activeTraceId}
                      codeBlock={codeBlock}
                      visible={visible}
                      key={`tool-group:${entry.items[0]?.id ?? 'empty'}`}
                    />
                  )
                : (
                    <MemoizedActivityCard
                      visible={visible}
                      item={entry.item}
                      markdown={markdown}
                      compact={entry.item.kind !== 'user'}
                      showMeta={false}
                      copyMessage={entry.item.kind === 'user' || entry.item.kind === 'agent'}
                      activeTrace={entry.item.id === activeTraceId}
                      codeBlock={codeBlock}
                      reviewAction={reviewAction}
                      session={session}
                      key={entry.item.id}
                    />
                  )
            ))}
          </div>
        )
        : (
          <div className={section.kind === 'question' ? 'activity-turn-final' : 'activity-turn-continuations'} key={section.item.id}>
            <MemoizedActivityCard
              visible={visible}
              item={section.item}
              markdown={markdown}
              compact={section.kind === 'question'}
              showMeta={false}
              copyMessage
              codeBlock={codeBlock}
              reviewAction={reviewAction}
              session={session}
            />
          </div>
        )
      )}
      {completedFileChange && (
        <div className="activity-turn-file-handoff">
          <FileChangeCard
            item={completedFileChange}
            codeBlock={codeBlock}
            reviewAction={reviewAction}
            session={session}
          />
        </div>
      )}
      {finalSequence.length > 0 && (
        <div className="activity-turn-final">
          {finalSequence.map((item) => (
            <MemoizedActivityCard
              visible={visible}
              item={item}
              markdown={markdown}
              compact
              showMeta={false}
              copyMessage
              codeBlock={codeBlock}
              reviewAction={reviewAction}
              session={session}
              key={item.id}
            />
          ))}
        </div>
      )}
    </section>
  )
}

const MemoizedActivityTurn = memo(ActivityTurn)

export function ActivityTimeline({
  items,
  markdown = true,
  active = false,
  waitingFor,
  activeLabel,
  windowKey = 'default',
  codeBlock,
  hasEarlier = false,
  loadingEarlier = false,
  loadEarlier,
  reviewAction,
  session,
  visible = true,
}: {
  items: ActivityItem[]
  markdown?: boolean
  active?: boolean
  waitingFor?: TurnIntervention | undefined
  activeLabel?: ReactNode
  windowKey?: string
  codeBlock?: import('react').ComponentType<MarkdownCodeBlockProps> | undefined
  hasEarlier?: boolean
  loadingEarlier?: boolean
  loadEarlier?: (() => Promise<void>) | undefined
  reviewAction?: ComponentType<FileReviewActionProps> | undefined
  session?: ClientSessionService | undefined
  visible?: boolean
}): ReactNode {
  const previousTurns = useRef<{ key: string; turns: ActivityItem[][] } | undefined>(undefined)
  const turns = useMemo(() => {
    const prior = previousTurns.current?.key === windowKey
      ? previousTurns.current.turns
      : []
    const next = activityTurns(withAsyncQuestionAnswers(items), prior)
    previousTurns.current = { key: windowKey, turns: next }
    return next
  }, [items, windowKey])
  const [window, setWindow] = useState(() => ({
    key: windowKey,
    visibleTurns: INITIAL_VISIBLE_TURNS,
  }))
  const visibleTurns = window.key === windowKey
    ? window.visibleTurns
    : INITIAL_VISIBLE_TURNS
  const start = Math.max(0, turns.length - visibleTurns)

  const showEarlier = async (): Promise<void> => {
    if (start === 0 && hasEarlier && loadEarlier) await loadEarlier()
    setWindow((current) => ({
      key: windowKey,
      visibleTurns: Math.max(
        current.key === windowKey ? current.visibleTurns : INITIAL_VISIBLE_TURNS,
        visibleTurns + EARLIER_TURN_BATCH,
      ),
    }))
  }

  useEffect(() => {
    const reveal = (event: Event): void => {
      const detail = (event as CustomEvent<{ activityId?: unknown }>).detail
      if (typeof detail?.activityId !== 'string') return
      const turnIndex = turns.findIndex((turn) => (
        turn.some((item) => item.id === detail.activityId)
      ))
      if (turnIndex < 0) return
      setWindow((current) => ({
        key: windowKey,
        visibleTurns: Math.max(
          current.key === windowKey ? current.visibleTurns : INITIAL_VISIBLE_TURNS,
          turns.length - turnIndex,
        ),
      }))
    }
    document.addEventListener(ACTIVITY_REVEAL_EVENT, reveal)
    return () => document.removeEventListener(ACTIVITY_REVEAL_EVENT, reveal)
  }, [turns, windowKey])

  return (
    <>
      {(start > 0 || hasEarlier) && (
        <button
          className="activity-history-window"
          type="button"
          disabled={loadingEarlier}
          onClick={() => void showEarlier()}
        >
          {loadingEarlier ? 'Loading earlier activity…' : 'Show earlier activity'}
        </button>
      )}
      {turns.slice(start).map((turn, offset) => {
        const index = start + offset
        return (
          <MemoizedActivityTurn
            items={turn}
            markdown={markdown}
            active={active && index === turns.length - 1}
            activeLabel={active && index === turns.length - 1 ? activeLabel : undefined}
            waitingFor={active && index === turns.length - 1 ? waitingFor : undefined}
            latest={index === turns.length - 1}
            codeBlock={codeBlock}
            reviewAction={reviewAction}
            session={session}
            completedFileItems={completedLogicalTurnFiles(turns, index)}
            visible={visible}
            key={turn[0]?.id}
          />
        )
      })}
    </>
  )
}
