import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, type Plugin } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  adjacentWorkspacePane,
  canNavigateWorkspacePane,
  mapWorkspacePane,
  navigateWorkspacePane,
  parseWorkspaceLayout,
  recordWorkspacePaneLocation,
  removeWorkspacePane,
  resizeWorkspaceSplit,
  resizeWorkspacePane,
  splitWorkspacePane,
  workspacePaneOfKind,
  workspacePaneIds,
  type WorkspacePaneNode,
} from '../program/plugins/workspace-layout-state.js'
import type { LocalProject, ThreadSummary } from '../src/shared/protocol.js'
import type { ClientSessionService } from '../program/plugins/session-api.js'
import {
  recentThreadIds,
  readWorkspaceLayoutState,
  recentsStatePath,
  workspaceLayoutStatePath,
  writeWorkspaceLayoutState,
} from '../program/plugins/workspace-layout.js'
import {
  WorkspaceLayoutRegistry,
  closeWorkspaceTab,
  dockWorkspaceTab,
  restoreWorkspaceTab,
  workspacePickerPlacement,
  workspaceTabDropEdge,
  workspaceNewTabOptions,
  workspaceThreadPane,
  workspacePaneTargets,
  workspaceViewThreadIds,
} from '../program/plugins/workspace-layout.client.js'
import { parseWorkspaceCommands } from '../program/plugins/workspace-commands.client.js'

const first: WorkspacePaneNode = {
  type: 'pane',
  id: 'pane-1',
  workspace: '/repo/one',
}

const second: WorkspacePaneNode = {
  type: 'pane',
  id: 'pane-2',
  workspace: '/repo/two',
}

function thread(id: string): ThreadSummary {
  return {
    id,
    title: `Chat ${id}`,
    preview: `Preview ${id}`,
    cwd: '/repo/one',
    createdAt: 1,
    updatedAt: 1,
    projectId: 'project-one',
  }
}

