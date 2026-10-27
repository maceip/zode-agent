import { errorMessage, isRecord, type ThreadHistoryPage } from '../../src/shared/protocol.js'
import { readThreadMessages } from '../../src/server/services/thread-view.js'
import { AgentHistoryCache } from './orchestrator-cache.js'
import { taskActive, type AgentTask, type AgentTaskStatus, type OrchestratorSnapshot } from './orchestrator-api.js'

export interface NativeAgentRuntime {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
}
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : []
export function nativeParent(value: unknown): string | undefined {
  const thread = record(value)
  const spawn = record(record(record(thread.source).subAgent).thread_spawn)
  return text(thread.parentThreadId) || text(spawn.parent_thread_id) || undefined
}
const turnStatus = (value: unknown): AgentTaskStatus => value === 'completed' ? 'done'
  : value === 'interrupted' ? 'stopped' : value === 'failed' ? 'failed' : value === 'inProgress' ? 'working' : 'unknown'
const liveStatus = (value: unknown): AgentTaskStatus | undefined => {
  const status = record(value)
  if (status.type === 'systemError') return 'failed'
  if (status.type !== 'active') return undefined
  return Array.isArray(status.activeFlags) && status.activeFlags.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') ? 'waiting' : 'working'
}
const sameTask = (left: AgentTask, right: AgentTask): boolean =>
  [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => {
    if (key === 'ancestorThreadIds') {
      const a = left.ancestorThreadIds ?? [], b = right.ancestorThreadIds ?? []
      return a.length === b.length && a.every((id, index) => id === b[index])
    }
    return left[key as keyof AgentTask] === right[key as keyof AgentTask]
  })
const collabStatus: Record<string, AgentTaskStatus> = { pendingInit: 'starting', running: 'working', interrupted: 'stopped', completed: 'done', errored: 'failed', shutdown: 'stopped', notFound: 'unknown' }

