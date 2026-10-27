import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isAgentChatId } from './agent-chats-api.js'
import { SESSION_THREAD_RENAME } from './session-api.js'
import { parseWorkspaceLayout, WORKSPACE_LAYOUT_READ_METHOD } from './workspace-layout-state.js'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import { applyTodo, emptyTodo, findTodoChat, migrateTodoProjects, migrateTodoTasks, parseTodo, todoForProjects, todoWithProjects, TODO_APPLY, TODO_STATE, TODO_UNSORTED_ID, type TodoDocument, type TodoOperation } from './todo-api.js'

export async function writeTodo(file: string, document: TodoDocument): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

const todo: HarnessPlugin = async (ctx) => {
  let live = true
  let saving = Promise.resolve()
  const extensions = ctx.clientExtensions
  ctx.effect(() => () => { live = false; return saving.catch(() => {}) }, 'todo.persistence')
  const file = path.join(ctx.program.projectRoot, '.codex-cordis', 'todo.json')
  let document = emptyTodo()
  try { document = parseTodo(JSON.parse(await readFile(file, 'utf8'))) }
  catch (error) { if (!(isRecord(error) && error.code === 'ENOENT')) throw error }
  if (!live) return
  document = migrateTodoProjects(document, ctx.projects.snapshot().projects)
  if (document.version !== 3 || document.projects.some((project) => project.chats.length)) {
    const layout = document.projects.some((project) => project.chats.length)
      ? parseWorkspaceLayout(await extensions.call(WORKSPACE_LAYOUT_READ_METHOD, undefined)) : undefined
    if (!live) return
    document = migrateTodoTasks(document, layout, randomUUID)
    await writeTodo(file, document)
    if (!live) return
  }
  const current = (): TodoDocument => todoForProjects(document, ctx.projects.snapshot().projects)
  const state = ctx.clientExtensions.registerState(ctx, TODO_STATE, current() as unknown as JsonValue)
  // Project sources can temporarily disappear while their plugin reloads. Keep
  // their saved IDs and derive the visible Unsorted group without rewriting disk.
  const publish = (): void => { if (live) state.update(current() as unknown as JsonValue) }
  ctx.on('projects/changed', publish)
  ctx.clientExtensions.registerMethod(ctx, TODO_APPLY, (payload) => {
    if (!isRecord(payload) || typeof payload.type !== 'string') throw new Error('A task operation is required')
    const pending = saving.catch(() => {}).then(async () => {
      if (!live) throw new Error('Tasks is unavailable')
      const projects = ctx.projects.snapshot().projects
      const destination = isRecord(payload.destination) ? payload.destination.projectId : payload.projectId
      if (destination !== undefined && destination !== TODO_UNSORTED_ID && !projects.some((project) => project.id === destination)) {
        throw new Error('That Alto project is no longer available')
      }
      const before = todoWithProjects(document, projects)
      const next = applyTodo(before, payload as unknown as TodoOperation, randomUUID)
      if (next === before) throw new Error('That task or destination is no longer available')
      if (payload.type === 'renameChat') {
        const thread = findTodoChat(next, String(payload.threadId))!.chat.thread
        // Rename through the existing provider path before changing the saved Tasks title.
        await extensions.call(isAgentChatId(thread.id) ? 'agent-chats.rename' : SESSION_THREAD_RENAME,
          isAgentChatId(thread.id) ? { id: thread.id, title: thread.title } : { threadId: thread.id, name: thread.title })
      }
      // A successful response means the links are on disk, so the caller can close the tab.
      try { await writeTodo(file, next) }
      catch (error) {
        if (payload.type === 'renameChat') throw new Error('Conversation renamed, but Tasks could not save the title. Retry to finish saving.', { cause: error })
        throw error
      }
      document = next
      publish()
    })
    saving = pending
    return pending.then(() => current() as unknown as JsonValue)
  })
  ctx.ui.registerSurface(ctx, { id: 'todo-button', kind: 'todo-button', label: 'Tasks', data: { slot: 'header-end', order: 10 } })
}
todo.inject = ['clientExtensions', 'program', 'projects', 'ui']
export default todo
