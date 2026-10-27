import { Trash2 } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type {
  CodeViewLineSelection,
  DiffLineAnnotation,
  SelectedLineRange,
} from '@pierre/diffs'
import type {
  ClientDraft,
  ClientUiService,
} from '../../src/client/plugin-api.js'
import type { DiffReviewDocument } from './diff-viewer-api.js'
import type {
  ClientWorkspaceLayoutService,
  WorkspacePaneTarget,
} from './workspace-layout-api.js'

export interface ReviewComment {
  id: string
  itemId: string
  path: string
  side: 'deletions' | 'additions'
  start: number
  end: number
  body: string
  createdAt: string
}

export interface ReviewCommentDraft {
  selection: CodeViewLineSelection
  path: string
  body: string
}

function storageKey(documentId: string): string {
  return `alto.diff-review-comments.v1:${documentId}`
}

function parsedComments(value: unknown): ReviewComment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((comment) => {
    if (
      !comment
      || typeof comment !== 'object'
      || !('id' in comment) || typeof comment.id !== 'string'
      || !('itemId' in comment) || typeof comment.itemId !== 'string'
      || !('path' in comment) || typeof comment.path !== 'string'
      || !('side' in comment) || (comment.side !== 'deletions' && comment.side !== 'additions')
      || !('start' in comment) || typeof comment.start !== 'number'
      || !('end' in comment) || typeof comment.end !== 'number'
      || !('body' in comment) || typeof comment.body !== 'string'
      || !('createdAt' in comment) || typeof comment.createdAt !== 'string'
    ) return []
    return [{
      id: comment.id,
      itemId: comment.itemId,
      path: comment.path,
      side: comment.side,
      start: comment.start,
      end: comment.end,
      body: comment.body,
      createdAt: comment.createdAt,
    }]
  })
}

export function loadReviewComments(documentId: string): ReviewComment[] {
  try {
    return parsedComments(JSON.parse(localStorage.getItem(storageKey(documentId)) ?? '[]'))
  } catch {
    return []
  }
}

export function saveReviewComments(documentId: string, comments: readonly ReviewComment[]): void {
  try {
    localStorage.setItem(storageKey(documentId), JSON.stringify(comments))
  } catch {
    // The active review still works when browser storage is unavailable.
  }
}

export function reviewAnnotations(
  comments: readonly ReviewComment[],
  path: string,
): DiffLineAnnotation<ReviewComment>[] {
  return comments
    .filter((comment) => comment.path === path)
    .map((comment) => ({
      side: comment.side,
      lineNumber: comment.end,
      metadata: comment,
    }))
}

export function normalizedReviewRange(range: SelectedLineRange): {
  side: 'deletions' | 'additions'
  start: number
  end: number
} {
  return {
    side: range.side ?? range.endSide ?? 'additions',
    start: Math.max(1, Math.min(range.start, range.end)),
    end: Math.max(1, Math.max(range.start, range.end)),
  }
}

function lineLabel(comment: Pick<ReviewComment, 'side' | 'start' | 'end'>): string {
  const side = comment.side === 'additions' ? 'new' : 'old'
  return comment.start === comment.end
    ? `${side} line ${comment.start}`
    : `${side} lines ${comment.start}–${comment.end}`
}

export function reviewPrompt(comments: readonly ReviewComment[]): string {
  const details = comments.map((comment) => (
    `- \`${comment.path}:${comment.start}${comment.end === comment.start ? '' : `-${comment.end}`}\` (${lineLabel(comment)})\n  ${comment.body}`
  )).join('\n\n')
  return `Please address these code review comments:\n\n${details}`
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

function targetChat(
  layout: ClientWorkspaceLayoutService,
  document: DiffReviewDocument,
  workspaceId: string,
): WorkspacePaneTarget | undefined {
  const targets = layout.paneTargets()
  return targets.find((target) => target.session.snapshot().threadId === document.threadId)
    ?? targets.find((target) => target.workspaceId === workspaceId && target.focused)
    ?? targets.find((target) => target.workspaceId === workspaceId)
}

export async function sendReviewComments(
  ui: ClientUiService,
  layout: ClientWorkspaceLayoutService,
  document: DiffReviewDocument,
  workspaceId: string,
  comments: readonly ReviewComment[],
): Promise<void> {
  const target = targetChat(layout, document, workspaceId)
  if (!target) throw new Error('Open a chat in this workspace to send the review.')
  const draft: ClientDraft = {
    text: reviewPrompt(comments),
    images: [],
    attachments: [],
    skills: [],
  }
  await ui.submit(draft, () => target.session.send(draft), {
    mode: 'queue',
    target: submitTarget(target),
  })
  layout.focusPane(target.workspaceId, target.paneId)
}

export function ReviewAnnotation({
  comment,
  remove,
}: {
  comment: ReviewComment
  remove: (id: string) => void
}): ReactNode {
  return (
    <article className="diff-review-comment">
      <div>
        <span>{lineLabel(comment)}</span>
        <button type="button" aria-label="Remove review comment" title="Remove" onClick={() => remove(comment.id)}>
          <Trash2 size={13} strokeWidth={1.7} />
        </button>
      </div>
      <p>{comment.body}</p>
    </article>
  )
}

export function ReviewCommentComposer({
  draft,
  cancel,
  add,
}: {
  draft: ReviewCommentDraft
  cancel: () => void
  add: (body: string) => void
}): ReactNode {
  const input = useRef<HTMLTextAreaElement>(null)
  const [body, setBody] = useState(draft.body)
  useEffect(() => {
    setBody(draft.body)
    input.current?.focus({ preventScroll: true })
  }, [draft.body, draft.selection])
  const range = normalizedReviewRange(draft.selection.range)
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      add(body)
    }
  }
  return (
    <section className="diff-review-draft">
      <div className="diff-review-draft-heading">
        <span>{draft.path}</span>
        <span>{lineLabel(range)}</span>
      </div>
      <textarea
        ref={input}
        value={body}
        rows={3}
        placeholder="Leave a review comment…"
        aria-label="Review comment"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={keyDown}
      />
      <div className="diff-review-draft-actions">
        <button type="button" onClick={cancel}>Cancel</button>
        <button className="primary" type="button" disabled={!body.trim()} onClick={() => add(body)}>Add comment</button>
      </div>
    </section>
  )
}
