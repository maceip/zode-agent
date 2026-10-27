import { commandTitle, toolTitle } from '../app-server-format.js'
import { readUserMessage } from '../../../src/shared/user-message.js'
import type { RpcNotification } from '../../../src/shared/protocol.js'
import { agentMessageMetadata, fileChangeKind, isRecord } from '../../../src/shared/protocol.js'
import { now, pretty, recordAt, stringValue } from './values.js'
import { activityScope, canonicalActivityId, mergeTranscriptActivity, type ActivityItem, type FileChangeEntry } from './transcript.js'
export type { ActivityItem, FileChangeEntry } from './transcript.js'

export interface FileChangeSummary {
  path: string
  additions: number
  deletions: number
  changes: FileChangeEntry[]
}

function lineChanges(diff: string, kind: ReturnType<typeof fileChangeKind>): { additions: number; deletions: number } {
  const contentLines = diff ? diff.replace(/\n$/u, '').split('\n').length : 0
  if (kind === 'add') return { additions: contentLines, deletions: 0 }
  if (kind === 'delete') return { additions: 0, deletions: contentLines }
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

export function fileChanges(value: unknown): FileChangeEntry[] {
  if (!isRecord(value) || !Array.isArray(value.changes)) return []
  return value.changes.flatMap((change) => {
    if (!isRecord(change) || typeof change.path !== 'string') return []
    const diff = typeof change.diff === 'string' ? change.diff : ''
    const kind = fileChangeKind(change.kind)
    return [{
      path: change.path,
      kind,
      diff,
      ...lineChanges(diff, kind),
    }]
  })
}

export function summarizeFileChanges(files: readonly FileChangeEntry[]): FileChangeSummary[] {
  const summaries = new Map<string, FileChangeSummary>()
  for (const file of files) {
    const current = summaries.get(file.path)
    if (current) {
      current.additions += file.additions
      current.deletions += file.deletions
      current.changes.push(file)
      continue
    }
    summaries.set(file.path, {
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      changes: [file],
    })
  }
  return [...summaries.values()]
}

function messagePhase(item: Record<string, unknown> | undefined): ActivityItem['phase'] {
  return item?.phase === 'commentary' || item?.phase === 'final_answer'
    ? item.phase
    : undefined
}

function reasoningSummary(item: Record<string, unknown>): string {
  return Array.isArray(item.summary)
    ? item.summary.filter((part): part is string => typeof part === 'string').join('\n\n')
    : ''
}

export function activityFrom(notification: RpcNotification): ActivityItem | undefined {
  const params = notification.params ?? {}
  const item = recordAt(params, 'item')
  const itemId = stringValue(params.itemId) ?? stringValue(item?.id)
  const itemType = stringValue(item?.type)
  const timestamp = now()
  const scope = activityScope(params, itemId)
  const identity = (kind: ActivityItem['kind'], fallback = 'current'): string => (
    canonicalActivityId(kind, scope, fallback)
  )
  const scoped = {
    ...(scope.threadId ? { threadId: scope.threadId } : {}),
    ...(scope.turnId ? { turnId: scope.turnId } : {}),
    ...(scope.itemId ? { itemId: scope.itemId } : {}),
  }

  if (
    notification.method === 'turn/started'
    || notification.method === 'turn/completed'
    || notification.method === 'item/reasoning/textDelta'
  ) return undefined

  if (itemType === 'userMessage' && (notification.method === 'item/started' || notification.method === 'item/completed')) {
    const message = readUserMessage(item)
    if (!message) return undefined
    return {
      id: identity('user'),
      ...scoped,
      kind: 'user',
      title: 'You',
      content: message.text,
      ...(message.input ? { input: message.input } : {}),
      ...(message.images ? { images: message.images } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
      timestamp,
    }
  }

  if (notification.method === 'thread/compacted') {
    return {
      id: identity('status', `compaction:${scope.turnId ?? timestamp}`),
      ...scoped,
      kind: 'status',
      title: 'Context automatically compacted',
      content: '',
      status: 'completed',
      timestamp,
    }
  }

  if (notification.method === 'item/reasoning/summaryPartAdded') {
    return {
      id: identity('reasoning'),
      ...scoped,
      kind: 'reasoning',
      title: 'Thinking',
      content: typeof params.summaryIndex === 'number' && params.summaryIndex > 0 ? '\n\n' : '',
      contentUpdate: 'append',
      status: 'streaming',
      timestamp,
    }
  }

  if (notification.method === 'item/reasoning/summaryTextDelta') {
    return {
      id: identity('reasoning'),
      ...scoped,
      kind: 'reasoning',
      title: 'Thinking',
      content: stringValue(params.delta) ?? '',
      contentUpdate: 'append',
      status: 'streaming',
      timestamp,
    }
  }

  if (notification.method === 'item/agentMessage/delta') {
    return {
      id: identity('agent'),
      ...scoped,
      kind: 'agent',
      title: 'Codex',
      content: stringValue(params.delta) ?? '',
      contentUpdate: 'append',
      status: 'streaming',
      timestamp,
    }
  }

  if (notification.method === 'item/commandExecution/outputDelta') {
    return {
      id: identity('command'),
      ...scoped,
      kind: 'command',
      title: 'Command output',
      content: stringValue(params.delta) ?? '',
      contentUpdate: 'append',
      status: 'running',
      timestamp,
    }
  }

  if (notification.method === 'item/fileChange/patchUpdated') {
    return {
      id: identity('file'),
      ...scoped,
      kind: 'file',
      title: 'Files',
      content: '',
      status: 'running',
      timestamp,
      files: fileChanges(params),
    }
  }

  if (notification.method === 'item/started' && item) {
    if (itemType === 'agentMessage') {
      const phase = messagePhase(item)
      return {
        id: identity('agent'),
        ...scoped,
        kind: 'agent',
        title: 'Codex',
        content: stringValue(item.text) ?? '',
        contentUpdate: 'replace',
        status: 'streaming',
        timestamp,
        ...(phase ? { phase } : {}),
        ...agentMessageMetadata(item),
      }
    }
    if (itemType === 'reasoning') {
      return {
        id: identity('reasoning'),
        ...scoped,
        kind: 'reasoning',
        title: 'Thinking',
        content: reasoningSummary(item),
        status: 'running',
        timestamp,
      }
    }
    if (itemType === 'contextCompaction') {
      return {
        id: identity('status', String(Date.now())),
        ...scoped,
        kind: 'status',
        title: 'Context automatically compacted',
        content: '',
        status: 'running',
        timestamp,
      }
    }
    const kind = itemType === 'commandExecution'
      ? 'command'
      : itemType === 'fileChange'
        ? 'file'
        : 'tool'
    return {
      id: identity(kind, String(Date.now())),
      ...scoped,
      kind,
      title: itemType === 'commandExecution'
        ? commandTitle(item)
        : itemType === 'fileChange'
          ? 'Files'
          : toolTitle(item),
      content: item.command ? pretty(item.command) : pretty(item),
      status: 'running',
      timestamp,
      ...(kind === 'file' ? { files: fileChanges(item) } : {}),
    }
  }

  if (notification.method !== 'item/completed' || !item) return undefined
  if (itemType === 'reasoning') {
    const content = reasoningSummary(item)
    if (!content) return undefined
    return {
      id: identity('reasoning', String(Date.now())),
      ...scoped,
      kind: 'reasoning',
      title: 'Thinking',
      content,
      status: 'completed',
      timestamp,
    }
  }
  if (itemType === 'contextCompaction') {
    return {
      id: identity('status', String(Date.now())),
      ...scoped,
      kind: 'status',
      title: 'Context automatically compacted',
      content: '',
      status: 'completed',
      timestamp,
    }
  }

  const kind = itemType === 'agentMessage'
    ? 'agent'
    : itemType === 'commandExecution'
      ? 'command'
      : itemType === 'fileChange'
        ? 'file'
        : 'tool'
  const content = stringValue(item.text)
    ?? stringValue(item.aggregatedOutput)
    ?? (Array.isArray(item.content)
      ? item.content.flatMap((part) => isRecord(part) && typeof part.text === 'string' ? [part.text] : []).join('\n')
      : undefined)
    ?? pretty(item)
  const phase = kind === 'agent' ? messagePhase(item) : undefined
  return {
    id: identity(kind, String(Date.now())),
    ...scoped,
    kind,
    title: kind === 'agent'
      ? 'Codex'
      : kind === 'command'
        ? commandTitle(item)
        : kind === 'file'
          ? 'Files'
          : toolTitle(item),
    content,
    status: stringValue(item.status) ?? 'completed',
    timestamp,
    ...(phase ? { phase } : {}),
    ...(kind === 'agent' ? agentMessageMetadata(item) : {}),
    ...(kind === 'file' ? { files: fileChanges(item) } : {}),
  }
}

export function mergeActivity(items: ActivityItem[], incoming: ActivityItem): ActivityItem[] {
  return mergeTranscriptActivity(items, incoming)
}

export function completeLatestTurn(items: ActivityItem[], durationMs: number): ActivityItem[] {
  if (!durationMs) return items
  const phasedIndex = items.findLastIndex((item) => (
    item.kind === 'agent' && item.delivery !== 'async' && item.phase === 'final_answer'
  ))
  const index = phasedIndex >= 0
    ? phasedIndex
    : items.findLastIndex((item) => item.kind === 'agent' && item.delivery !== 'async')
  if (index < 0) return items
  const next = items.map((item, itemIndex) => (
    itemIndex === index ? { ...item, durationMs } : item
  ))
  return next
}
