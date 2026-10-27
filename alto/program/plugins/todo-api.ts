import { isRecord, type LocalProject, type ThreadSummary } from '../../src/shared/protocol.js'
import type { WorkspaceLayoutState } from './workspace-layout-state.js'
import { workspaceViewThreads } from './workspace-tab-data.js'

export const TODO_UNSORTED_ID = 'unsorted'
export const TODO_STATE = 'todo'
export const TODO_APPLY = 'todo.apply'
export interface TodoChat { thread: ThreadSummary; addedAt: number }
export interface TodoItem { id: string; text: string; done: boolean; chats: TodoChat[] }
export interface TodoProject { id: string; name: string; items: TodoItem[]; chats: TodoChat[] }
export interface TodoDocument { version: 1 | 2 | 3; projects: TodoProject[] }
export interface TodoDestination { projectId: string; itemId?: string }
export type TodoOperation =
  | { type: 'addItem'; projectId: string; text: string }
  | { type: 'editItem'; itemId: string; text: string }
  | { type: 'completeItem'; itemId: string; done: boolean }
  | { type: 'deleteItem'; itemId: string }
  | { type: 'moveItem'; itemId: string; projectId: string; beforeItemId?: string }
  | { type: 'fileTab'; threads: ThreadSummary[]; name: string; destination: TodoDestination; sourceItemId?: string }
  | { type: 'fileChats'; threads: ThreadSummary[]; destination: TodoDestination; name?: string }
  | { type: 'moveChat'; threadId: string; destination: TodoDestination }
  | { type: 'removeChat'; threadId: string }
  | { type: 'renameChat'; threadId: string; text: string }

export function emptyTodo(): TodoDocument {
  return { version: 3, projects: [{ id: TODO_UNSORTED_ID, name: 'Unsorted', items: [], chats: [] }] }
}

function storedThread(value: unknown): ThreadSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.cwd !== 'string') return
  const thread: ThreadSummary = {
    id: value.id, title: typeof value.title === 'string' ? value.title : 'Chat',
    preview: typeof value.preview === 'string' ? value.preview : '', cwd: value.cwd,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  }
  for (const key of ['providerId', 'providerSessionId', 'projectId', 'modelProvider'] as const) {
    if (typeof value[key] === 'string') thread[key] = value[key]
  }
  if (isRecord(value.gitInfo)) thread.gitInfo = Object.fromEntries(Object.entries(value.gitInfo).filter(([key, v]) => ['branch', 'sha', 'originUrl'].includes(key) && typeof v === 'string'))
  if (isRecord(value.projectRef) && typeof value.projectRef.source === 'string' && typeof value.projectRef.id === 'string') {
    thread.projectRef = { source: value.projectRef.source, id: value.projectRef.id }
  }
  return thread
}

export function parseTodo(value: unknown): TodoDocument {
  if (!isRecord(value) || !Array.isArray(value.projects)) return emptyTodo()
  const chatIds = new Set<string>(), itemIds = new Set<string>(), projectIds = new Set<string>()
  const chats = (input: unknown): TodoChat[] => !Array.isArray(input) ? [] : input.flatMap((entry) => {
    const thread = isRecord(entry) ? storedThread(entry.thread) : undefined
    if (!thread || chatIds.has(thread.id)) return []
    chatIds.add(thread.id)
    return [{ thread, addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : 0 }]
  })
  const projects: TodoProject[] = value.projects.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || projectIds.has(entry.id)) return []
    projectIds.add(entry.id)
    return [{ id: entry.id, name: typeof entry.name === 'string' ? entry.name : 'Project', chats: chats(entry.chats),
      items: !Array.isArray(entry.items) ? [] : entry.items.flatMap((item) => {
        if (!isRecord(item) || typeof item.id !== 'string' || !item.id || itemIds.has(item.id) || typeof item.text !== 'string') return []
        itemIds.add(item.id)
        return [{ id: item.id, text: item.text, done: item.done === true, chats: chats(item.chats) }]
      }),
    }]
  })
  const unsorted = projects.find((project) => project.id === TODO_UNSORTED_ID) ?? emptyTodo().projects[0]!
  return { version: value.version === 3 ? 3 : value.version === 2 ? 2 : 1, projects: [...projects.filter((project) => project !== unsorted), { ...unsorted, name: 'Unsorted' }] }
}

export type TodoAltoProject = Pick<LocalProject, 'id' | 'name'>

