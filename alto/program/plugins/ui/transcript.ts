import type {
  AsyncUserInputQuestion,
  ChatAttachment,
  ChatImage,
  RpcNotification,
  TurnInput,
} from '../../../src/shared/protocol.js'
import type { ChatFileChange } from '../chat-surfaces-api.js'

export type FileChangeEntry = ChatFileChange

export interface ActivityItem {
  id: string
  threadId?: string
  turnId?: string
  itemId?: string
  kind: 'user' | 'agent' | 'reasoning' | 'command' | 'tool' | 'file' | 'status'
  title: string
  content: string
  input?: TurnInput[]
  images?: ChatImage[]
  attachments?: ChatAttachment[]
  status?: string
  timestamp: string
  createdAtMs?: number
  durationMs?: number
  continuesTurn?: boolean
  phase?: 'commentary' | 'final_answer'
  delivery?: 'async'
  questions?: AsyncUserInputQuestion[]
  questionAnswers?: string[]
  files?: FileChangeEntry[]
  contentUpdate?: 'append' | 'replace'
}

const transcriptIndices = new WeakMap<readonly ActivityItem[], ReadonlyMap<string, number>>()

function transcriptIndex(items: readonly ActivityItem[]): ReadonlyMap<string, number> {
  const cached = transcriptIndices.get(items)
  if (cached) return cached
  const index = new Map(items.map((item, itemIndex) => [item.id, itemIndex]))
  transcriptIndices.set(items, index)
  return index
}

