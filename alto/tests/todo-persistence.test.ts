import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import todo from '../program/plugins/todo.js'
import { findTodoChat, TODO_APPLY, type TodoDocument } from '../program/plugins/todo-api.js'
import { WORKSPACE_LAYOUT_READ_METHOD } from '../program/plugins/workspace-layout-state.js'
import type { HarnessContext } from '../src/server/plugin-api.js'
import type { JsonValue, ProjectSnapshot } from '../src/shared/protocol.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture(root?: string, layout?: JsonValue) {
  root ??= await mkdtemp(path.join(os.tmpdir(), 'alto-todo-'))
  roots.push(root)
  const methods = new Map<string, (payload: JsonValue) => Promise<JsonValue>>()
  const cleanup: Array<() => unknown> = []
  const renameConversation = vi.fn(async (method: string, _payload: JsonValue | undefined): Promise<JsonValue> => method === WORKSPACE_LAYOUT_READ_METHOD ? layout ?? null : { ok: true })
  let state: JsonValue | undefined
  let projects = [{ id: 'alto-alpha', name: 'alpha', primaryRoot: '/alpha', roots: ['/alpha'] }, { id: 'alto-beta', name: 'beta', primaryRoot: '/beta', roots: ['/beta'] }]
  let changed: ((snapshot: ProjectSnapshot) => void) | undefined
  const ctx = {
    program: { projectRoot: root },
    projects: { snapshot: () => ({ revision: 1, projects }) },
    on: (_event: string, listener: typeof changed) => { changed = listener },
    effect: (effect: () => () => unknown) => { cleanup.push(effect()) },
    ui: { registerSurface: () => {} },
    clientExtensions: {
      call: renameConversation,
      registerState: (_ctx: unknown, _id: string, initial: JsonValue) => { state = initial; return { update: (next: JsonValue) => { state = next } } },
      registerMethod: (_ctx: unknown, id: string, method: (payload: JsonValue) => Promise<JsonValue>) => { methods.set(id, method) },
    },
  } as unknown as HarnessContext
  await (todo as (ctx: HarnessContext) => Promise<void>)(ctx)
  return { root, methods, cleanup, renameConversation, snapshot: () => state as unknown as TodoDocument, setProjects(next: typeof projects) { projects = next; changed?.({ revision: 2, projects }) } }
}

it.each(['codex-thread', 'acp-12345678-1234-1234-1234-123456789abc'])('renames and persists the actual conversation %s without moving it', async (id) => {
  const plugin = await fixture()
  const apply = plugin.methods.get(TODO_APPLY)!
  const thread = { id, title: 'Old title', cwd: '/repo', preview: 'Preview', createdAt: 1, updatedAt: 2 }
  await apply({ type: 'fileChats', threads: [thread], destination: { projectId: 'alto-beta' } })
  await apply({ type: 'renameChat', threadId: id, text: '  Ship the fix  ' })
  expect(plugin.renameConversation).toHaveBeenCalledWith(id.startsWith('acp-') ? 'agent-chats.rename' : 'session.thread.rename',
    id.startsWith('acp-') ? { id, title: 'Ship the fix' } : { threadId: id, name: 'Ship the fix' })
  expect(findTodoChat(plugin.snapshot(), id)!.chat.thread).toEqual({ ...thread, title: 'Ship the fix' })
  const restored = await fixture(plugin.root)
  expect(restored.snapshot()).toEqual(plugin.snapshot())
  for (const dispose of [...plugin.cleanup, ...restored.cleanup]) await dispose()
})

it('keeps the saved title when the provider rejects a rename', async () => {
  const plugin = await fixture()
  const apply = plugin.methods.get(TODO_APPLY)!
  await apply({ type: 'fileChats', threads: [{ id: 'chat', title: 'Old title', cwd: '/repo' }], destination: { projectId: 'unsorted' } })
  const before = plugin.snapshot()
  plugin.renameConversation.mockRejectedValueOnce(new Error('Provider unavailable'))
  await expect(apply({ type: 'renameChat', threadId: 'chat', text: 'New title' })).rejects.toThrow('Provider unavailable')
  expect(plugin.snapshot()).toEqual(before)
  expect(JSON.parse(await readFile(path.join(plugin.root, '.codex-cordis/todo.json'), 'utf8'))).toEqual(before)
  await expect(apply({ type: 'renameChat', threadId: 'missing', text: 'New title' })).rejects.toThrow()
  await expect(apply({ type: 'renameChat', threadId: 'chat', text: '  ' })).rejects.toThrow()
  expect(plugin.renameConversation).toHaveBeenCalledTimes(1)
  for (const dispose of plugin.cleanup) await dispose()
})

it('reports a partial save and allows retry when the conversation was renamed but Tasks could not write', async () => {
  const plugin = await fixture()
  const apply = plugin.methods.get(TODO_APPLY)!
  await apply({ type: 'fileChats', threads: [{ id: 'chat', title: 'Old title', cwd: '/repo' }], destination: { projectId: 'unsorted' } })
  const file = path.join(plugin.root, '.codex-cordis/todo.json')
  await rm(file)
  await mkdir(file)
  await expect(apply({ type: 'renameChat', threadId: 'chat', text: 'New title' })).rejects.toThrow('Conversation renamed, but Tasks could not save')
  await rm(file, { recursive: true })
  await apply({ type: 'renameChat', threadId: 'chat', text: 'New title' })
  expect(findTodoChat(plugin.snapshot(), 'chat')!.chat.thread.title).toBe('New title')
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(plugin.snapshot())
  for (const dispose of plugin.cleanup) await dispose()
})