// Only the original standalone groups need a name match. Once linked, project
// identity survives renames and never follows a different project with that name.
export function migrateTodoProjects(document: TodoDocument, projects: readonly TodoAltoProject[]): TodoDocument {
  if (document.version >= 2) return document
  const groups = new Map<string, TodoProject>()
  for (const group of document.projects) {
    const exact = projects.find((project) => project.id === group.id)
    const matches = projects.filter((project) => project.name.trim().toLowerCase() === group.name.trim().toLowerCase())
    const project = exact ?? (matches.length === 1 ? matches[0] : undefined)
    const id = group.id === TODO_UNSORTED_ID ? TODO_UNSORTED_ID : project?.id ?? TODO_UNSORTED_ID
    const target = groups.get(id) ?? { id, name: project?.name ?? 'Unsorted', items: [], chats: [] }
    target.items.push(...group.items)
    target.chats.push(...group.chats)
    groups.set(id, target)
  }
  if (!groups.has(TODO_UNSORTED_ID)) groups.set(TODO_UNSORTED_ID, emptyTodo().projects[0]!)
  return { version: 2, projects: [...groups.values()] }
}

export function todoWithProjects(document: TodoDocument, projects: readonly TodoAltoProject[]): TodoDocument {
  const saved = migrateTodoProjects(document, projects)
  const groups = projects.map((project): TodoProject => {
    const group = saved.projects.find((entry) => entry.id === project.id)
    return { id: project.id, name: project.name, items: [...(group?.items ?? [])], chats: [...(group?.chats ?? [])] }
  })
  const ids = new Set(projects.map((project) => project.id))
  return { version: saved.version, projects: [...groups, ...saved.projects.filter((group) => !ids.has(group.id))] }
}

export function todoForProjects(document: TodoDocument, projects: readonly TodoAltoProject[]): TodoDocument {
  const saved = todoWithProjects(document, projects)
  const ids = new Set(projects.map((project) => project.id))
  const unsorted = emptyTodo().projects[0]!
  for (const group of saved.projects) {
    if (ids.has(group.id)) continue
    unsorted.items.push(...group.items)
    unsorted.chats.push(...group.chats)
  }
  return { version: saved.version, projects: [...saved.projects.filter((group) => ids.has(group.id)), unsorted] }
}

export function findTodoItem(document: TodoDocument, itemId: string): TodoItem | undefined {
  return document.projects.flatMap((project) => project.items).find((item) => item.id === itemId)
}

export function todoItemForThreads(document: TodoDocument, threadIds: readonly string[]): TodoItem | undefined {
  if (!threadIds.length) return undefined
  return document.projects.flatMap((project) => project.items).find((item) => threadIds.every((id) => item.chats.some((chat) => chat.thread.id === id)))
}

export function migrateTodoTasks(document: TodoDocument, layout: WorkspaceLayoutState | undefined, id: () => string): TodoDocument {
  if (document.version === 3 && document.projects.every((project) => !project.chats.length)) return document
  const projects = document.projects.map((project) => {
    const groups = new Map<string, TodoItem>()
    for (const chat of project.chats) {
      const tab = layout?.views.find((view) => workspaceViewThreads(view).some((thread) => thread.id === chat.thread.id))
      const key = tab?.id ?? chat.thread.id
      const task = groups.get(key) ?? { id: id(), text: tab?.name || chat.thread.title || 'Untitled task', done: false, chats: [] }
      task.chats.push(chat)
      groups.set(key, task)
    }
    return { ...project, chats: [], items: [...project.items, ...groups.values()] }
  })
  return { version: 3, projects }
}

export function todoChats(document: TodoDocument): TodoChat[] {
  return document.projects.flatMap((project) => [...project.chats, ...project.items.flatMap((item) => item.chats)])
}
export function findTodoChat(document: TodoDocument, threadId: string): { chat: TodoChat; destination: TodoDestination } | undefined {
  for (const project of document.projects) {
    const chat = project.chats.find((entry) => entry.thread.id === threadId)
    if (chat) return { chat, destination: { projectId: project.id } }
    for (const item of project.items) {
      const chat = item.chats.find((entry) => entry.thread.id === threadId)
      if (chat) return { chat, destination: { projectId: project.id, itemId: item.id } }
    }
  }
}
function destinationChats(document: TodoDocument, destination: TodoDestination): TodoChat[] | undefined {
  const project = document.projects.find((entry) => entry.id === destination.projectId)
  return destination.itemId ? project?.items.find((item) => item.id === destination.itemId)?.chats : project?.chats
}

