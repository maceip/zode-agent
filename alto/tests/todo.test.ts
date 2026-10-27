import { describe, expect, it } from 'vitest'
import type { ThreadSummary } from '../src/shared/protocol.js'
import { applyTodo, emptyTodo, findTodoChat, findTodoItem, todoItemForThreads, parseTodo, migrateTodoProjects, migrateTodoTasks, todoForProjects, todoWithProjects, TODO_UNSORTED_ID, todoChats, type TodoDocument, type TodoOperation } from '../program/plugins/todo-api.js'
import { parseWorkspaceLayout } from '../program/plugins/workspace-layout-state.js'
import { workspaceViewPaneKinds, workspaceViewThreads } from '../program/plugins/workspace-layout.client.js'

function thread(id: string, extra: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id, title: 'Chat ' + id, preview: '', cwd: '/repo', createdAt: 1, updatedAt: 2, ...extra }
}

function run(document: TodoDocument, ...operations: TodoOperation[]): TodoDocument {
  let serial = 0
  return operations.reduce((current, operation) => applyTodo(current, operation, () => 'id-' + ++serial, 10), document)
}

function board(): TodoDocument {
  let serial = 0
  const id = () => ['do-this', 'foo', 'blah'][serial++]!
  return [
    { type: 'addItem', projectId: 'alpha', text: 'do this' },
    { type: 'addItem', projectId: 'alpha', text: 'foo' },
    { type: 'addItem', projectId: 'beta', text: 'blah' },
  ].reduce((current, operation) => applyTodo(current, operation as TodoOperation, id), todoForProjects(emptyTodo(), [{ id: 'alpha', name: 'alpha' }, { id: 'beta', name: 'beta' }]))
}

