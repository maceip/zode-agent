import { readUserMessage } from '../../shared/user-message.js'
import type {
  ThreadFileChange,
  ThreadGitInfo,
  ThreadMessage,
  ThreadRuntimeStatus,
  ThreadSummary,
  ThreadTrace,
  ThreadView,
} from '../../shared/protocol.js'
import { agentMessageMetadata, fileChangeKind, isRecord } from '../../shared/protocol.js'

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function title(name: string | undefined): string {
  return name ?? 'Untitled conversation'
}

function gitInfo(value: unknown): ThreadGitInfo | undefined {
  if (!isRecord(value)) return undefined
  const branch = text(value.branch)
  const sha = text(value.sha)
  const originUrl = text(value.originUrl)
  return branch || sha || originUrl
    ? {
        ...(branch ? { branch } : {}),
        ...(sha ? { sha } : {}),
        ...(originUrl ? { originUrl } : {}),
      }
    : undefined
}

export function readThreadRuntimeStatus(value: unknown): ThreadRuntimeStatus | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  const activeFlags = Array.isArray(value.activeFlags)
    ? value.activeFlags.filter((flag): flag is string => typeof flag === 'string')
    : []
  return {
    type: value.type,
    ...(activeFlags.length ? { activeFlags } : {}),
  }
}

export function readThreadSummary(value: unknown): ThreadSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined
  const preview = text(value.preview) ?? ''
  const git = gitInfo(value.gitInfo)
  const status = readThreadRuntimeStatus(value.status)
  const projectId = text(value.projectId)
  const modelProvider = text(value.modelProvider)
  const updatedAt = timestamp(value.updatedAt) || timestamp(value.recencyAt)
  const recencyAt = timestamp(value.recencyAt) || updatedAt
  return {
    id: value.id,
    title: title(text(value.name)),
    preview,
    cwd: text(value.cwd) ?? '',
    createdAt: timestamp(value.createdAt),
    updatedAt,
    ...(recencyAt ? { recencyAt } : {}),
    ...(projectId ? { projectRef: { source: 'codex-app', id: projectId } } : {}),
    ...(git ? { gitInfo: git } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(status ? { status } : {}),
    ...(typeof value.canAcceptDirectInput === 'boolean'
      ? { canAcceptDirectInput: value.canAcceptDirectInput }
      : {}),
  }
}

function message(item: unknown, createdAt: number, id: string): ThreadMessage | undefined {
  if (!isRecord(item)) return undefined
  const time = createdAt > 0 ? { createdAt } : {}

  if (item.type === 'agentMessage' && typeof item.text === 'string' && (item.text.trim() || agentMessageMetadata(item).questions?.length)) {
    const phase: ThreadMessage['phase'] = item.phase === 'commentary' || item.phase === 'final_answer'
      ? item.phase
      : undefined
    return { id, role: 'agent', text: item.text, ...(phase ? { phase } : {}), ...agentMessageMetadata(item), ...time }
  }
  const user = readUserMessage(item)
  return user ? { id, role: 'user', ...user, ...time } : undefined
}

function commandTitle(item: Record<string, unknown>): string {
  const actionTypes = Array.isArray(item.commandActions)
    ? item.commandActions.flatMap((action) => (
        isRecord(action) && typeof action.type === 'string' ? [action.type] : []
      ))
    : []
  if (actionTypes.length > 0 && actionTypes.every((type) => type === 'read' || type === 'listFiles')) {
    return 'Read files'
  }
  if (actionTypes.includes('search')) return 'Searched files'
  return 'Ran a command'
}

function toolTitle(item: Record<string, unknown>): string {
  const tool = text(item.tool) ?? text(item.type) ?? 'tool'
  const identity = `${text(item.server) ?? ''} ${tool}`.toLowerCase()
  if (identity.includes('browser') || identity.includes('node_repl')) return 'Used the browser'
  if (identity.includes('apply_patch') || identity.includes('write_file') || identity.includes('edit')) return 'Edited a file'
  if (identity.includes('read_file') || identity.includes('read_mcp')) return 'Read files'
  if (identity.includes('view_image') || identity.includes('imageview')) return 'Viewed an image'
  if (identity.includes('exec_command') || identity.includes('write_stdin')) return 'Ran a command'
  if (item.type === 'webSearch') return 'Searched the web'
  return `Used ${tool.replace(/^mcp__/, '').replaceAll('_', ' ')}`
}

