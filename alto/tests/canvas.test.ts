import { Context, type Plugin } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  CanvasRegistry,
  canvasPageContentsForWorkspace,
  canvasPageIdForContent,
  canvasPageTitle,
  canvasPageScopeKey,
  canvasWorkspace,
  canvasWorkspaceKey,
  nextBlankCanvasPage,
  nextCanvasPageTitle,
  reorderCanvasPages,
} from '../program/plugins/canvas.client.js'

const session = {
  activeProjectId: 'project-1',
  threadId: 'thread-1',
  session: {
    workspace: '/tmp/project',
    permissionMode: 'ask' as const,
  },
}

describe('canvas plugin', () => {
  it('derives one stable persistence identity per workspace', () => {
    expect(canvasWorkspaceKey(session)).toBe('workspace:project-1')
    expect(canvasWorkspaceKey({
      activeProjectId: undefined,
      session: session.session,
    })).toBe('workspace:/tmp/project')
    expect(canvasPageScopeKey('workspace:project-1', 'page-2'))
      .toBe('workspace:project-1:page:page-2')
    expect(canvasPageIdForContent('build/status')).toBe('content:build%2Fstatus')
    expect(canvasWorkspace({ ...session, projects: [{
      id: 'project-1',
      name: 'Project One',
      roots: ['/tmp/project'],
      primaryRoot: '/tmp/project',
      source: 'local',
    }] })).toMatchObject({
      key: 'workspace:project-1',
      name: 'Project One',
      path: '/tmp/project',
      projectId: 'project-1',
    })
  })

  it('filters registered pages before another workspace can create or restore them', () => {
    const global = { id: 'global', title: 'Global', component: () => null }
    const atlas = {
      id: 'atlas-status',
      title: 'Atlas status',
      component: () => null,
      availableIn: (workspace: { name: string }) => workspace.name === 'atlas',
    }

    expect(canvasPageContentsForWorkspace([global, atlas], {
      key: 'workspace:atlas',
      name: 'atlas',
      path: '/work/atlas',
    }).map((page) => page.id)).toEqual(['global', 'atlas-status'])
    expect(canvasPageContentsForWorkspace([global, atlas], {
      key: 'workspace:beacon',
      name: 'beacon',
      path: '/work/beacon',
    }).map((page) => page.id)).toEqual(['global'])
  })

  it('lets a page derive its tab title from the current workspace', () => {
    expect(canvasPageTitle({
      id: 'terminal',
      title: 'Terminal',
      titleForWorkspace: (workspace) => workspace.name,
      component: () => null,
    }, {
      key: 'workspace:cod',
      name: 'cod',
      path: '/work/cod',
    })).toBe('cod')
  })

  it('uses the first available human-readable page title', () => {
    expect(nextCanvasPageTitle([
      { id: 'main', title: 'Canvas 1' },
      { id: 'page-3', title: 'Canvas 3' },
      { id: 'named', title: 'Research' },
    ])).toBe('Canvas 2')
  })

  it('creates a blank page instead of restoring closed plugin content', () => {
    expect(nextBlankCanvasPage([
      { id: 'content:ghostty-terminal', title: 'cod' },
      { id: 'page-1', title: 'Canvas 1' },
    ], 3)).toEqual({
      id: 'page-3',
      title: 'Canvas 2',
    })
  })

  it('reorders pages on either side of a drop target', () => {
    const pages = [
      { id: 'one', title: 'One' },
      { id: 'two', title: 'Two' },
      { id: 'three', title: 'Three' },
    ]

    expect(reorderCanvasPages(pages, 'three', 'one', 'before').map((page) => page.id))
      .toEqual(['three', 'one', 'two'])
    expect(reorderCanvasPages(pages, 'one', 'two', 'after').map((page) => page.id))
      .toEqual(['two', 'one', 'three'])
    expect(reorderCanvasPages(pages, 'one', 'one', 'before')).toBe(pages)
  })

  it('removes a full-page experience when its owning fiber is disposed', async () => {
    const ctx = new Context()
    const registry = new CanvasRegistry()
    const page: Plugin = (owner) => {
      registry.registerPage(owner, {
        id: 'test-page',
        title: 'Test',
        component: () => null,
      })
    }

    const fiber = await ctx.plugin(page)
    expect(registry.snapshot().pageContents.map((entry) => entry.id)).toEqual(['test-page'])

    await fiber.dispose()
    expect(registry.snapshot().pageContents).toEqual([])
  })

  it('adapts an older widget registration into a page during hot migration', async () => {
    const ctx = new Context()
    const registry = new CanvasRegistry()
    const legacy: Plugin = (owner) => {
      registry.registerWidget(owner, {
        id: 'legacy-status',
        title: 'Legacy status',
        component: () => null,
        initialWidth: 240,
        initialHeight: 180,
      })
    }

    const fiber = await ctx.plugin(legacy)
    expect(registry.snapshot().pageContents.map(({ id, title }) => ({ id, title })))
      .toEqual([{ id: 'legacy-status', title: 'Legacy status' }])

    await fiber.dispose()
    expect(registry.snapshot().pageContents).toEqual([])
  })

  it('orders dock items and removes them with their owning fibers', async () => {
    const ctx = new Context()
    const registry = new CanvasRegistry()
    const first: Plugin = (owner) => {
      registry.registerDockItem(owner, {
        id: 'first',
        component: () => null,
        order: 10,
      })
    }
    const earlier: Plugin = (owner) => {
      registry.registerDockItem(owner, {
        id: 'earlier',
        component: () => null,
        order: 5,
      })
    }

    const firstFiber = await ctx.plugin(first)
    const earlierFiber = await ctx.plugin(earlier)
    expect(registry.snapshot().dockItems.map((item) => item.id)).toEqual(['earlier', 'first'])

    await earlierFiber.dispose()
    expect(registry.snapshot().dockItems.map((item) => item.id)).toEqual(['first'])

    await firstFiber.dispose()
    expect(registry.snapshot().dockItems).toEqual([])
  })

  it('delegates visibility to the workspace pane compositor', () => {
    let toggles = 0
    const registry = new CanvasRegistry(() => { toggles += 1 })

    registry.toggle()
    registry.toggle()

    expect(toggles).toBe(2)
    expect(registry.snapshot().pageContents).toEqual([])
    expect(registry.snapshot().dockItems).toEqual([])
  })
})
