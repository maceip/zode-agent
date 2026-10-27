import { Context } from 'cordis'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import editorPane, { editorDirectory, prepareEditor } from '../program/plugins/editor-pane.js'
import { EditorPanes } from '../program/plugins/editor-pane.client.js'
import { EDITOR_PREPARE } from '../program/plugins/editor-pane-api.js'
import { EditorDestinationPreference, IdePreference } from '../program/plugins/open-in-ide.client.js'
import type { ClientSessionService } from '../program/plugins/session-api.js'
import type { ClientWorkspaceLayoutService } from '../program/plugins/workspace-layout-api.js'
import type { ClientWorkContextsService } from '../program/plugins/work-contexts-client-api.js'
import { clientExtensionRegistryPlugin } from '../src/server/services/client-extension-registry.js'

function fixture() {
  const session = { snapshot: () => ({ session: { workspace: '/repo' }, threadId: 'thread-a', activeProjectId: 'project-a', projectScope: 'workspace' }) } as ClientSessionService
  const contexts = { snapshot: () => ({ threadTargets: { 'thread-a': { kind: 'local', location: '/worktree' } } }) } as unknown as ClientWorkContextsService
  const layout = {
    available: () => true,
    tabs: () => [{ id: 'workspace-a', active: true }],
    paneTargets: () => [{ workspaceId: 'workspace-a', paneId: 'chat-a', session, focused: false }],
    focusPane: vi.fn().mockReturnValue(true),
    openPane: vi.fn().mockReturnValue({ workspaceId: 'workspace-a', paneId: 'editor-a' }),
  }
  const editors = new EditorPanes(layout as unknown as ClientWorkspaceLayoutService, contexts)
  return { editors, layout, session, contexts }
}

