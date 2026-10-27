export const ORCHESTRATOR_STATE = 'orchestrator'
export const ORCHESTRATOR_PANEL = 'orchestrator-panel'
export const ORCHESTRATOR_REFRESH = 'orchestrator.refresh'
export const ORCHESTRATOR_STOP = 'orchestrator.stop'
export const ORCHESTRATOR_OPEN = 'orchestrator.open'

export type AgentTaskStatus = 'starting' | 'working' | 'waiting' | 'stopping' | 'done' | 'failed' | 'stopped' | 'unknown'
export interface AgentTask {
  id: string
  parentThreadId: string
  parentTitle: string
  title: string
  ancestorThreadIds?: string[]
  workspace: string
  model?: string
  effort?: string
  canStop?: boolean
  threadId?: string
  turnId?: string
  status: AgentTaskStatus
  activity: string
  result: string
  error?: string | undefined
  createdAt: number
  updatedAt: number
  finishedAt?: number | undefined
}
export interface OrchestratorSnapshot {
  revision: number
  tasks: AgentTask[]
  error?: string
}
export const EMPTY_ORCHESTRATOR: OrchestratorSnapshot = { revision: 0, tasks: [] }
export const taskActive = (task: AgentTask): boolean => ['starting', 'working', 'waiting', 'stopping'].includes(task.status)
export const taskStatusLabel: Record<AgentTaskStatus, string> = {
  starting: 'Starting', working: 'Working', waiting: 'Needs input', stopping: 'Stopping',
  done: 'Done', failed: 'Failed', stopped: 'Stopped', unknown: 'Check status',
}
export function tasksForChat(tasks: readonly AgentTask[], threadId?: string): AgentTask[] {
  if (!threadId) return []
  const parent = tasks.find((task) => task.threadId === threadId)?.parentThreadId ?? threadId
  const included = new Set([parent])
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks) {
      if (task.threadId && !included.has(task.threadId) && (included.has(task.parentThreadId) || task.ancestorThreadIds?.includes(parent))) {
        included.add(task.threadId)
        changed = true
      }
    }
  }
  return tasks.filter((task) => task.threadId && task.threadId !== parent && included.has(task.threadId))
}