it('serializes concurrent edits and restores their data after the plugin reloads', async () => {
  const first = await fixture()
  const apply = first.methods.get(TODO_APPLY)!
  await Promise.all([apply({ type: 'addItem', projectId: 'alto-alpha', text: 'First' }), apply({ type: 'addItem', projectId: 'alto-beta', text: 'Second' })])
  expect(first.snapshot().projects.map((project) => project.name)).toEqual(['alpha', 'beta', 'Unsorted'])
  const saved = JSON.parse(await readFile(path.join(first.root, '.codex-cordis/todo.json'), 'utf8'))
  expect(saved).toEqual(first.snapshot())
  for (const dispose of first.cleanup) await dispose()
  const restored = await fixture(first.root)
  expect(restored.snapshot()).toEqual(saved)
  for (const dispose of restored.cleanup) await dispose()
})

it.each([2, 3])('persists and publishes task rows for bare chats saved in version %s', async (version) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alto-todo-'))
  roots.push(root)
  await mkdir(path.join(root, '.codex-cordis'))
  const thread = { id: 'chat', title: 'Conversation name', cwd: '/repo', preview: '', createdAt: 1, updatedAt: 2 }
  const file = path.join(root, '.codex-cordis/todo.json')
  await writeFile(file, JSON.stringify({ version, projects: [{ id: 'alto-beta', name: 'beta', items: [], chats: [{ thread, addedAt: 123 }] }] }))
  const layout = { version: 2, activeViewId: 'tab', views: [{ id: 'tab', name: 'Task name', focusedPaneId: 'pane', root: { type: 'pane', id: 'pane', workspace: '/repo', thread } }] }
  const plugin = await fixture(root, layout)
  const beta = plugin.snapshot().projects.find((project) => project.id === 'alto-beta')!
  expect(beta.chats).toEqual([])
  expect(beta.items).toEqual([{ id: expect.any(String), text: 'Task name', done: false, chats: [{ thread, addedAt: 123 }] }])
  const saved = JSON.parse(await readFile(file, 'utf8')) as TodoDocument
  expect(saved.projects.find((project) => project.id === 'alto-beta')).toEqual(beta)
  for (const dispose of plugin.cleanup) await dispose()
  const restored = await fixture(root, layout)
  expect(restored.snapshot()).toEqual(plugin.snapshot())
  expect(restored.renameConversation).not.toHaveBeenCalled()
  for (const dispose of restored.cleanup) await dispose()
})

it('deletes a task without deleting its conversations or recreating task rows on reload', async () => {
  const plugin = await fixture()
  const apply = plugin.methods.get(TODO_APPLY)!
  await apply({ type: 'fileChats', threads: [{ id: 'chat', title: 'Conversation', cwd: '/repo' }], destination: { projectId: 'alto-beta' } })
  const itemId = findTodoChat(plugin.snapshot(), 'chat')!.destination.itemId!
  await apply({ type: 'deleteItem', itemId })
  expect(findTodoChat(plugin.snapshot(), 'chat')).toBeUndefined()
  expect(plugin.renameConversation).not.toHaveBeenCalled()
  for (const dispose of plugin.cleanup) await dispose()
  const restored = await fixture(plugin.root)
  expect(restored.snapshot().projects.every((project) => !project.items.length && !project.chats.length)).toBe(true)
  for (const dispose of restored.cleanup) await dispose()
})

it('does not replace a corrupt saved document with an empty list', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alto-todo-'))
  roots.push(root)
  await mkdir(path.join(root, '.codex-cordis'))
  const file = path.join(root, '.codex-cordis/todo.json')
  await writeFile(file, '{incomplete')
  await expect(fixture(root)).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('{incomplete')
})


it('updates groups from the registry and rejects standalone project operations', async () => {
  const plugin = await fixture()
  const apply = plugin.methods.get(TODO_APPLY)!
  await apply({ type: 'addItem', projectId: 'alto-alpha', text: 'Keep this task' })
  plugin.setProjects([{ id: 'alto-alpha', name: 'Renamed', primaryRoot: '/alpha', roots: ['/alpha'] }])
  expect(plugin.snapshot().projects.map((group) => group.name)).toEqual(['Renamed', 'Unsorted'])
  expect(plugin.snapshot().projects[0]!.items[0]!.text).toBe('Keep this task')
  await expect(apply({ type: 'addProject', name: 'Independent' })).rejects.toThrow()
  await expect(apply({ type: 'addItem', projectId: 'alto-beta', text: 'Stale destination' })).rejects.toThrow('no longer available')
  plugin.setProjects([])
  expect(plugin.snapshot().projects[0]!.items[0]!.text).toBe('Keep this task')
  await apply({ type: 'addItem', projectId: 'unsorted', text: 'Unsorted task' })
  plugin.setProjects([{ id: 'alto-alpha', name: 'Back', primaryRoot: '/alpha', roots: ['/alpha'] }])
  expect(plugin.snapshot().projects[0]!.items[0]!.text).toBe('Keep this task')
  for (const dispose of plugin.cleanup) await dispose()
})