describe('Neovim editor pane', () => {
  it('opens the composer’s selected worktree beside its exact chat and reuses the pane', () => {
    const { editors, layout, session } = fixture()
    editors.open(session)
    expect(layout.openPane).toHaveBeenCalledWith({ kind: 'editor', direction: 'horizontal', workspace: '/worktree',
      anchor: { workspaceId: 'workspace-a', paneId: 'chat-a' }, anchorThreadId: 'thread-a', projectId: 'project-a' })
    editors.open(session)
    expect(layout.openPane).toHaveBeenCalledOnce()
    const unmount = editors.mount({ workspaceId: 'workspace-a', paneId: 'editor-a', workspace: '/worktree' })
    editors.open(session)
    expect(layout.focusPane).toHaveBeenCalledWith('workspace-a', 'editor-a')
    unmount()
    editors.open(session)
    expect(layout.openPane).toHaveBeenCalledTimes(2)
  })

  it('anchors unsent chats and keeps editor reuse within the originating tab and checkout', () => {
    const { editors, layout, session } = fixture()
    session.snapshot = () => ({ session: { workspace: '/new-chat' }, projectScope: 'workspace' }) as never
    editors.mount({ workspaceId: 'other-tab', paneId: 'other-editor', workspace: '/new-chat' })
    editors.mount({ workspaceId: 'workspace-a', paneId: 'old-editor', workspace: '/other-worktree' })
    editors.open(session)
    expect(layout.focusPane).not.toHaveBeenCalled()
    expect(layout.openPane).toHaveBeenCalledWith({ kind: 'editor', direction: 'horizontal', workspace: '/new-chat', anchor: { workspaceId: 'workspace-a', paneId: 'chat-a' } })
  })

  it('routes file links to the selected checkout and falls back when its pane closes', () => {
    const { editors, layout } = fixture()
    const openFile = vi.fn()
    const otherFile = vi.fn()
    const origin = { closest: () => ({ dataset: { workspacePaneId: 'chat-a' } }) } as unknown as HTMLElement
    const details = { label: 'file.rs', path: '/worktree/file.rs', line: 42, column: 3 }
    expect(editors.openFile(details, origin)).toBe(false)
    editors.mount({ workspaceId: 'workspace-a', paneId: 'wrong-checkout', workspace: '/repo', openFile: otherFile })
    const unmount = editors.mount({ workspaceId: 'workspace-b', paneId: 'right-checkout', workspace: '/worktree', openFile })
    expect(editors.openFile(details, origin)).toBe(true)
    expect(openFile).toHaveBeenCalledWith(details)
    expect(otherFile).not.toHaveBeenCalled()
    expect(layout.focusPane).toHaveBeenCalledWith('workspace-b', 'right-checkout')
    unmount()
    expect(editors.openFile(details, origin)).toBe(false)
    expect(layout.openPane).not.toHaveBeenCalled()
  })

  it('prefers an editor in the origin tab and ignores remote links and failed focus', () => {
    const { editors, layout, session } = fixture()
    const openFile = vi.fn()
    const backgroundFile = vi.fn()
    const origin = { closest: () => ({ dataset: { workspacePaneId: 'chat-a' } }) } as unknown as HTMLElement
    const details = { label: 'file.rs', path: '/worktree/file.rs' }
    editors.mount({ workspaceId: 'background', paneId: 'background-pane', workspace: '/worktree', openFile: backgroundFile })
    editors.mount({ workspaceId: 'workspace-a', paneId: 'editor-a', workspace: '/worktree', openFile })
    expect(editors.openFile(details, origin)).toBe(true)
    expect(backgroundFile).not.toHaveBeenCalled()
    layout.focusPane.mockReturnValue(false)
    expect(editors.openFile(details, origin)).toBe(false)
    layout.focusPane.mockClear()
    session.snapshot = () => ({ session: { workspace: '/worktree' }, remoteLocation: 'remote' }) as never
    expect(editors.openFile(details, origin)).toBe(false)
    expect(layout.focusPane).not.toHaveBeenCalled()
  })

  it('does not open a local editor for remote or unscoped chats', () => {
    const { editors, layout, session } = fixture()
    for (const override of [{ remoteLocation: 'host' }, { projectScope: 'unscoped' }]) {
      session.snapshot = () => ({ session: { workspace: '/repo' }, ...override }) as never
      expect(editors.unavailable(session)).toBeTruthy()
      expect(() => editors.open(session)).toThrow()
    }
    expect(layout.openPane).not.toHaveBeenCalled()
  })

  it('prepares a literal Neovim executable and workspace without running a shell', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'alto-editor-'))
    try {
      const workspace = path.join(temporary, 'worktree $(literal)')
      await mkdir(workspace)
      const executable = path.join(temporary, "nvim's launcher")
      await writeFile(executable, '#!/bin/sh\nexit 0\n')
      await chmod(executable, 0o700)
      expect(await prepareEditor({ workspace }, executable)).toEqual({ workingDirectory: await realpath(workspace),
        command: `'${executable.replaceAll("'", "'\\''")}' .` })
      await expect(prepareEditor({ workspace }, path.join(temporary, 'missing'))).rejects.toThrow(/Neovim is not installed/)
      await expect(prepareEditor({ workspace: executable }, executable)).rejects.toThrow(/folder/)
      for (const workspace of ['', 'relative', '/bad\0path']) expect(() => editorDirectory({ workspace })).toThrow(/workspace/)
      const ctx = new Context()
      const registry = await ctx.plugin(clientExtensionRegistryPlugin)
      const fiber = await ctx.plugin(editorPane, { executable })
      expect(await ctx.clientExtensions.call(EDITOR_PREPARE, { workspace })).toHaveProperty('workingDirectory', await realpath(workspace))
      await fiber.dispose()
      await expect(ctx.clientExtensions.call(EDITOR_PREPARE, { workspace })).rejects.toThrow()
      await registry.dispose()
    } finally { await rm(temporary, { recursive: true, force: true }) }
  })

  it('reattaches the same checkout after pane close, tab changes, and plugin reload', () => {
    const { layout, contexts } = fixture()
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const editors = new EditorPanes(layout as unknown as ClientWorkspaceLayoutService, contexts, storage)
    const first = { workspaceId: 'tab-a', paneId: 'first-pane', tabId: 'neovim' }
    const reopened = { workspaceId: 'tab-b', paneId: 'new-pane', tabId: 'neovim' }
    expect(editors.identity('/checkout-a', first)).toEqual(first)
    expect(editors.identity('/checkout-a', reopened)).toEqual(first)
    const restored = new EditorPanes(layout as unknown as ClientWorkspaceLayoutService, contexts, storage)
    expect(restored.identity('/checkout-a', reopened)).toEqual(first)
    expect(restored.identity('/checkout-b', reopened)).toEqual(reopened)
  })

  it('persists pane/external preference independently from the existing external IDE choice', () => {
    const values = new Map([['alto.open-in-ide', 'cursor']])
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const preference = new EditorDestinationPreference('pane', storage)
    expect(preference.snapshot()).toBe('pane')
    preference.set('external')
    expect(new EditorDestinationPreference('pane', storage).snapshot()).toBe('external')
    expect(new IdePreference('vscode', storage).snapshot()).toBe('cursor')
    values.set('alto.editor.destination', 'unknown')
    expect(new EditorDestinationPreference('pane', storage).snapshot()).toBe('pane')
  })
})

it.skipIf(process.platform !== 'darwin')('keeps editor controls clear of the native surface at wide and narrow widths', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(createRequire(import.meta.url)('electron') as string,
    [path.resolve('tests/fixtures/editor-pane-layout.cjs')], { cwd: process.cwd(), env, timeout: 20_000 })
  expect(stdout).toContain('Editor pane layout checks passed')
}, 25_000)