function trace(item: unknown, id: string): ThreadTrace | undefined {
  if (!isRecord(item) || typeof item.type !== 'string') return undefined
  if (item.type === 'reasoning') {
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((part): part is string => typeof part === 'string').join('\n\n')
      : ''
    return { id, kind: 'reasoning', title: 'Thinking', text: summary, status: 'completed' }
  }
  if (item.type === 'commandExecution') {
    return {
      id,
      kind: 'command',
      title: commandTitle(item),
      text: text(item.aggregatedOutput) ?? text(item.command) ?? '',
      status: text(item.status) ?? 'completed',
    }
  }
  if (item.type === 'contextCompaction') {
    return {
      id,
      kind: 'status',
      title: 'Context automatically compacted',
      text: '',
      status: 'completed',
    }
  }
  if (item.type === 'userMessage' || item.type === 'agentMessage' || item.type === 'fileChange') {
    return undefined
  }
  return {
    id,
    kind: 'tool',
    title: toolTitle(item),
    text: '',
    status: text(item.status) ?? 'completed',
  }
}

function fileChanges(item: unknown): ThreadFileChange[] {
  if (!isRecord(item) || item.type !== 'fileChange' || !Array.isArray(item.changes)) return []
  return item.changes.flatMap((change) => {
    if (!isRecord(change) || typeof change.path !== 'string') return []
    return [{
      path: change.path,
      kind: fileChangeKind(change.kind),
      diff: typeof change.diff === 'string' ? change.diff : '',
    }]
  })
}

function turnDuration(turn: Record<string, unknown>): number {
  const durationMs = timestamp(turn.durationMs)
  if (durationMs) return durationMs
  const startedAt = timestamp(turn.startedAt)
  const completedAt = timestamp(turn.completedAt)
  return completedAt > startedAt ? (completedAt - startedAt) * 1_000 : 0
}

export function readThreadView(value: unknown): ThreadView {
  const summary = readThreadSummary(value)
  if (!summary) throw new Error('codex app-server returned an invalid thread')

  const turns = isRecord(value) && Array.isArray(value.turns) ? value.turns : []
  return { summary, messages: readThreadMessages(summary.id, turns) }
}

export function readThreadMessages(threadId: string, turns: unknown[]): ThreadMessage[] {
  return turns.flatMap((turn, turnIndex) => {
    if (!isRecord(turn) || !Array.isArray(turn.items)) return []
    const createdAt = timestamp(turn.startedAt)
    const turnId = typeof turn.id === 'string'
      ? turn.id
      : `${createdAt || timestamp(turn.completedAt) || 'turn'}:${turnIndex}`
    const durationMs = turnDuration(turn)
    const changes = turn.items.flatMap(fileChanges)
    const entries: ThreadMessage[] = []
    let pendingTraces: ThreadTrace[] = []
    let sawUserMessage = false
    turn.items.forEach((item, itemIndex) => {
      const rawItemId = isRecord(item) && typeof item.id === 'string' ? item.id : String(itemIndex)
      // App-server item IDs are only guaranteed within one turn. Qualifying
      // them prevents older turns and paginated history from colliding in the
      // browser activity projection.
      const itemId = `${threadId}:${turnId}:${rawItemId}`
      const entry = message(item, createdAt, itemId)
      if (entry) {
        const continuesTurn = entry.role === 'user' && sawUserMessage
        if (entry.role === 'user') sawUserMessage = true
        entries.push({
          ...entry,
          ...(continuesTurn ? { continuesTurn: true } : {}),
          ...(pendingTraces.length ? { tracesBefore: pendingTraces } : {}),
        })
        pendingTraces = []
        return
      }
      const work = trace(item, itemId)
      if (work) pendingTraces.push(work)
    })
    const phasedAgent = entries.findLastIndex((entry) => (
      entry.role === 'agent' && entry.delivery !== 'async' && entry.phase === 'final_answer'
    ))
    const lastAgent = phasedAgent >= 0
      ? phasedAgent
      : entries.findLastIndex((entry) => entry.role === 'agent' && entry.delivery !== 'async')
    const traceAnchor = lastAgent >= 0 ? lastAgent : entries.findLastIndex((entry) => entry.role === 'agent')
    if (traceAnchor < 0) return entries
    if (pendingTraces.length) {
      const agent = entries[traceAnchor]
      if (agent) {
        entries[traceAnchor] = {
          ...agent,
          tracesAfter: [...(agent.tracesAfter ?? []), ...pendingTraces],
        }
      }
    }
    return entries.map((entry, index) => (
      index === lastAgent
        ? {
            ...entry,
            ...(durationMs ? { durationMs } : {}),
            ...(changes.length ? { fileChanges: changes } : {}),
          }
        : entry
    ))
  })
}
