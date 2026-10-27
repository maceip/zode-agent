import { Context, type Plugin } from 'cordis'
import { expect, it, vi } from 'vitest'
import { WorkspaceLayoutRegistry } from '../program/plugins/workspace-layout.client.js'
import { removeWorkspacePaneKind } from '../program/plugins/workspace-pages.js'
import { parseWorkspaceLayout, type WorkspaceLayoutState, type WorkspaceView } from '../program/plugins/workspace-layout-state.js'

const legacy: WorkspaceView = { id: 'tasks', name: 'TODO', workspace: '/repo', focusedPaneId: 'old', root: { type: 'pane', id: 'old', kind: 'todo', workspace: '/repo' } }
const chat: WorkspaceView = { id: 'chat', name: 'Work', workspace: '/repo', focusedPaneId: 'chat-pane', root: { type: 'pane', id: 'chat-pane', workspace: '/repo', thread: { id: 'thread', title: 'Work', preview: '', cwd: '/repo', createdAt: 1, updatedAt: 2 } } }

it('persists a tab-name binding independently of its conversations and follows source updates', async () => {
  const context = new Context()
  const registry = new WorkspaceLayoutRegistry()
  let title: string | undefined = 'Task name'
  let changed: () => void = () => {}
  const unsubscribe = vi.fn()
  const fiber = await context.plugin(((owner) => {
    registry.registerTabNameSource(owner, {
      id: 'tasks', name: () => title,
      rename: async (_id, next) => { title = next; changed() },
      match: () => 'task-id',
      subscribe: (listener) => { changed = listener; return unsubscribe },
    })
  }) as Plugin)
  let linked = registry.syncTabNames({ version: 2, activeViewId: chat.id, views: [chat] })
  expect(linked.views[0]!.name).toBe('Task name')
  expect(linked.views[0]!.root).toBe(chat.root)
  expect(parseWorkspaceLayout(linked)!.views[0]!.nameBinding).toEqual({ source: 'tasks', id: 'task-id' })
  expect(registry.syncTabNames(linked)).toBe(linked)
  await registry.tabNameSource('tasks')!.rename('task-id', 'Tab edit')
  linked = registry.syncTabNames(linked)
  expect(linked.views[0]!.name).toBe('Tab edit')
  title = 'Task edit'; changed()
  linked = registry.syncTabNames(linked)
  expect(linked.views[0]!.name).toBe('Task edit')
  await fiber.dispose()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(registry.syncTabNames(linked)).toBe(linked)
  registry.dispose()
})

it('drops a deleted name binding while keeping the tab, conversation, and last title', async () => {
  const registry = new WorkspaceLayoutRegistry()
  const context = new Context()
  const fiber = await context.plugin(((owner) => { registry.registerTabNameSource(owner, {
    id: 'tasks', name: () => undefined, rename: async () => {}, subscribe: () => () => {},
  }) }) as Plugin)
  const state: WorkspaceLayoutState = { version: 2, activeViewId: chat.id, views: [{ ...chat, nameBinding: { source: 'tasks', id: 'deleted' } }] }
  expect(registry.syncTabNames(state).views).toEqual([chat])
  await fiber.dispose()
  registry.dispose()
})

it('repairs a stale shared tab name without changing either conversation', async () => {
  const registry = new WorkspaceLayoutRegistry()
  const context = new Context()
  let title = 'backup'
  const binding = { source: 'tasks', id: 'backup-task' }
  const stale: WorkspaceView = { ...chat, id: 'old-backup', name: title, nameBinding: binding }
  const linked: WorkspaceView = { ...chat, id: 'actual-backup', name: title, nameBinding: binding, focusedPaneId: 'backup-pane',
    root: { type: 'pane', id: 'backup-pane', workspace: '/repo', thread: { id: 'backup-thread', title: 'Backup work', preview: '', cwd: '/repo', createdAt: 1, updatedAt: 2 } } }
  const fiber = await context.plugin(((owner) => { registry.registerTabNameSource(owner, {
    id: 'tasks', name: () => title, rename: async (_id, name) => { title = name }, subscribe: () => () => {},
    valid: (_id, view) => view.root.type === 'pane' && view.root.thread?.id === 'backup-thread',
  }) }) as Plugin)
  const state: WorkspaceLayoutState = { version: 2, activeViewId: stale.id, views: [stale, linked] }
  let repaired = registry.syncTabNames(state)
  expect(repaired.views[0]!.nameBinding).toBeUndefined()
  expect(repaired.views[0]!.name).toBe('backup')
  expect(repaired.views[0]!.root).toBe(stale.root)
  expect(repaired.views[1]).toBe(linked)
  await registry.tabNameSource('tasks')!.rename('backup-task', 'New backup name')
  repaired = registry.syncTabNames(repaired)
  expect(repaired.views.map((view) => view.name)).toEqual(['backup', 'New backup name'])
  expect(repaired.views[1]!.root).toBe(linked.root)
  expect(registry.syncTabNames(parseWorkspaceLayout(repaired)!)).toEqual(repaired)
  await fiber.dispose()
  registry.dispose()
})

it('removes legacy page tabs and split panes while preserving chat identities and focus', () => {
  const mixed: WorkspaceView = { ...chat, focusedPaneId: 'old', maximizedPaneId: 'old', root: { type: 'split', id: 'split', direction: 'horizontal', ratio: .5, first: legacy.root, second: chat.root } }
  const state: WorkspaceLayoutState = { version: 2, activeViewId: legacy.id, views: [legacy, mixed] }
  const next = removeWorkspacePaneKind(state, 'todo')
  expect(next.views).toHaveLength(1)
  expect(next.activeViewId).toBe(chat.id)
  expect(next.views[0]!.root).toBe(chat.root)
  expect(next.views[0]!.focusedPaneId).toBe('chat-pane')
  expect(next.views[0]!.maximizedPaneId).toBeUndefined()
  expect(removeWorkspacePaneKind(next, 'todo')).toBe(next)
})

it('leaves a normal new chat when the only saved tab was the old page', () => {
  const next = removeWorkspacePaneKind({ version: 2, activeViewId: legacy.id, views: [legacy] }, 'todo')
  expect(next.views).toHaveLength(1)
  expect(next.activeViewId).toBe(next.views[0]!.id)
  expect(next.views[0]!.root).toMatchObject({ type: 'pane', workspace: '/repo' })
  expect(next.views[0]!.root).not.toHaveProperty('kind')
  expect(next.views[0]!.name).toBe('New chat')
})

it('closes a workspace page without closing a tab, and unregisters it with its owner', async () => {
  const context = new Context()
  const registry = new WorkspaceLayoutRegistry()
  const page = { id: 'tasks', label: 'Tasks', renderer: () => null }
  const plugin: Plugin = (owner) => { registry.registerPage(owner, page) }
  const fiber = await context.plugin(plugin)
  registry.showPage('tasks')
  expect(registry.activePage()).toBe(page)
  expect(registry.tabs()).toEqual([])
  expect(registry.canCloseActiveTab()).toBe(true)
  registry.closeActiveTab()
  expect(registry.activePage()).toBeUndefined()
  registry.showPage('tasks')
  await fiber.dispose()
  expect(registry.pages()).toEqual([])
  expect(registry.activePage()).toBeUndefined()
  registry.dispose()
})
