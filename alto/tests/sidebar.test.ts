import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  historyWithOpenWorkspaceThreads,
  SidebarController,
  sidebarWidthBounds,
} from '../program/plugins/sidebar.client.js'
import type { HistoryState } from '../program/plugins/ui/history-model.js'
import type { WorkspaceTabTarget } from '../program/plugins/workspace-layout-api.js'
import type { ThreadSummary } from '../src/shared/protocol.js'

describe('open workspace chat history', () => {
  const thread = (id: string, projectId?: string): ThreadSummary => ({
    id, title: id, preview: '', cwd: '/repo', createdAt: 1, updatedAt: 1,
    ...(projectId ? { projectId } : {}),
  })
  const tab = (...threads: ThreadSummary[]): WorkspaceTabTarget => ({
    id: 'workspace', title: 'Workspace', active: true,
    threadIds: threads.map(({ id }) => id), threads,
  })

  it('shows a new pane chat before history refresh completes, without duplicate rows', () => {
    const history: HistoryState = { tag: 'loading', entries: [thread('listed')] }
    const pending = thread('new', 'project')
    const merged = historyWithOpenWorkspaceThreads(history, [tab(pending), tab(pending, thread('listed'))])
    expect(merged.tag).toBe('loading')
    expect(merged.entries).toEqual([thread('listed'), pending])
    expect(history.entries).toHaveLength(1)
  })

  it('retains a provisional project assignment without replacing fresher global metadata', () => {
    const listed = { ...thread('new'), title: 'Renamed chat', updatedAt: 10 }
    const history: HistoryState = { tag: 'ready', entries: [listed, thread('assigned', 'authoritative')] }
    const merged = historyWithOpenWorkspaceThreads(history, [tab(thread('new', 'project'), thread('assigned', 'stale'))])
    expect(merged.entries).toEqual([{ ...listed, projectId: 'project' }, thread('assigned', 'authoritative')])
    expect(listed.projectId).toBeUndefined()
  })

  it('keeps history failure information and reuses the snapshot when no pane adds information', () => {
    const history: HistoryState = { tag: 'failed', entries: [thread('listed')], problem: 'Offline' }
    expect(historyWithOpenWorkspaceThreads(history, [tab(thread('listed'))])).toBe(history)
    expect(historyWithOpenWorkspaceThreads(history, [tab(thread('new'))])).toMatchObject({
      tag: 'failed', problem: 'Offline', entries: [thread('listed'), thread('new')],
    })
  })
})

describe('sidebar resizing', () => {
  it('uses restrained defaults', () => {
    expect(sidebarWidthBounds()).toEqual({ min: 196, max: 420 })
    expect(clampSidebarWidth(120, sidebarWidthBounds())).toBe(196)
    expect(clampSidebarWidth(600, sidebarWidthBounds())).toBe(420)
  })

  it('stops growing before it starves the conversation', () => {
    expect(sidebarWidthBounds({}, {
      currentWidth: 246,
      conversationWidth: 560,
    })).toEqual({ min: 196, max: 420 })
    expect(sidebarWidthBounds({}, {
      currentWidth: 246,
      conversationWidth: 430,
    })).toEqual({ min: 196, max: 316 })
    expect(sidebarWidthBounds({}, {
      currentWidth: 420,
      conversationWidth: 330,
    })).toEqual({ min: 196, max: 390 })
  })

  it('honors plugin configuration', () => {
    expect(sidebarWidthBounds({
      minWidth: 210,
      maxWidth: 480,
      minConversationWidth: 400,
    }, {
      currentWidth: 250,
      conversationWidth: 500,
    })).toEqual({ min: 210, max: 350 })
  })

  it('moves between hidden, floating, and pinned states', () => {
    const sidebar = new SidebarController()
    let notifications = 0
    const unsubscribe = sidebar.subscribe(() => notifications += 1)

    expect(sidebar.snapshot()).toEqual({
      revision: 0,
      mode: 'hidden',
      collapsed: true,
      pinned: false,
      workspaceKey: 'default',
    })
    sidebar.toggle()
    expect(sidebar.snapshot()).toMatchObject({ revision: 1, mode: 'pinned', collapsed: false, pinned: true })
    sidebar.toggle()
    expect(sidebar.snapshot()).toMatchObject({ revision: 2, mode: 'hidden', collapsed: true, pinned: false })
    sidebar.setCollapsed(false)
    expect(sidebar.snapshot()).toMatchObject({ revision: 3, mode: 'floating', collapsed: false })
    sidebar.toggle()
    expect(sidebar.snapshot()).toMatchObject({ revision: 4, mode: 'pinned', pinned: true })
    sidebar.setPinned(false)
    expect(sidebar.snapshot()).toMatchObject({ revision: 5, mode: 'floating', pinned: false })
    sidebar.activateWorkspace('workspace-b')
    expect(sidebar.snapshot()).toMatchObject({
      revision: 6,
      mode: 'hidden',
      pinned: false,
      workspaceKey: 'workspace-b',
    })
    sidebar.setPinned(true)
    expect(sidebar.snapshot()).toMatchObject({ revision: 7, mode: 'pinned', pinned: true })
    sidebar.activateWorkspace('workspace-c')
    expect(sidebar.snapshot()).toMatchObject({
      revision: 8,
      mode: 'pinned',
      pinned: true,
      workspaceKey: 'workspace-c',
    })
    expect(notifications).toBe(8)

    unsubscribe()
    sidebar.dispose()
  })

  it('orders plugin actions and removes them with their fibers', async () => {
    const context = new Context()
    const sidebar = new SidebarController()
    const Later = () => null
    const Earlier = () => null
    const laterFiber = await context.plugin((ctx) => {
      sidebar.registerAction(ctx, { id: 'later', order: 200, renderer: Later })
    })
    const earlierFiber = await context.plugin((ctx) => {
      sidebar.registerAction(ctx, { id: 'earlier', order: 100, renderer: Earlier })
    })

    try {
      expect(sidebar.actions().map((action) => action.id)).toEqual(['earlier', 'later'])

      await earlierFiber.dispose()
      expect(sidebar.actions().map((action) => action.id)).toEqual(['later'])
    } finally {
      await laterFiber.dispose()
      sidebar.dispose()
    }
  })
})