describe('todo list', () => {
  it('creates one task from a tab name and preserves its conversations and identity when refiled', () => {
    const conversations = [thread('t1'), thread('t2')]
    const filed = run(board(), { type: 'fileTab', name: 'Release work', threads: conversations, destination: { projectId: 'alpha' } })
    const task = todoItemForThreads(filed, ['t1', 't2'])!
    expect(task.text).toBe('Release work')
    expect(task.chats.map((chat) => chat.thread)).toEqual(conversations)
    const renamed = run(filed, { type: 'editItem', itemId: task.id, text: 'Ready to ship' })
    expect(findTodoItem(renamed, task.id)!.chats).toEqual(task.chats)
    const refiled = run(renamed, { type: 'fileTab', sourceItemId: task.id, name: 'Ready to ship', threads: conversations, destination: { projectId: 'beta' } })
    expect(refiled.projects[0]!.items.some((item) => item.id === task.id)).toBe(false)
    expect(refiled.projects[1]!.items.find((item) => item.id === task.id)!.text).toBe('Ready to ship')
    expect(todoChats(refiled)).toHaveLength(2)
  })

  it('uses an existing task name when a tab is filed into it', () => {
    const filed = run(board(), { type: 'fileTab', name: 'Different tab name', threads: [thread('t1')], destination: { projectId: 'alpha', itemId: 'foo' } })
    expect(todoItemForThreads(filed, ['t1'])!.text).toBe('foo')
    expect(findTodoChat(filed, 't1')!.chat.thread.title).toBe('Chat t1')
    expect(todoItemForThreads(filed, ['t1', 'unrelated'])).toBeUndefined()
    expect(run(filed, { type: 'fileTab', name: 'Invalid', threads: [], destination: { projectId: 'beta' } })).toBe(filed)
  })

  it.each([2, 3] as const)('repairs project-level chats in version %s using a saved tab name once', (version) => {
    const first = thread('t1'), second = thread('t2')
    const legacy = { ...board(), version }
    legacy.projects[1]!.chats = [first, second].map((thread) => ({ thread, addedAt: 10 }))
    const layout = parseWorkspaceLayout({ version: 2, activeViewId: 'tab', views: [{ id: 'tab', name: 'Release work', focusedPaneId: 'one', root: { type: 'split', id: 'split', direction: 'horizontal', ratio: .5, first: { type: 'pane', id: 'one', workspace: '/repo', thread: first }, second: { type: 'pane', id: 'two', workspace: '/repo', thread: second } } }] })
    const migrated = migrateTodoTasks(legacy, layout, () => 'migrated')
    expect(migrated.version).toBe(3)
    expect(migrated.projects[1]!.chats).toEqual([])
    expect(findTodoItem(migrated, 'migrated')).toMatchObject({ text: 'Release work', chats: [{ thread: first }, { thread: second }] })
    expect(migrateTodoTasks(migrated, layout, () => 'unused')).toBe(migrated)
  })

  it('keeps Unsorted as the last, permanent project', () => {
    const state = board()
    expect(state.projects.map((project) => project.name)).toEqual(['alpha', 'beta', 'Unsorted'])
    expect(parseTodo({ projects: [{ id: TODO_UNSORTED_ID, name: 'x' }, { id: 'a', name: 'A' }] }).projects.map((project) => project.id))
      .toEqual(['a', TODO_UNSORTED_ID])
  })

  it('files a chat in exactly one place and moves it between items and projects', () => {
    const filed = run(board(), { type: 'fileChats', threads: [thread('t1'), thread('t2')], destination: { projectId: 'alpha', itemId: 'foo' } })
    expect(filed.projects[0]!.items[1]!.chats.map((chat) => chat.thread.id)).toEqual(['t1', 't2'])

    const refiled = run(filed, { type: 'fileChats', threads: [thread('t1')], destination: { projectId: TODO_UNSORTED_ID } })
    expect(todoChats(refiled).map((chat) => chat.thread.id).sort()).toEqual(['t1', 't2'])
    const firstTask = todoItemForThreads(refiled, ['t1'])!
    expect(firstTask.text).toBe('Chat t1')
    expect(findTodoChat(refiled, 't1')?.destination).toEqual({ projectId: TODO_UNSORTED_ID, itemId: firstTask.id })

    const moved = run(refiled, { type: 'moveChat', threadId: 't2', destination: { projectId: 'beta' } })
    expect(findTodoChat(moved, 't2')?.destination).toEqual({ projectId: 'beta', itemId: 'foo' })
    expect(findTodoItem(moved, 'foo')?.text).toBe('foo')
    expect(moved.projects.every((project) => !project.chats.length)).toBe(true)
    expect(run(moved, { type: 'removeChat', threadId: 't2' }).projects[1]!.chats).toEqual([])
  })

  it('uses the open tab name for a new task and keeps a whole task intact when moving its conversation', () => {
    const filed = run(board(), { type: 'fileChats', threads: [thread('t1')], name: 'Release work', destination: { projectId: 'beta' } })
    const task = todoItemForThreads(filed, ['t1'])!
    expect(task.text).toBe('Release work')
    expect(task.chats[0]!.thread.title).toBe('Chat t1')
    const completed = run(filed, { type: 'completeItem', itemId: task.id, done: true })
    const moved = run(completed, { type: 'moveChat', threadId: 't1', destination: { projectId: TODO_UNSORTED_ID } })
    expect(todoItemForThreads(moved, ['t1'])).toEqual({ ...task, done: true })
    expect(moved.projects.at(-1)!.items).toHaveLength(1)
    expect(moved.projects.every((project) => !project.chats.length)).toBe(true)
  })

  it('rejects destinations that do not exist', () => {
    const state = board()
    expect(run(state, { type: 'fileChats', threads: [thread('t1')], destination: { projectId: 'missing' } })).toBe(state)
    expect(run(state, { type: 'fileChats', threads: [thread('t1')], destination: { projectId: 'beta', itemId: 'foo' } })).toBe(state)
  })

  it('renames a nested conversation without changing its task or provider metadata', () => {
    const filed = run(board(), { type: 'fileChats', threads: [thread('t1', { providerId: 'claude-acp', providerSessionId: 'session' })], destination: { projectId: 'alpha', itemId: 'foo' } })
    const renamed = run(filed, { type: 'renameChat', threadId: 't1', text: '  Finish the task  ' })
    const before = findTodoChat(filed, 't1')!
    const after = findTodoChat(renamed, 't1')!
    expect(after.destination).toEqual(before.destination)
    expect(after.chat).toEqual({ ...before.chat, thread: { ...before.chat.thread, title: 'Finish the task' } })
    expect(renamed.projects[0]!.items[1]!.text).toBe('foo')
    expect(run(renamed, { type: 'renameChat', threadId: 't1', text: ' ' })).toBe(renamed)
    expect(run(renamed, { type: 'renameChat', threadId: 'missing', text: 'New title' })).toBe(renamed)
    expect(findTodoChat(run(renamed, { type: 'renameChat', threadId: 't1', text: 'x'.repeat(250) }), 't1')!.chat.thread.title).toHaveLength(200)
  })

  it('removes a deleted task and its links without leaving uncounted project chats', () => {
    const filed = run(board(), { type: 'fileChats', threads: [thread('t1')], destination: { projectId: 'alpha', itemId: 'do-this' } })
    const withoutItem = run(filed, { type: 'deleteItem', itemId: 'do-this' })
    expect(findTodoChat(withoutItem, 't1')).toBeUndefined()
    expect(findTodoItem(withoutItem, 'do-this')).toBeUndefined()
    expect(withoutItem.projects[0]!.chats).toEqual([])
    const withoutProject = todoForProjects(filed, [{ id: 'beta', name: 'beta' }])
    expect(findTodoChat(withoutProject, 't1')?.destination).toEqual({ projectId: TODO_UNSORTED_ID, itemId: 'do-this' })
  })

  it('reorders items within and across projects', () => {
    const state = run(board(), { type: 'moveItem', itemId: 'foo', projectId: 'alpha', beforeItemId: 'do-this' })
    expect(state.projects[0]!.items.map((item) => item.id)).toEqual(['foo', 'do-this'])
    const across = run(state, { type: 'moveItem', itemId: 'foo', projectId: 'beta' })
    expect(across.projects.map((project) => project.items.map((item) => item.id))).toEqual([['do-this'], ['blah', 'foo'], []])
  })

  it('stores chat summaries that Workspace Layout accepts when reopened', () => {
    const live = thread('t1', {
      providerId: 'claude-acp', projectId: 'p', gitInfo: { branch: 'main' },
      status: { type: 'active', activeFlags: [] }, canAcceptDirectInput: true,
    })
    const stored = findTodoChat(run(board(), { type: 'fileChats', threads: [live], destination: { projectId: 'beta' } }), 't1')!.chat.thread
    expect(stored).not.toHaveProperty('status')
    expect(stored).toMatchObject({ id: 't1', providerId: 'claude-acp', projectId: 'p', gitInfo: { branch: 'main' } })
    const pane = { type: 'pane' as const, id: 'pane', workspace: '/repo', projectId: 'p', thread: stored }
    expect(parseWorkspaceLayout({
      version: 2, activeViewId: 'v', views: [{ id: 'v', name: 'V', workspace: '/repo', focusedPaneId: 'pane', root: pane }],
    })).toBeDefined()
  })

  it('reads chats and pane kinds from a split tab', () => {
    const view = {
      id: 'v', name: 'V', workspace: '/repo', focusedPaneId: 'a',
      root: {
        type: 'split' as const, id: 's', direction: 'horizontal' as const, ratio: 0.5,
        first: { type: 'pane' as const, id: 'a', workspace: '/repo', thread: thread('t1') },
        second: { type: 'pane' as const, id: 'b', workspace: '/repo', kind: 'todo' },
      },
    }
    expect(workspaceViewThreads(view).map((entry) => entry.id)).toEqual(['t1'])
    expect(workspaceViewPaneKinds(view)).toEqual(['chat', 'todo'])
  })
})