export interface ActivityScope {
  threadId?: string
  turnId?: string
  itemId?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * App Server item IDs are unique only within a turn. The transcript uses one
 * qualified identity for live notifications, cached rows, and replayed
 * history so a row can be updated without being removed and mounted again.
 */
export function activityScope(
  params: RpcNotification['params'],
  itemId?: string,
): ActivityScope {
  const turn = record(params?.turn)
  const item = record(params?.item)
  const threadId = string(params?.threadId) ?? string(turn?.threadId)
  const turnId = string(params?.turnId) ?? string(turn?.id)
  const rawItemId = itemId ?? string(params?.itemId) ?? string(item?.id)
  return {
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(rawItemId ? { itemId: rawItemId } : {}),
  }
}

export function canonicalActivityId(
  kind: ActivityItem['kind'],
  scope: ActivityScope,
  fallback = 'current',
): string {
  const rawItemId = scope.itemId ?? fallback
  const qualified = scope.threadId && scope.turnId
    ? `${scope.threadId}:${scope.turnId}:${rawItemId}`
    : rawItemId
  return `${kind}:${qualified}`
}

function interrupted(status: string | undefined): boolean {
  return Boolean(status && /interrupt|cancel/u.test(status))
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

function sameTurn(left: ActivityItem, right: ActivityItem): boolean {
  if (!right.turnId) return false
  if (left.threadId && right.threadId && left.threadId !== right.threadId) return false
  return left.turnId === right.turnId || Boolean(right.threadId
    && left.id.startsWith(`${left.kind}:${right.threadId}:${right.turnId}:`))
}

function pendingUserMatches(pending: ActivityItem, incoming: ActivityItem): boolean {
  return pending.kind === 'user' && pending.id.startsWith('user:local:')
    && (!pending.threadId || !incoming.threadId || pending.threadId === incoming.threadId)
    && (!pending.turnId || !incoming.turnId || pending.turnId === incoming.turnId)
    && pending.content.trim() === incoming.content.trim()
    && sameStructuredValue((pending.images ?? []).map((image) => image.url), (incoming.images ?? []).map((image) => image.url))
    && sameStructuredValue((pending.attachments ?? []).map((file) => file.path), (incoming.attachments ?? []).map((file) => file.path))
}

function sameTranscriptActivity(left: ActivityItem, right: ActivityItem): boolean {
  return left.id === right.id
    && left.threadId === right.threadId
    && left.turnId === right.turnId
    && left.itemId === right.itemId
    && left.kind === right.kind
    && left.title === right.title
    && left.content === right.content
    && sameStructuredValue(left.input, right.input)
    && sameStructuredValue(left.images, right.images)
    && sameStructuredValue(left.attachments, right.attachments)
    && left.status === right.status
    && left.timestamp === right.timestamp
    && left.createdAtMs === right.createdAtMs
    && left.durationMs === right.durationMs
    && left.continuesTurn === right.continuesTurn
    && left.phase === right.phase
    && left.delivery === right.delivery
    && sameStructuredValue(left.questions, right.questions)
    && sameStructuredValue(left.questionAnswers, right.questionAnswers)
    && sameStructuredValue(left.files, right.files)
}

/**
 * Applies one item mutation without changing its position in the transcript.
 * Completed snapshots are authoritative. Interrupted snapshots are the one
 * exception: App Server can return a truncated prefix after the user stops a
 * turn, and text already shown to the user must remain in the transcript.
 */
export function mergeTranscriptActivity(
  items: ActivityItem[],
  incoming: ActivityItem,
): ActivityItem[] {
  const { contentUpdate = 'replace', ...activity } = incoming
  let index = transcriptIndex(items).get(activity.id) ?? -1
  if (index < 0 && activity.kind === 'user' && activity.itemId) {
    // A local send is already visible before its native userMessage arrives.
    // Acknowledge one pending row; identical messages with native IDs remain
    // separate submissions, even when sent within the same turn.
    index = items.findIndex((item) => pendingUserMatches(item, activity) && sameTurn(item, activity))
    if (index < 0) index = items.findLastIndex((item) => pendingUserMatches(item, activity) && !item.turnId)
  }
  if (index < 0) {
    if (activity.kind === 'user') {
      const continuesTurn = items.some((item) => item.kind === 'user' && sameTurn(item, activity))
      if (continuesTurn) activity.continuesTurn = true
      else {
        // A recovered turn snapshot may deliver the prompt after its output.
        const first = items.findIndex((item) => sameTurn(item, activity))
        if (first >= 0) return [...items.slice(0, first), activity, ...items.slice(first)]
      }
    }
    const next = [...items, activity]
    const nextIndex = new Map(transcriptIndex(items))
    nextIndex.set(activity.id, items.length)
    transcriptIndices.set(next, nextIndex)
    return next
  }

  const previous = items[index]
  if (!previous) return items
  const replacement = interrupted(activity.status)
    && previous.content.startsWith(activity.content)
    && previous.content.length > activity.content.length
      ? previous.content
      : activity.content
  const nextItem: ActivityItem = {
    ...previous,
    ...activity,
    title: contentUpdate === 'append' && previous.title ? previous.title : activity.title,
    timestamp: previous.timestamp || activity.timestamp,
    ...(previous.createdAtMs !== undefined ? { createdAtMs: previous.createdAtMs } : {}),
    content: contentUpdate === 'append'
      ? `${previous.content}${activity.content}`
      : replacement,
  }
  if (sameTranscriptActivity(previous, nextItem)) return items
  const next = [...items]
  next[index] = nextItem
  if (previous.id === nextItem.id) transcriptIndices.set(next, transcriptIndex(items))
  return next
}

/** Attach an optimistic prompt to the server turn that accepted it. */
export function bindPendingTurn(
  items: ActivityItem[],
  scope: Pick<ActivityScope, 'threadId' | 'turnId'>,
): ActivityItem[] {
  if (!scope.turnId) return items
  const turnId = scope.turnId
  const start = items.findLastIndex((item) => item.kind === 'user' && !item.continuesTurn)
  if (start < 0 || !items[start]?.id.startsWith('user:local:') || items[start]?.turnId) return items
  let changed = false
  const next = items.map((item, index) => {
    if (index < start || item.turnId) return item
    changed = true
    return {
      ...item,
      turnId,
      ...(scope.threadId ? { threadId: scope.threadId } : {}),
    }
  })
  return changed ? next : items
}

export function settleTranscriptTurn(
  items: ActivityItem[],
  turnId: string | undefined,
  status: string,
): ActivityItem[] {
  let changed = false
  const next = items.map((item) => {
    if (
      (turnId && item.turnId !== turnId)
      || (item.status !== 'running' && item.status !== 'streaming')
    ) return item
    changed = true
    return { ...item, status }
  })
  return changed ? next : items
}

function unsettled(item: ActivityItem): boolean {
  return item.status === 'running' || item.status === 'streaming'
}

/**
 * Reconciles replayed history with rows already on screen. Equal rows retain
 * their object identity, while active rows missing from a stale replay remain
 * appended until the server provides a settled snapshot.
 */
export function reconcileTranscriptSnapshot(
  current: ActivityItem[],
  replayed: ActivityItem[],
  preserveUnsettled = false,
): ActivityItem[] {
  const currentById = new Map(current.map((item) => [item.id, item]))
  const replayedIds = new Set(replayed.map((item) => item.id))
  const next = replayed.map((item) => {
    const previous = currentById.get(item.id)
    return previous && JSON.stringify(previous) === JSON.stringify(item) ? previous : item
  })
  if (preserveUnsettled) {
    next.push(...current.filter((item) => !replayedIds.has(item.id) && unsettled(item)))
  }
  if (next.length === current.length && next.every((item, index) => item === current[index])) {
    return current
  }
  return next
}