// This observes Codex's own threads. Reading a task never resumes a thread or
// starts a turn, and unloading the panel must not interrupt native agents.
export class NativeAgentMonitor {
  private tasks = new Map<string, AgentTask>()
  private threads = new Map<string, Record<string, unknown>>()
  private reads = new Map<string, Promise<Record<string, unknown>>>()
  private refreshWork: Promise<void> | undefined
  private versions = new Map<string, number>()
  private hydrated = new Map<string, number>()
  private historyCache = new AgentHistoryCache()
  private active = true
  private revision = 0
  private published: OrchestratorSnapshot = { revision: 0, tasks: [] }
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private error: string | undefined
  constructor(private runtime: NativeAgentRuntime, private publish: (snapshot: OrchestratorSnapshot) => void) {}
  snapshot(): OrchestratorSnapshot {
    return { revision: this.revision, tasks: [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt), ...(this.error ? { error: this.error } : {}) }
  }
  private emit(): void {
    if (!this.active) return
    // Each publication sends the full agent list to every browser. Cached
    // refreshes can finish dozens of reads in one burst and overflow the socket
    // buffer. Coalesce that burst while still showing progress during slow reads.
    if (this.publishTimer !== undefined) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined
      if (!this.active) return
      const next = this.snapshot()
      if (next.error === this.published.error && next.tasks.length === this.published.tasks.length
        && next.tasks.every((task, index) => sameTask(task, this.published.tasks[index]!))) return
      this.published = { ...next, revision: ++this.revision }
      this.publish(this.published)
    }, 100)
  }
  dispose(): void {
    this.active = false
    if (this.publishTimer !== undefined) clearTimeout(this.publishTimer)
    this.publishTimer = undefined
    this.historyCache.clear()
  }
  connectionLost(): void {
    this.error = 'Reconnecting… Agent statuses may be out of date.'
    for (const task of this.tasks.values()) {
      if (taskActive(task)) this.update(task.id, { status: 'unknown' })
    }
    this.emit()
  }
  private async read(id: string): Promise<Record<string, unknown>> {
    const pending = this.reads.get(id)
    if (pending) return pending
    const version = this.versions.get(id) ?? 0
    const request = this.runtime.request('thread/read', { threadId: id, includeTurns: false }).then((response) => {
      const thread = record(record(response).thread)
      if (thread.id !== id) throw new Error('The agent conversation is unavailable.')
      if (this.active && (this.versions.get(id) ?? 0) === version) this.threads.set(id, thread)
      return thread
    }).finally(() => { if (this.reads.get(id) === request) this.reads.delete(id) })
    this.reads.set(id, request)
    return request
  }
  private remember(thread: Record<string, unknown>): AgentTask | undefined {
    const id = text(thread.id)
    const parentThreadId = nativeParent(thread)
    if (!this.active || !id) return
    this.threads.set(id, thread)
    if (!parentThreadId || parentThreadId === id) return
    const previous = this.tasks.get(id)
    const source = record(record(record(thread.source).subAgent).thread_spawn)
    const task: AgentTask = {
      ...previous, id, threadId: id, parentThreadId,
      parentTitle: previous?.parentTitle ?? 'Parent chat',
      title: text(thread.name) || text(thread.agentNickname) || text(source.agent_nickname) || 'Subagent',
      workspace: text(thread.cwd),
      status: liveStatus(thread.status) ?? (previous && !taskActive(previous) ? previous.status : 'unknown'),
      activity: previous?.activity ?? '', result: previous?.result ?? '',
      createdAt: Number(thread.createdAt) * 1000 || 0,
      updatedAt: Math.max(Number(thread.updatedAt) * 1000 || 0, previous?.updatedAt ?? 0),
    }
    this.tasks.set(id, task)
    return task
  }
  private async ancestry(task: AgentTask): Promise<void> {
    const ancestors: string[] = []
    let parentId: string | undefined = task.parentThreadId
    let parentTitle = task.parentTitle
    // Read actual ancestry, including intermediate agents outside the recent
    // list, so nested agents still appear from their original parent chat.
    while (parentId && !ancestors.includes(parentId) && ancestors.length < 32) {
      ancestors.push(parentId)
      const parent = record(this.threads.get(parentId) ?? await this.read(parentId).catch(() => ({})))
      if (!this.active) return
      if (parentId === task.parentThreadId) parentTitle = text(parent.name) || text(parent.agentNickname) || parentTitle
      parentId = nativeParent(parent)
    }
    const current = this.tasks.get(task.id)
    if (current) this.tasks.set(task.id, { ...current, parentTitle, ancestorThreadIds: ancestors })
  }
  private async hydrate(thread: Record<string, unknown>): Promise<void> {
    const task = this.remember(thread)
    if (!task) return
    const version = this.versions.get(task.id) ?? 0
    await this.ancestry(task)
    if (!this.active || (this.versions.get(task.id) ?? 0) !== version) return
    if (this.hydrated.get(task.id) === task.updatedAt && task.status !== 'unknown' && !taskActive(task)) return
    const response = record(await this.runtime.request('thread/turns/list', { threadId: task.id, limit: 1, sortDirection: 'desc', itemsView: 'full' }))
    if (!this.active || (this.versions.get(task.id) ?? 0) !== version) return
    const turn = rows(response.data)[0]
    const last = this.tasks.get(task.id)!
    const messages = turn ? readThreadMessages(task.id, [turn]) : []
    // An unfinished turn on disk is not evidence that an agent is still running.
    const savedStatus = turn ? turnStatus(turn.status) : 'unknown'
    const status = liveStatus(thread.status) ?? (savedStatus === 'working' ? 'unknown' : savedStatus)
    this.tasks.set(task.id, {
      ...last, status, ...(turn && text(turn.id) ? { turnId: text(turn.id) } : {}),
      result: (messages.findLast((entry) => entry.role === 'agent')?.text ?? last.result).slice(0, 16_000),
      ...(status === 'failed' ? { error: text(record(turn?.error).message) || 'The agent failed.' } : { error: undefined }),
      ...(!['working', 'waiting', 'unknown'].includes(status) ? { finishedAt: Number(turn?.completedAt) * 1000 || last.updatedAt } : { finishedAt: undefined }),
    })
    this.hydrated.set(task.id, task.updatedAt)
  }
  refresh(_parentThreadId?: string): Promise<void> {
    // All panel scopes share the same live process list; chat filtering is local.
    if (this.refreshWork) return this.refreshWork
    const work = this.load().finally(() => { if (this.refreshWork === work) this.refreshWork = undefined })
    this.refreshWork = work
    return work
  }
  private async load(): Promise<void> {
    const versions = new Map(this.versions)
    try {
      const loaded = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const response = record(await this.runtime.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) }))
        if (!this.active) return
        for (const id of Array.isArray(response.data) ? response.data : []) {
          if (typeof id === 'string') loaded.add(id)
        }
        const next = text(response.nextCursor)
        if (next && cursors.has(next)) throw new Error('Loaded agent pagination repeated a cursor.')
        if (next) cursors.add(next)
        cursor = next || undefined
      } while (cursor)

      // A loaded parent chat is not a subagent. Once classified, it needs no
      // further reads while it remains loaded. Agent status reads omit turns.
      const ids = [...loaded].filter((id) => !this.threads.has(id) || nativeParent(this.threads.get(id)))
      let offset = 0
      let failed = false
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (this.active && offset < ids.length) {
          const id = ids[offset++]!
          const version = this.versions.get(id) ?? 0
          try {
            const thread = await this.read(id)
            if (!this.active || (this.versions.get(id) ?? 0) !== version) continue
            const task = this.remember(thread)
            if (task) await this.ancestry(task)
          } catch {
            failed = true
            const task = this.tasks.get(id)
            if ((this.versions.get(id) ?? 0) === version && task && taskActive(task)) {
              this.update(id, { status: 'unknown' })
            }
          }
          this.emit()
        }
      }))
      if (!this.active) return
      for (const task of this.tasks.values()) {
        if (!loaded.has(task.id) && taskActive(task) && (this.versions.get(task.id) ?? 0) === (versions.get(task.id) ?? 0)) {
          this.update(task.id, { status: 'unknown' })
        }
      }
      this.error = failed ? 'Could not refresh some agent statuses.' : undefined
      const stale = [...this.tasks.values()].filter((task) => !taskActive(task)).sort((a, b) => b.updatedAt - a.updatedAt).slice(200)
      for (const task of stale) { this.tasks.delete(task.id); this.hydrated.delete(task.id); this.versions.delete(task.id) }
      for (const id of this.threads.keys()) if (!loaded.has(id) && !this.tasks.has(id)) this.threads.delete(id)
      this.emit()
    } catch (error) {
      if (!this.active) return
      this.error = 'Could not read native subagents: ' + errorMessage(error)
      this.emit()
    }
  }
  private update(id: string, patch: Partial<AgentTask>): void {
    const task = this.tasks.get(id)
    if (!this.active || !task) return
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1)
    this.historyCache.invalidate(id)
    this.tasks.set(id, { ...task, ...patch, updatedAt: Date.now() })
    this.emit()
  }
  notification(notification: { method: string; params?: unknown }): void {
    if (!this.active) return
    const p = record(notification.params)
    const item = record(p.item)
    const id = text(p.threadId)
    if (notification.method === 'thread/started') {
      const thread = record(p.thread)
      const task = this.remember(thread)
      if (task) {
        this.versions.set(task.id, (this.versions.get(task.id) ?? 0) + 1)
        this.emit()
        void this.ancestry(task).then(() => this.emit()).catch(() => {})
      }
      return
    }
    if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') {
      const ids = item.type === 'subAgentActivity' ? [text(item.agentThreadId)] : Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string') : []
      for (const childId of ids) {
        const apply = (): void => {
          const state = record(record(item.agentsStates)[childId])
          const status = collabStatus[text(state.status)]
          if (status) this.update(childId, { status, ...(text(state.message) ? { result: text(state.message).slice(0, 16_000) } : {}), ...(!['working', 'starting'].includes(status) ? { finishedAt: Date.now() } : { finishedAt: undefined }) })
        }
        if (this.tasks.has(childId)) apply()
        else void this.read(childId).then(async (thread) => { await this.hydrate(thread); apply(); this.emit() }).catch(() => {})
      }
    }
    if (!id || !this.tasks.has(id)) return
    this.historyCache.invalidate(id)
    if (notification.method === 'turn/started') this.update(id, { status: 'working', turnId: text(record(p.turn).id), finishedAt: undefined, error: undefined })
    else if (notification.method === 'turn/completed') {
      const turn = record(p.turn)
      if (this.tasks.get(id)?.turnId && text(turn.id) !== this.tasks.get(id)?.turnId) return
      this.update(id, { status: turnStatus(turn.status), finishedAt: Date.now(), ...(turn.error ? { error: text(record(turn.error).message) } : {}) })
    } else if (notification.method === 'thread/status/changed') {
      const status = liveStatus(p.status)
      const thread = { ...this.threads.get(id), status: p.status }
      this.threads.set(id, thread)
      if (status) this.update(id, { status, finishedAt: undefined })
      else if (taskActive(this.tasks.get(id)!)) {
        // Stop claiming activity immediately, even if the completion event was missed.
        this.update(id, { status: 'unknown' })
        void this.hydrate(thread).then(() => this.emit()).catch(() => {})
      }
    } else if (notification.method === 'thread/closed') {
      const task = this.tasks.get(id)!
      if (taskActive(task)) this.update(id, { status: 'stopped', finishedAt: Date.now() })
    } else if (notification.method === 'item/completed' && item.type === 'agentMessage') this.update(id, { result: text(item.text).slice(0, 16_000) })
  }
  private async scoped(parentThreadId: string, id: string): Promise<AgentTask> {
    const thread = await this.read(id)
    if (!this.active) throw new Error('Agents panel is disabled.')
    if (nativeParent(thread) !== parentThreadId) throw new Error('This subagent does not belong to that parent chat.')
    const task = this.remember(thread)
    if (!task) throw new Error('The native subagent is unavailable.')
    return task
  }
  async history(parentThreadId: string, id: string, cursor?: string): Promise<ThreadHistoryPage> {
    await this.scoped(parentThreadId, id)
    return this.historyCache.get(id, cursor, async () => {
      const response = record(await this.runtime.request('thread/turns/list', { threadId: id, ...(cursor ? { cursor } : {}), limit: cursor ? 5 : 1, sortDirection: 'desc', itemsView: 'full' }))
      const turns = rows(response.data).reverse()
      // The shared parser attaches trailing tool output to an agent message.
      // While a turn has no reply yet, use an empty anchor to retain its traces.
      const readable = turns.map((turn) => {
        const items = rows(turn.items)
        return items.some((item) => item.type === 'agentMessage') ? turn
          : { ...turn, items: [...items, { type: 'agentMessage', id: 'pending-agent-output', text: '…', phase: 'commentary' }] }
      })
      return { messages: readThreadMessages(id, readable).map((message) => message.id.endsWith(':pending-agent-output') ? { ...message, text: '' } : message), ...(text(response.nextCursor) ? { olderCursor: text(response.nextCursor) } : {}) }
    })
  }
  async stop(parentThreadId: string, id?: string): Promise<void> {
    const ids = id ? [id] : [...this.tasks.values()].filter((task) => task.parentThreadId === parentThreadId && taskActive(task)).map((task) => task.id)
    for (const child of ids) {
      const task = await this.scoped(parentThreadId, child)
      const response = record(await this.runtime.request('thread/turns/list', { threadId: child, limit: 1, sortDirection: 'desc', itemsView: 'full' }))
      if (!this.active) return
      const turn = rows(response.data)[0]
      if (turn?.status !== 'inProgress' || !text(turn.id)) continue
      await this.runtime.request('turn/interrupt', { threadId: task.id, turnId: turn.id })
      this.update(child, { status: 'stopping' })
    }
  }
}