export function applyTodo(document: TodoDocument, operation: TodoOperation, id = () => crypto.randomUUID() as string, now = Date.now()): TodoDocument {
  const next = structuredClone(document)
  const project = 'projectId' in operation ? next.projects.find((entry) => entry.id === operation.projectId) : undefined
  const owner = 'itemId' in operation ? next.projects.find((entry) => entry.items.some((item) => item.id === operation.itemId)) : undefined
  const item = 'itemId' in operation ? owner?.items.find((entry) => entry.id === operation.itemId) : undefined
  const text = 'text' in operation && typeof operation.text === 'string' ? operation.text.trim().slice(0, 2000) : ''
  const removeChat = (threadId: string): void => {
    for (const group of next.projects) {
      group.chats = group.chats.filter((chat) => chat.thread.id !== threadId)
      for (const row of group.items) row.chats = row.chats.filter((chat) => chat.thread.id !== threadId)
    }
  }
  switch (operation.type) {
    case 'addItem':
      if (!project || !text) return document
      project.items.push({ id: id(), text, done: false, chats: [] }); break
    case 'editItem':
      if (!item || !text) return document
      item.text = text; break
    case 'completeItem':
      if (!item || typeof operation.done !== 'boolean') return document
      item.done = operation.done; break
    case 'deleteItem':
      if (!owner || !item) return document
      owner.items = owner.items.filter((entry) => entry !== item); break
    case 'moveItem': {
      if (!owner || !item || !project || operation.beforeItemId === item.id) return document
      if (operation.beforeItemId && !project.items.some((entry) => entry.id === operation.beforeItemId)) return document
      owner.items = owner.items.filter((entry) => entry !== item)
      const index = operation.beforeItemId ? project.items.findIndex((entry) => entry.id === operation.beforeItemId) : project.items.length
      project.items.splice(index, 0, item); break
    }
    case 'fileTab': {
      const destination = operation.destination
      const target = destination && next.projects.find((group) => group.id === destination.projectId)
      const entries = Array.isArray(operation.threads) ? operation.threads.flatMap((value) => { const thread = storedThread(value); return thread ? [thread] : [] }) : []
      const name = typeof operation.name === 'string' ? operation.name.trim().slice(0, 2000) : ''
      if (!target || !entries.length || !name) return document
      let itemId = destination.itemId
      if (itemId && !target.items.some((item) => item.id === itemId)) return document
      if (!itemId) {
        const existing = operation.sourceItemId ? findTodoItem(next, operation.sourceItemId) : undefined
        if (existing) {
          for (const group of next.projects) group.items = group.items.filter((item) => item.id !== existing.id)
          target.items.push(existing)
          itemId = existing.id
        } else {
          itemId = id()
          target.items.push({ id: itemId, text: name, done: false, chats: [] })
        }
      }
      return applyTodo(next, { type: 'fileChats', threads: entries, destination: { projectId: target.id, itemId } }, id, now)
    }
    case 'fileChats':
    case 'moveChat': {
      if (!operation.destination || !destinationChats(next, operation.destination)) return document
      const threads = operation.type === 'fileChats' ? operation.threads : [findTodoChat(next, operation.threadId)?.chat.thread]
      if (!Array.isArray(threads)) return document
      const entries = threads.flatMap((value) => { const thread = storedThread(value); return thread ? [thread] : [] })
      if (!entries.length) return document
      if (!operation.destination.itemId) {
        const existing = todoItemForThreads(next, entries.map((thread) => thread.id))
        const entireTask = existing && new Set(entries.map((thread) => thread.id)).size === existing.chats.length
        const name = operation.type === 'fileChats' && typeof operation.name === 'string' ? operation.name.trim() : ''
        return applyTodo(next, { type: 'fileTab', threads: entries, destination: operation.destination,
          name: name || entries[0]!.title || 'Untitled task', ...(entireTask ? { sourceItemId: existing.id } : {}) }, id, now)
      }
      for (const thread of entries) {
        const addedAt = findTodoChat(next, thread.id)?.chat.addedAt ?? now
        removeChat(thread.id)
        destinationChats(next, operation.destination)!.push({ thread, addedAt })
      }
      break
    }
    case 'renameChat': {
      const chat = findTodoChat(next, operation.threadId)?.chat
      if (!chat || !text) return document
      chat.thread.title = text.slice(0, 200)
      break
    }
    case 'removeChat': removeChat(operation.threadId); break
    default: return document
  }
  return next
}