describe('workspace layout', () => {
  it('chooses the nearest pane edge for a workspace-tab drop', () => {
    const bounds = { left: 100, right: 500, top: 50, bottom: 350, width: 400, height: 300 }
    expect(workspaceTabDropEdge(bounds, 110, 200)).toBe('left')
    expect(workspaceTabDropEdge(bounds, 490, 200)).toBe('right')
    expect(workspaceTabDropEdge(bounds, 300, 60)).toBe('top')
    expect(workspaceTabDropEdge(bounds, 300, 340)).toBe('bottom')
  })

  it('moves a top-level workspace tab into a pane split', () => {
    const sourceRoot = splitWorkspacePane(
      { ...second, id: 'pane-source-1' },
      'pane-source-1',
      'vertical',
      { ...second, id: 'pane-source-2', projectId: 'project-two' },
      'split-source',
    )
    const layout = {
      version: 2 as const,
      activeViewId: 'workspace-target',
      views: [
        {
          id: 'workspace-source',
          name: 'Source',
          workspace: '/repo/two',
          projectId: 'project-two',
          focusedPaneId: 'pane-source-2',
          root: sourceRoot,
        },
        {
          id: 'workspace-target',
          name: 'Target',
          workspace: '/repo/one',
          focusedPaneId: first.id,
          maximizedPaneId: first.id,
          root: first,
        },
      ],
    }

    const docked = dockWorkspaceTab(
      layout,
      'workspace-source',
      'workspace-target',
      first.id,
      'left',
      'split-docked',
    )

    expect(docked.views).toHaveLength(1)
    expect(docked.activeViewId).toBe('workspace-target')
    expect(docked.views[0]).toMatchObject({
      id: 'workspace-target',
      name: 'Target',
      workspace: '/repo/two',
      projectId: 'project-two',
      focusedPaneId: 'pane-source-2',
      root: {
        type: 'split',
        id: 'split-docked',
        direction: 'horizontal',
        first: sourceRoot,
        second: first,
      },
    })
    expect(docked.views[0]).not.toHaveProperty('maximizedPaneId')
    expect(workspacePaneIds(docked.views[0]!.root)).toEqual([
      'pane-source-1',
      'pane-source-2',
      first.id,
    ])
  })

  it('offers an unscoped chat when creating a tab', () => {
    const project = {
      id: 'project-one',
      name: 'One',
      roots: ['/repo/one'],
      primaryRoot: '/repo/one',
      source: 'manual',
    } satisfies LocalProject

    const options = workspaceNewTabOptions([project])
    expect(options.map((option) => option.label)).toEqual(['No workspace', 'One'])
    expect(options[0]?.project).toBeUndefined()
    expect(options[1]?.project).toBe(project)
  })

  it('anchors the new-tab picker to the plus button and clamps it at narrow widths', () => {
    expect(workspacePickerPlacement(
      { right: 1_100, bottom: 36 },
      { left: 300, top: 0, width: 830 },
      300,
    )).toEqual({ left: 500, top: 42 })

    expect(workspacePickerPlacement(
      { right: 468, bottom: 36 },
      { left: 260, top: 0, width: 220 },
      300,
    )).toEqual({ left: 12, top: 42 })
  })

  it('accepts only complete browser workspace commands', () => {
    expect(parseWorkspaceCommands({
      version: 1,
      revision: 4,
      requests: [
        { id: 'one', action: 'open-pane', direction: 'horizontal', kind: 'chat' },
        { id: 'bad', action: 'open-pane', direction: 'diagonal', kind: 'chat' },
      ],
    })).toEqual({
      version: 1,
      revision: 4,
      requests: [{ id: 'one', action: 'open-pane', direction: 'horizontal', kind: 'chat' }],
    })
  })

  it('normalizes the plugin-owned Recents persistence file', () => {
    expect(recentThreadIds({
      version: 1,
      threadIds: [' second ', 'first', 'first', 3],
    })).toEqual(['first', 'second'])
    expect(recentThreadIds({ version: 2, threadIds: ['ignored'] })).toEqual([])
    expect(recentsStatePath('/opt/alto')).toBe(
      '/opt/alto/.codex-cordis/workspace-layout-recents.json',
    )
    expect(workspaceLayoutStatePath('/opt/alto')).toBe(
      '/opt/alto/.codex-cordis/workspace-layout.json',
    )
  })

  it('persists the complete workspace tab and pane tree outside browser storage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-workspace-layout-'))
    const file = workspaceLayoutStatePath(root)
    const layout = {
      version: 2 as const,
      activeViewId: 'workspace-2',
      views: [
        {
          id: 'workspace-1',
          name: 'First',
          workspace: '/repo/one',
          focusedPaneId: 'pane-1',
          root: first,
        },
        {
          id: 'workspace-2',
          name: 'Second',
          workspace: '/repo/two',
          focusedPaneId: 'pane-3',
          maximizedPaneId: 'pane-3',
          root: splitWorkspacePane(
            second,
            second.id,
            'vertical',
            { ...first, id: 'pane-3' },
            'split-persisted',
          ),
        },
      ],
    }

    try {
      await writeWorkspaceLayoutState(file, layout)
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(layout)
      expect(await readWorkspaceLayoutState(file)).toEqual(layout)

      await writeFile(file, 'not json', 'utf8')
      expect(await readWorkspaceLayoutState(file)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores a closed workspace tab at its previous position with its pane layout', () => {
    const restoredView = {
      id: 'workspace-2',
      name: 'Second',
      workspace: '/repo/two',
      focusedPaneId: 'pane-3',
      maximizedPaneId: 'pane-3',
      root: splitWorkspacePane(
        second,
        second.id,
        'vertical',
        { ...first, id: 'pane-3' },
        'split-restored',
      ),
    }
    const original = {
      version: 2 as const,
      activeViewId: restoredView.id,
      views: [
        {
          id: 'workspace-1',
          name: 'First',
          workspace: '/repo/one',
          focusedPaneId: first.id,
          root: first,
        },
        restoredView,
        {
          id: 'workspace-3',
          name: 'Third',
          workspace: '/repo/one',
          focusedPaneId: 'pane-4',
          root: { ...first, id: 'pane-4' },
        },
      ],
    }

    const closed = closeWorkspaceTab(original, restoredView.id)
    expect(closed.layout.views.map((view) => view.id)).toEqual(['workspace-1', 'workspace-3'])
    expect(closed.layout.activeViewId).toBe('workspace-3')

    const restored = restoreWorkspaceTab(closed.layout, closed.closed!)
    expect(restored).toEqual(original)
  })

  it('splits, resizes, and removes panes without disturbing siblings', () => {
    const split = splitWorkspacePane(first, first.id, 'horizontal', second, 'split-1')
    expect(workspacePaneIds(split)).toEqual(['pane-1', 'pane-2'])
    expect(split).toMatchObject({ type: 'split', direction: 'horizontal', ratio: 0.5 })

    const resized = resizeWorkspaceSplit(split, 'split-1', 0.95)
    expect(resized).toMatchObject({ type: 'split', ratio: 0.8 })

    const remaining = removeWorkspacePane(resized, 'pane-1')
    expect(remaining).toEqual(second)
  })

  it('supplies unique chat ids to workspace-tab add-ons', () => {
    const root = splitWorkspacePane(
      { ...first, thread: thread('a') },
      first.id,
      'horizontal',
      { ...second, thread: thread('a') },
      'split-1',
    )
    const withAnotherChat = splitWorkspacePane(
      root,
      second.id,
      'vertical',
      { ...second, id: 'pane-3', thread: thread('b') },
      'split-2',
    )

    expect(workspaceViewThreadIds({
      id: 'workspace-1',
      name: 'Workspace',
      workspace: '/repo/one',
      focusedPaneId: first.id,
      root: withAnotherChat,
    })).toEqual(['a', 'b'])
  })

  it('finds a thread pane from live session state before persisted pane state', () => {
    const persistedView = {
      id: 'workspace-persisted',
      name: 'Persisted',
      workspace: '/repo/one',
      focusedPaneId: 'pane-persisted',
      root: { ...first, id: 'pane-persisted', thread: thread('target') },
    }
    const liveView = {
      id: 'workspace-live',
      name: 'Live',
      workspace: '/repo/two',
      focusedPaneId: 'pane-live',
      root: { ...second, id: 'pane-live' },
    }
    const liveSession = {
      snapshot: () => ({ threadId: 'target' }),
    } as unknown as ClientSessionService

    expect(workspaceThreadPane(
      [persistedView, liveView],
      new Map([['pane-live', liveSession]]),
      'target',
    )).toEqual({ workspaceId: 'workspace-live', paneId: 'pane-live' })
  })

  it('finds a restored thread pane before its live session registers', () => {
    const view = {
      id: 'workspace-restored',
      name: 'Restored',
      workspace: '/repo/one',
      focusedPaneId: 'pane-restored',
      root: { ...first, id: 'pane-restored', thread: thread('target') },
    }

    expect(workspaceThreadPane([view], new Map(), 'target')).toEqual({
      workspaceId: 'workspace-restored',
      paneId: 'pane-restored',
    })
  })

  it('removes workspace-tab add-ons with their owning fibers', async () => {
    const context = new Context()
    const registry = new WorkspaceLayoutRegistry()
    const addon = {
      id: 'test-tab-status',
      renderer: () => null,
    }
    const plugin: Plugin = (owner) => {
      registry.registerTabAddon(owner, addon)
    }
    const fiber = await context.plugin(plugin)

    expect(registry.tabAddons()).toEqual([addon])
    await fiber.dispose()
    expect(registry.tabAddons()).toEqual([])
    registry.dispose()
  })

  it('updates one pane structurally', () => {
    const split = splitWorkspacePane(first, first.id, 'vertical', second, 'split-1')
    const next = mapWorkspacePane(split, 'pane-2', (pane) => ({
      ...pane,
      projectId: 'two',
    }))
    expect(next).not.toBe(split)
    expect(next).toMatchObject({
      second: { id: 'pane-2', projectId: 'two' },
    })
  })

  it('finds plugin panes without giving their kinds special layout semantics', () => {
    const canvas = { ...second, kind: 'canvas' }
    const split = splitWorkspacePane(first, first.id, 'horizontal', canvas, 'split-1')

    expect(workspacePaneOfKind(split, 'canvas')).toEqual(canvas)
    expect(workspacePaneOfKind(split, 'browser')).toBeUndefined()
  })

  it('keeps browser-style back and forward history within one pane', () => {
    const firstChat = recordWorkspacePaneLocation(first, {
      workspace: first.workspace,
      projectId: 'project-one',
      thread: thread('a'),
    })
    const secondChat = recordWorkspacePaneLocation(firstChat, {
      workspace: first.workspace,
      projectId: 'project-one',
      thread: thread('b'),
    })
    const thirdChat = recordWorkspacePaneLocation(secondChat, {
      workspace: first.workspace,
      projectId: 'project-one',
      thread: thread('c'),
    })

    expect(canNavigateWorkspacePane(thirdChat, -1)).toBe(true)
    expect(canNavigateWorkspacePane(thirdChat, 1)).toBe(false)

    const back = navigateWorkspacePane(thirdChat, -1)
    expect(back?.location.thread?.id).toBe('b')
    const backAgain = back && navigateWorkspacePane(back.pane, -1)
    expect(backAgain?.location.thread?.id).toBe('a')
    const forward = backAgain && navigateWorkspacePane(backAgain.pane, 1)
    expect(forward?.location.thread?.id).toBe('b')

    const branched = recordWorkspacePaneLocation(back!.pane, {
      workspace: first.workspace,
      projectId: 'project-one',
      thread: thread('d'),
    })
    expect(branched.navigation?.entries.map((entry) => entry.thread?.id)).toEqual(['a', 'b', 'd'])
    expect(canNavigateWorkspacePane(branched, 1)).toBe(false)
  })

  it('replaces a blank composer when it becomes a chat', () => {
    const firstChat = recordWorkspacePaneLocation(first, {
      workspace: first.workspace,
      thread: thread('a'),
    })
    const blank = recordWorkspacePaneLocation(firstChat, { workspace: first.workspace })
    const created = recordWorkspacePaneLocation(blank, {
      workspace: first.workspace,
      thread: thread('b'),
    })

    expect(created.navigation?.entries.map((entry) => entry.thread?.id)).toEqual(['a', 'b'])
  })

  it('refreshes authoritative metadata without adding a navigation entry', () => {
    const initial = recordWorkspacePaneLocation(first, {
      workspace: first.workspace,
      projectId: 'project-one',
      thread: thread('a'),
    })
    const refreshedThread: ThreadSummary = {
      ...thread('a'),
      recencyAt: 4,
      projectRef: { source: 'codex-app', id: 'canonical-project' },
      gitInfo: { branch: 'captured-branch', sha: 'abc123' },
      modelProvider: 'openai',
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      canAcceptDirectInput: false,
    }
    const refreshed = recordWorkspacePaneLocation(initial, {
      workspace: first.workspace,
      projectId: 'project-one',
      thread: refreshedThread,
    })

    expect(refreshed.navigation?.entries).toHaveLength(1)
    expect(refreshed.thread).toEqual(refreshedThread)
    expect(parseWorkspaceLayout({
      version: 2,
      activeViewId: 'view-1',
      views: [{
        id: 'view-1',
        name: 'one',
        workspace: first.workspace,
        projectId: 'project-one',
        focusedPaneId: first.id,
        root: refreshed,
      }],
    })?.views[0]?.root).toEqual(refreshed)
  })

  it('replaces an unscoped blank when it is retargeted to a workspace', () => {
    const blank = recordWorkspacePaneLocation(first, {
      workspace: '/tmp/fallback',
      unscoped: true,
    })
    const retargeted = recordWorkspacePaneLocation(blank, {
      workspace: '/repo/one',
      projectId: 'project-one',
    })

    expect(retargeted).toMatchObject({
      workspace: '/repo/one',
      projectId: 'project-one',
      navigation: {
        index: 0,
        entries: [{ workspace: '/repo/one', projectId: 'project-one' }],
      },
    })
    expect(retargeted.unscoped).toBeUndefined()
  })

  it('persists an unscoped tab and its projectless navigation entry', () => {
    const parsed = parseWorkspaceLayout({
      version: 2,
      activeViewId: 'recent',
      views: [{
        id: 'recent',
        name: 'New chat',
        workspace: '/repo/one',
        unscoped: true,
        focusedPaneId: 'pane-recent',
        root: {
          type: 'pane',
          id: 'pane-recent',
          workspace: '/repo/one',
          unscoped: true,
          navigation: {
            index: 0,
            entries: [{ workspace: '/repo/one', unscoped: true }],
          },
        },
      }],
    })

    expect(parsed?.views[0]).toMatchObject({
      name: 'New chat',
      unscoped: true,
      root: {
        unscoped: true,
        navigation: { entries: [{ unscoped: true }] },
      },
    })
  })

  it('moves between visually adjacent panes with Vim directions', () => {
    const lowerLeft: WorkspacePaneNode = {
      type: 'pane',
      id: 'pane-3',
      workspace: '/repo/three',
    }
    const left = splitWorkspacePane(first, first.id, 'vertical', lowerLeft, 'split-left')
    const root = {
      type: 'split' as const,
      id: 'split-root',
      direction: 'horizontal' as const,
      ratio: 0.5,
      first: left,
      second,
    }

    expect(adjacentWorkspacePane(root, first.id, 'down')).toBe(lowerLeft.id)
    expect(adjacentWorkspacePane(root, lowerLeft.id, 'up')).toBe(first.id)
    expect(adjacentWorkspacePane(root, first.id, 'right')).toBe(second.id)
    expect(adjacentWorkspacePane(root, second.id, 'left')).toBe(first.id)
    expect(adjacentWorkspacePane(root, second.id, 'down')).toBeUndefined()
  })

  it('finds the neighboring chat in the active workspace without moving focus or skipping a non-chat pane', () => {
    const terminal = { ...second, id: 'terminal', kind: 'terminal' }
    const root = splitWorkspacePane(first, first.id, 'horizontal', terminal, 'split')
    const active = { id: 'active', name: 'Active', workspace: '/repo/one', focusedPaneId: terminal.id, root }
    const background = { ...active, id: 'background', focusedPaneId: second.id, root: second }
    const layout = { version: 2 as const, activeViewId: active.id, views: [background, active] }
    const session = {} as ClientSessionService
    const sessions = new Map([[first.id, session], [second.id, session]])
    expect(workspacePaneTargets(layout, sessions, 'left')).toEqual([
      { workspaceId: active.id, paneId: first.id, focused: false, session },
    ])
    expect(active.focusedPaneId).toBe(terminal.id)
    expect(workspacePaneTargets(layout, sessions, 'right')).toEqual([])

    active.focusedPaneId = first.id
    expect(workspacePaneTargets(layout, sessions, 'left')).toEqual([])
    expect(workspacePaneTargets(layout, sessions, 'right')).toEqual([])
    expect(workspacePaneTargets(layout, sessions)).toHaveLength(2)

    active.focusedPaneId = terminal.id
    sessions.delete(first.id)
    expect(workspacePaneTargets(layout, sessions, 'left')).toEqual([])
  })

  it('grows and shrinks the focused pane against its split boundaries', () => {
    const split = splitWorkspacePane(first, first.id, 'horizontal', second, 'split-1')
    expect(resizeWorkspacePane(split, first.id, 0.1)).toMatchObject({ ratio: 0.6 })
    expect(resizeWorkspacePane(split, second.id, 0.1)).toMatchObject({ ratio: 0.4 })
    expect(resizeWorkspacePane(split, first.id, -0.1)).toMatchObject({ ratio: 0.4 })
  })

  it('accepts valid persisted layouts and rejects corrupt trees', () => {
    const state = {
      version: 2,
      activeViewId: 'view-1',
      views: [{
        id: 'view-1',
        name: 'atlas',
        workspace: '/repo/one',
        focusedPaneId: 'pane-1',
        maximizedPaneId: 'pane-1',
        root: first,
      }],
    }
    expect(parseWorkspaceLayout(state)).toEqual(state)
    expect(parseWorkspaceLayout({ ...state, activeViewId: 'missing' })).toBeUndefined()
    expect(parseWorkspaceLayout({
      ...state,
      views: [{ ...state.views[0], maximizedPaneId: 'missing' }],
    })).toBeUndefined()
    expect(parseWorkspaceLayout({
      ...state,
      views: [{ ...state.views[0], focusedPaneId: 'missing' }],
    })).toBeUndefined()
    expect(parseWorkspaceLayout({
      ...state,
      views: [{
        ...state.views[0],
        root: {
          ...first,
          navigation: { index: 2, entries: [{ workspace: first.workspace }] },
        },
      }],
    })).toBeUndefined()

    const terminalState = {
      ...state,
      views: [{
        ...state.views[0],
        root: {
          ...first,
          kind: 'markdown-viewer',
          resource: '/repo/one/notes.md',
        },
      }],
    }
    expect(parseWorkspaceLayout(terminalState)).toEqual(terminalState)
    expect(parseWorkspaceLayout({
      ...terminalState,
      views: [{ ...terminalState.views[0]!, root: { ...terminalState.views[0]!.root, resource: 42 } }],
    })).toBeUndefined()
  })

  it('migrates legacy tabs into workspace-bound views', () => {
    expect(parseWorkspaceLayout({
      version: 1,
      activeViewId: 'view-1',
      views: [{
        id: 'view-1',
        name: 'Tab 1',
        focusedPaneId: 'pane-1',
        root: { ...first, projectId: 'project-one' },
      }],
    })).toMatchObject({
      version: 2,
      views: [{
        workspace: '/repo/one',
        projectId: 'project-one',
      }],
    })
  })
})
