import type { HarnessEvent, LocalProject, ThreadSummary, ThreadView } from '../../../src/shared/protocol.js'
import { threadRecencyAt } from '../../../src/shared/protocol.js'
import { activityFrom, fileChanges, type ActivityItem } from './activity-model.js'

export type HistoryState =
  | { tag: 'ready'; entries: ThreadSummary[] }
  | { tag: 'loading'; entries: ThreadSummary[] }
  | { tag: 'failed'; entries: ThreadSummary[]; problem: string }

export function historyEntries(state: HistoryState): ThreadSummary[] {
  return state.entries
}

export function threadHistoryTitle(
  thread: Pick<ThreadSummary, 'title' | 'preview'>,
): string {
  const explicit = thread.title.trim()
  if (explicit && explicit !== 'Untitled conversation') return explicit
  const preview = thread.preview.split('\n', 1)[0]?.trim() ?? ''
  if (!preview) return explicit || 'Untitled conversation'
  return preview.length > 72 ? `${preview.slice(0, 71).trimEnd()}…` : preview
}

export function withThreadTitle(
  entries: ThreadSummary[],
  threadId: string,
  title: string,
): ThreadSummary[] {
  let changed = false
  const renamed = entries.map((thread) => {
    if (thread.id !== threadId || thread.title === title) return thread
    changed = true
    return { ...thread, title }
  })
  return changed ? renamed : entries
}

export interface ProjectHistoryGroup {
  id: string
  label: string
  project?: LocalProject
  entries: ThreadSummary[]
  updatedAt: number
}

export const PROJECT_PREVIEW_LIMIT = 4
export const OTHER_PROJECT_ID = 'other'

function comparablePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLocaleLowerCase() : normalized
}

export function projectForWorkspace(
  projects: LocalProject[],
  workspace: string,
): LocalProject | undefined {
  const candidate = comparablePath(workspace)
  if (!candidate) return undefined
  let best: { project: LocalProject; length: number } | undefined
  for (const project of projects) {
    for (const root of project.roots) {
      const comparableRoot = comparablePath(root)
      if (
        !comparableRoot
        || (candidate !== comparableRoot && !candidate.startsWith(`${comparableRoot}/`))
        || (best && comparableRoot.length <= best.length)
      ) continue
      best = { project, length: comparableRoot.length }
    }
  }
  return best?.project
}

export function groupThreadsByProject(
  entries: ThreadSummary[],
  projects: LocalProject[],
): ProjectHistoryGroup[] {
  const knownProjects = new Map(projects.map((project) => [project.id, project]))
  const entriesByProject = new Map(projects.map((project) => [project.id, [] as ThreadSummary[]]))
  const other: ThreadSummary[] = []
  for (const thread of entries.toSorted((left, right) => threadRecencyAt(right) - threadRecencyAt(left))) {
    const group = thread.projectId ? entriesByProject.get(thread.projectId) : undefined
    if (group && thread.projectId && knownProjects.has(thread.projectId)) group.push(thread)
    else other.push(thread)
  }

  const groups: ProjectHistoryGroup[] = projects.map((project) => {
    const groupedEntries = entriesByProject.get(project.id) ?? []
    return {
      id: project.id,
      label: project.name,
      project,
      entries: groupedEntries,
      updatedAt: groupedEntries[0] ? threadRecencyAt(groupedEntries[0]) : 0,
    }
  })
  if (other.length) groups.push({
    id: OTHER_PROJECT_ID,
    label: 'Recents',
    entries: other,
    updatedAt: other[0] ? threadRecencyAt(other[0]) : 0,
  })
  return groups
}

function clock(seconds: number | undefined): string {
  if (!seconds) return ''
  return new Date(seconds * 1_000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function activitiesFromThread(view: ThreadView, events: readonly HarnessEvent[] = []): ActivityItem[] {
  // Older running hosts omit question metadata from history. The journal still
  // has the original item. Replayed IDs can differ from live call IDs, so also
  // accept an unambiguous text match within the same turn.
  const asyncMessages = new Map<string, ActivityItem>()
  for (const event of events) {
    if (event.type !== 'codex.notification' || event.payload.method !== 'item/completed'
      || event.payload.params?.threadId !== view.summary.id) continue
    const item = event.payload.params?.item
    if (!item || typeof item !== 'object' || !('delivery' in item) || item.delivery !== 'async') continue
    const activity = activityFrom(event.payload)
    if (activity) asyncMessages.set(activity.id, activity)
  }
  return view.messages.flatMap((message) => {
    const candidates = message.role === 'agent' ? [...asyncMessages.values()].filter((item) => (
      item.turnId && message.id.startsWith(view.summary.id + ':' + item.turnId + ':')
      && item.content.trim() === message.text.trim()
    )) : []
    const asyncMessage = asyncMessages.get(message.role + ':' + message.id)
      ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (asyncMessage) message = {
      ...message,
      ...(asyncMessage.delivery ? { delivery: asyncMessage.delivery } : {}),
      ...(asyncMessage.questions ? { questions: asyncMessage.questions } : {}),
    }

    const traceActivities = (traces: NonNullable<typeof message.tracesBefore>): ActivityItem[] => traces.map((trace) => ({
      id: `${trace.kind}:${trace.id}`,
      itemId: trace.id.split(':').at(-1) ?? trace.id,
      kind: trace.kind,
      title: trace.title,
      content: trace.text,
      ...(trace.status ? { status: trace.status } : {}),
      timestamp: clock(message.createdAt),
      ...(message.createdAt ? { createdAtMs: message.createdAt * 1_000 } : {}),
    }))
    const tracesBefore = traceActivities(message.tracesBefore ?? [])
    const tracesAfter = traceActivities(message.tracesAfter ?? [])
    const activity: ActivityItem = {
      id: `${message.role}:${message.id}`,
      itemId: message.id.split(':').at(-1) ?? message.id,
      kind: message.role,
      title: message.role === 'user' ? 'You' : 'Codex',
      content: message.text,
      ...(message.input ? { input: message.input } : {}),
      ...(message.continuesTurn ? { continuesTurn: true } : {}),
      ...(message.phase ? { phase: message.phase } : {}),
      ...(message.delivery ? { delivery: message.delivery } : {}),
      ...(message.questions ? { questions: message.questions, threadId: view.summary.id } : {}),
      ...(message.images ? { images: message.images } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
      ...(message.durationMs ? { durationMs: message.durationMs } : {}),
      timestamp: clock(message.createdAt),
      ...(message.createdAt ? { createdAtMs: message.createdAt * 1_000 } : {}),
    }
    if (!message.fileChanges?.length) return [...tracesBefore, activity, ...tracesAfter]
    return [...tracesBefore, activity, ...tracesAfter, {
      id: `file:${message.id}`,
      itemId: message.id.split(':').at(-1) ?? message.id,
      kind: 'file',
      title: 'Files',
      content: '',
      status: 'completed',
      timestamp: clock(message.createdAt),
      ...(message.createdAt ? { createdAtMs: message.createdAt * 1_000 } : {}),
      files: fileChanges({ changes: message.fileChanges }),
    }]
  })
}