describe('Alto project mapping', () => {
  it('uses stable IDs for renames and keeps same-named projects distinct', () => {
    const saved = run(board(), { type: 'fileChats', threads: [thread('t1')], destination: { projectId: 'alpha', itemId: 'foo' } })
    const projected = todoForProjects(saved, [{ id: 'alpha', name: 'Renamed' }, { id: 'other', name: 'Renamed' }])
    expect(projected.projects.map((project) => project.name)).toEqual(['Renamed', 'Renamed', 'Unsorted'])
    expect(projected.projects[0]!.items).toEqual(saved.projects[0]!.items)
    expect(projected.projects[1]!.items).toEqual([])
    expect(projected.projects[2]!.items[0]!.id).toBe('blah')
    expect(findTodoChat(projected, 't1')?.destination.projectId).toBe('alpha')
  })

  it('migrates uniquely named legacy groups and preserves unmatched work in Unsorted', () => {
    const legacy: TodoDocument = { ...board(), version: 1 }
    const migrated = migrateTodoProjects(legacy, [{ id: 'alto-alpha', name: 'ALPHA' }])
    expect(migrated.version).toBe(2)
    expect(migrated.projects.find((group) => group.id === 'alto-alpha')!.items.map((item) => item.id)).toEqual(['do-this', 'foo'])
    expect(migrated.projects.find((group) => group.id === TODO_UNSORTED_ID)!.items[0]!.id).toBe('blah')
    const ambiguous = todoForProjects(legacy, [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'alpha' }])
    expect(ambiguous.projects.at(-1)!.items).toHaveLength(3)
  })

  it('preserves project IDs while a project source is temporarily unavailable', () => {
    const saved = board()
    const missing = [{ id: 'beta', name: 'beta' }]
    const edited = run(todoWithProjects(saved, missing), { type: 'addItem', projectId: 'beta', text: 'Another task' })
    expect(todoForProjects(edited, missing).projects.at(-1)!.items).toHaveLength(2)
    expect(todoForProjects(edited, [{ id: 'alpha', name: 'Alpha' }, ...missing]).projects[0]!.items).toHaveLength(2)
  })
})
