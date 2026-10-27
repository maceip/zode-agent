import { randomUUID } from 'node:crypto'
import { createPatch, diffLines } from 'diff'
import type { AgentEvent } from '../../src/server/services/agent-registry.js'
import type { AgentChat } from './agent-chats-api.js'
import { taskActive } from './orchestrator-api.js'
import { mergeActivity } from './ui/activity-model.js'

// ACP text has no end event. A segment is finished once any other item follows
// it; leaving it streaming would keep it the turn's live trace.
function finishTextSegments(chat: Pick<AgentChat, 'activities'>, currentId?: string): void {
  for (const item of chat.activities) {
    if ((item.kind === 'agent' || item.kind === 'reasoning') && item.status === 'streaming' && item.id !== currentId) item.status = 'completed'
  }
}

// Root and child sessions share transcript formatting, but never share turn or
// queue state. A child event must not complete its parent's turn.
function applyTranscriptEvent(chat: Pick<AgentChat, 'activities'>, event: AgentEvent, threadId: string, sessionTurnId?: string): boolean {
  const turnId = 'turnId' in event ? event.turnId ?? sessionTurnId : sessionTurnId
  const base = { threadId, ...(turnId ? { turnId } : {}),
    timestamp: new Date(event.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    createdAtMs: Date.parse(event.occurredAt) }
  if (event.type === 'message.delta' && event.role !== 'user' && event.content.type === 'text') {
    const kind = event.role === 'thought' ? 'reasoning' : 'agent'
    // Most ACP agents omit message IDs; separate text on either side of a tool call.
    const last = chat.activities.at(-1)
    const id = event.messageId ? `${kind}:${turnId}:${event.messageId}`
      : last?.kind === kind && last.turnId === turnId ? last.id : `${kind}:${randomUUID()}`
    finishTextSegments(chat, id)
    chat.activities = mergeActivity(chat.activities, { ...base, id, kind, title: kind === 'agent' ? 'Assistant' : 'Thinking',
      content: event.content.text, contentUpdate: 'append', status: 'streaming' })
  } else if (event.type === 'message.delta' && event.role === 'user') {
    finishTextSegments(chat)
    const part = event.content
    const id = event.messageId ? `user:${event.messageId}` : `user:${randomUUID()}`
    chat.activities = mergeActivity(chat.activities, { ...base, id, kind: 'user', title: 'You',
      content: part.type === 'text' ? part.text : part.type === 'resource' ? `[${part.name.replaceAll(']', '')}](${part.uri})` : '',
      contentUpdate: 'append', ...(part.type === 'image' ? { images: [{ name: 'Image', mediaType: part.mimeType, url: `data:${part.mimeType};base64,${part.data}` }] } : {}) })
  } else if (event.type === 'message.delta' && event.role === 'agent') {
    const part = event.content
    finishTextSegments(chat)
    chat.activities.push({ ...base, id: `agent:${randomUUID()}`, kind: 'agent', title: 'Assistant',
      content: part.type === 'resource' ? `[${part.name.replaceAll(']', '')}](${part.uri})` : '',
      ...(part.type === 'image' ? { images: [{ name: 'Agent image', mediaType: part.mimeType, url: `data:${part.mimeType};base64,${part.data}` }] } : {}) })
  } else if (event.type === 'tool.started' || event.type === 'tool.updated') {
    const id = `tool:${turnId}:${event.toolCallId}`
    const previous = chat.activities.find((item) => item.id === id)
    if (!previous) finishTextSegments(chat)
    const files = event.patches?.length ? event.patches.map((file) => ({ ...file,
      additions: file.diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deletions: file.diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
    })) : event.files?.length ? event.files.map((file) => {
      const chunks = diffLines(file.oldText ?? '', file.newText)
      return { path: file.path, kind: file.oldText === null ? 'add' : 'update',
        diff: createPatch(file.path, file.oldText ?? '', file.newText),
        additions: chunks.reduce((sum, chunk) => sum + (chunk.added ? chunk.count : 0), 0),
        deletions: chunks.reduce((sum, chunk) => sum + (chunk.removed ? chunk.count : 0), 0) }
    }) : previous?.files
    chat.activities = mergeActivity(chat.activities, { ...base, id, kind: files?.length ? 'file' : event.kind === 'execute' ? 'command' : previous?.kind ?? 'tool', title: event.title,
      ...(files ? { files } : {}),
      content: event.content ?? previous?.content ?? '', contentUpdate: 'replace', status: event.status ?? previous?.status ?? 'in_progress' })
  } else if (event.type === 'plan.updated') {
    chat.activities = mergeActivity(chat.activities, { ...base, id: `plan:${turnId}`, kind: 'status', title: 'Plan',
      content: event.entries.map((entry) => `${entry.status === 'completed' ? '✓' : '•'} ${entry.content}`).join('\n'), contentUpdate: 'replace' })
  } else return false
  return true
}

function endRemoteSession(chat: AgentChat): void {
  chat.turn = 'idle'
  chat.requests = []
  chat.queuePaused = true
  chat.problem = chat.remote?.message ?? 'The remote agent exited'
  const endedAt = Date.now()
  for (const child of chat.children ?? []) {
    if (!taskActive(child.task)) continue
    child.task.status = 'stopped'
    child.task.updatedAt = endedAt
    child.task.finishedAt = endedAt
    for (const item of child.activities) if (item.status === 'streaming' || item.status === 'in_progress') item.status = 'interrupted'
  }
  for (const item of chat.activities) if (item.status === 'streaming' || item.status === 'in_progress') item.status = 'interrupted'
}

/** Apply provider state without dispatching prompts or writing files. */
export function applyAgentChatEvent(chat: AgentChat, event: AgentEvent): boolean {
  if (!('sessionId' in event)) return false
  if (event.type === 'connection.changed') {
    chat.remote = { ...chat.remote, state: event.state }; delete chat.remote.message
    if (event.message) chat.remote.message = event.message
    if (event.state === 'ended') endRemoteSession(chat)
    return true
  }
  if (event.type === 'session.replay') {
    chat.replaying = event.phase === 'started'
    if (chat.remote) chat.remote = { ...chat.remote, replaying: chat.replaying }
    if (event.phase === 'started') {
      chat.activities = []; chat.requests = []; chat.children = []; chat.plan = []; chat.turn = 'idle'
      delete chat.turnId; delete chat.problem
    } else {
      if (!chat.remote) for (const item of chat.activities) {
        if (item.status === 'streaming' || item.status === 'in_progress') item.status = 'completed'
      }
      if (chat.remote?.state === 'ended') endRemoteSession(chat)
    }
    return true
  }
  if (event.type === 'message.submitted') {
    const text = event.input.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    if (!chat.activities.some((item) => item.kind === 'user')) chat.summary.title = text.slice(0, 100) || 'Remote chat'
    chat.summary.preview = text.slice(0, 200)
    chat.activities = mergeActivity(chat.activities, { id: `user:${event.messageId}`, threadId: chat.summary.id,
      ...(event.turnId ? { turnId: event.turnId } : {}), kind: 'user', title: 'You', content: text,
      contentUpdate: 'replace', timestamp: new Date(event.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      createdAtMs: Date.parse(event.occurredAt), images: event.input.flatMap((part) => part.type === 'image'
        ? [{ name: 'Image', mediaType: part.mimeType, url: `data:${part.mimeType};base64,${part.data}` }] : []) })
    return true
  }
  if (event.type === 'task.started') {
    const children = chat.children ??= []
    if (children.some((child) => child.sessionId === event.taskId)) return false
    const id = `${chat.summary.id}:${event.taskId}`
    const parent = children.find((child) => child.sessionId === event.parentSessionId)
    const turnId = event.turnId ?? parent?.task.turnId ?? chat.turnId
    children.push({ sessionId: event.taskId, kind: event.taskKind, activities: event.prompt.trim() ? [{ id: `${id}:prompt`, kind: 'user', title: 'Instructions', content: event.prompt, timestamp: '' }] : [],
      task: { id, threadId: id, ...(turnId ? { turnId } : {}), parentThreadId: chat.summary.id, ancestorThreadIds: parent ? [parent.task.id, ...(parent.task.ancestorThreadIds ?? [])] : [],
        parentTitle: chat.summary.title, title: event.title, workspace: chat.summary.cwd, status: 'working', canStop: event.canStop,
        ...(event.model ? { model: event.model } : {}), ...(event.effort ? { effort: event.effort } : {}),
        activity: event.prompt, result: '', createdAt: Date.parse(event.occurredAt), updatedAt: Date.parse(event.occurredAt) } })
    return true
  }
  if (event.type === 'task.updated') {
    const child = chat.children?.find((child) => child.sessionId === event.taskId)
    if (!child) return false
    if (event.status) child.task.status = event.status
    if (event.model) child.task.model = event.model
    if (event.effort) child.task.effort = event.effort
    if (event.summary) {
      child.task.activity = event.summary
      child.task.result = event.summary
    }
    child.task.updatedAt = Date.parse(event.occurredAt)
    if (!taskActive(child.task)) {
      child.task.finishedAt = child.task.updatedAt
      for (const item of child.activities) {
        if (item.status === 'streaming' || item.status === 'in_progress') {
          item.status = child.task.status === 'done' ? 'completed' : 'interrupted'
        }
      }
    }
    return true
  }
  const child = chat.children?.find((child) => child.sessionId === event.sessionId)
  const interaction = event.type.startsWith('permission.') || event.type.startsWith('input.')
  if (child && interaction) {
    child.task.status = event.type.endsWith('.requested') ? 'waiting' : 'working'
    child.task.updatedAt = Date.parse(event.occurredAt)
  }
  const transcript = child ?? chat
  if (applyTranscriptEvent(transcript, event, chat.summary.id, child ? child.task.turnId : chat.turnId)) {
    if (child) {
      child.task.updatedAt = Date.parse(event.occurredAt)
      if (event.type === 'tool.started' || event.type === 'tool.updated') child.task.activity = event.title
      if (event.type === 'message.delta' && event.role === 'agent' && event.content.type === 'text') child.task.result += event.content.text
    } else if (event.type === 'plan.updated') chat.plan = event.entries
    return true
  }
  // Children report completion through task.updated. Only their approval and
  // question events affect the parent conversation's controls.
  if (child && !interaction) return false
  if (event.type === 'turn.started') {
    chat.turn = 'running'
    chat.turnId = event.turnId
    chat.plan = []
    chat.turnStartedAt = Date.parse(event.occurredAt)
    const prompt = chat.activities.findLast((item) => item.kind === 'user')
    if (prompt && !prompt.turnId) prompt.turnId = event.turnId
  } else if (event.type === 'config.updated') {
    chat.configOptions = event.configOptions
    chat.configurationRevision = (chat.configurationRevision ?? 0) + 1
  } else if (event.type === 'usage.updated') {
    chat.usage = { used: event.used, size: event.size, ...(event.cost ? { cost: event.cost } : {}) }
  } else if (event.type === 'commands.updated') {
    chat.commands = event.commands
  } else if (event.type === 'input.requested') {
    chat.requests.push({ id: event.requestId, method: 'agent/requestUserInput', receivedAt: event.occurredAt,
      params: { threadId: chat.summary.id, agentSessionId: event.sessionId, message: event.message, schema: event.schema } })
  } else if (event.type === 'input.resolved') {
    chat.requests = chat.requests.filter((request) => request.id !== event.requestId)
    if (event.answer) chat.activities = mergeActivity(chat.activities, {
      id: `answer:${event.requestId}`, threadId: chat.summary.id, ...(chat.turnId ? { turnId: chat.turnId } : {}),
      kind: 'agent', title: 'Answered', content: event.answer.message, contentUpdate: 'replace', delivery: 'async',
      questions: [{ title: event.answer.message }], questionAnswers: [event.answer.values.join(' · ')],
      timestamp: new Date(event.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), createdAtMs: Date.parse(event.occurredAt),
    })
  }
  else if (event.type === 'permission.requested') {
    chat.requests.push({ id: event.requestId, method: 'agent/requestApproval', receivedAt: event.occurredAt,
      params: { threadId: chat.summary.id, agentSessionId: event.sessionId, title: child ? `${child.task.title}: ${event.title}` : event.title, options: event.options } })
  } else if (event.type === 'permission.resolved') {
    chat.requests = chat.requests.filter((request) => request.id !== event.requestId)
  } else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
    chat.turn = 'idle'
    if (event.type === 'turn.failed' || event.stopReason === 'cancelled') {
      for (const child of chat.children ?? []) {
        if (taskActive(child.task)) child.task.status = event.type === 'turn.failed' ? 'failed' : 'stopped'
      }
    }
    chat.requests = event.type === 'turn.completed' && event.stopReason !== 'cancelled'
      ? chat.requests.filter((request) => chat.children?.some((child) => child.sessionId === request.params.agentSessionId && taskActive(child.task))) : []
    const status = event.type === 'turn.failed' ? 'failed' : event.stopReason === 'cancelled' ? 'interrupted' : 'completed'
    for (const activity of chat.activities) {
      if (activity.turnId === event.turnId && activity.status && !['completed', 'failed'].includes(activity.status)) activity.status = status
    }
    if (event.type === 'turn.failed') {
      chat.problem = event.message
      chat.queuePaused = true
    } else if (event.stopReason !== 'cancelled') {
      const final = chat.activities.findLast((item) => item.turnId === event.turnId && item.kind === 'agent' && item.delivery !== 'async')
      if (final) {
        final.phase = 'final_answer'
        final.durationMs = Math.max(1, Date.parse(event.occurredAt) - (chat.turnStartedAt ?? Date.parse(event.occurredAt)))
      }
    }
  } else return false
  return true
}
