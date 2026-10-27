import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, type Plugin } from 'cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationTitles } from '../program/plugins/conversation-titles-model.js'
import namingPlugin from '../program/plugins/conversation-titles.js'
import { conversationTabNames } from '../program/plugins/conversation-titles.client.js'
import { CONVERSATION_RENAME, CONVERSATION_TITLES_STATE, type ConversationTitleSnapshot } from '../program/plugins/conversation-titles-api.js'
import { ClientExtensionRegistry } from '../src/server/services/client-extension-registry.js'
import { DynamicToolRegistry } from '../src/server/services/tool-registry.js'
import { TurnProgram } from '../src/server/services/turn-program.js'
import type { ClientHostService } from '../src/client/plugin-api.js'
import type { WorkspaceView } from '../program/plugins/workspace-layout-state.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(initial = 'Untitled conversation', initialTitle?: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alto-names-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let title = initial
  const read = vi.fn(async () => ({ title, ...(initialTitle ? { initialTitle } : {}) }))
  const write = vi.fn(async (_id: string, next: string) => { title = next })
  const changed = vi.fn()
  const file = path.join(directory, 'titles.json')
  const titles = new ConversationTitles(file, read, write, changed)
  cleanup.push(() => titles.dispose())
  await titles.load()
  return { titles, file, read, write, changed, external: (value: string) => { title = value } }
}

it('generates a title, evolves it, and retains ownership after restarting', async () => {
  const f = await fixture()
  await expect(f.titles.generate('chat', 'Fix   search ranking')).resolves.toEqual({ updated: true, title: 'Fix search ranking' })
  await f.titles.dispose()
  const restored = new ConversationTitles(f.file, f.read, f.write, f.changed)
  cleanup.push(() => restored.dispose())
  await restored.load()
  await expect(restored.generate('chat', 'Improve conversation navigation')).resolves.toMatchObject({ updated: true })
  expect(f.write).toHaveBeenLastCalledWith('chat', 'Improve conversation navigation')
})

it('preserves existing custom names and subsequent external renames', async () => {
  const custom = await fixture('Backup')
  expect(await custom.titles.generate('chat', 'New suggested title')).toEqual({ updated: false, title: 'Backup' })
  expect(custom.write).not.toHaveBeenCalled()
  const f = await fixture()
  await f.titles.generate('chat', 'Fix search ranking')
  f.external('My chosen name')
  expect(await f.titles.generate('chat', 'A different topic')).toEqual({ updated: false, title: 'My chosen name' })
})

it('replaces the ACP first-message fallback but leaves custom ACP titles alone', async () => {
  const f = await fixture('Can you fix the search?', 'Can you fix the search?')
  expect(await f.titles.generate('acp-chat', 'Fix conversation search')).toMatchObject({ updated: true })
  const custom = await fixture('Keep this name', 'Can you fix the search?')
  expect(await custom.titles.generate('acp-chat', 'Fix conversation search')).toMatchObject({ updated: false })
})

it('gives a queued manual rename precedence over an in-flight automatic update', async () => {
  const f = await fixture()
  let release!: () => void
  f.read.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ title: 'Untitled conversation' }) }))
  const generated = f.titles.generate('chat', 'Generated title')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const manual = f.titles.manual('chat', 'My permanent name')
  release()
  await Promise.all([generated, manual])
  expect(f.write.mock.calls.map((call) => call[1])).toEqual(['Generated title', 'My permanent name'])
  expect(await f.titles.generate('chat', 'Next topic')).toEqual({ updated: false, title: 'My permanent name' })
})

it('persists an explicit rename even when it matches the generated name', async () => {
  const f = await fixture()
  await f.titles.generate('chat', 'A useful title')
  await f.titles.manual('chat', 'A useful title')
  await f.titles.dispose()
  const restored = new ConversationTitles(f.file, f.read, f.write, f.changed)
  cleanup.push(() => restored.dispose())
  await restored.load()
  expect(await restored.generate('chat', 'Different title')).toMatchObject({ updated: false })
})

it('does not claim a failed rename and rejects invalid or disposed updates', async () => {
  const f = await fixture()
  f.write.mockRejectedValueOnce(new Error('Offline'))
  await expect(f.titles.generate('chat', 'New title')).rejects.toThrow('Offline')
  expect(f.titles.snapshot()).toEqual({})
  await expect(f.titles.generate('chat', ' ')).rejects.toThrow('80 characters')
  await expect(f.titles.generate('chat', 'x'.repeat(81))).rejects.toThrow('80 characters')
  await f.titles.dispose()
  await expect(f.titles.generate('chat', 'Valid title')).rejects.toThrow('unavailable')
})

it('guards a pending read when its owning plugin is disposed', async () => {
  const f = await fixture()
  let release!: () => void
  f.read.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ title: 'Untitled conversation' }) }))
  const generated = f.titles.generate('chat', 'Generated title')
  const rejected = expect(generated).rejects.toThrow('unavailable')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const disposed = f.titles.dispose()
  release()
  await Promise.all([rejected, disposed])
  expect(f.write).not.toHaveBeenCalled()
})

it('registers scoped naming, prompt guidance, manual rename protection, and unloads cleanly', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alto-title-plugin-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const root = new Context()
  let title = 'Untitled conversation'
  const request = vi.fn(async (method: string, params: { name?: string }) => {
    if (method === 'thread/name/set') { title = params.name!; return {} }
    return { thread: { name: title } }
  })
  const extensions = new ClientExtensionRegistry(root)
  const tools = new DynamicToolRegistry(root)
  const turns = new TurnProgram(root)
  const services = await root.plugin(((ctx) => {
    ctx.provide('codex', { request } as unknown as Context['codex'])
    ctx.provide('program', { projectRoot: directory } as Context['program'])
    ctx.provide('clientExtensions', extensions)
    ctx.provide('tools', tools)
    ctx.provide('turnProgram', turns)
  }) as Plugin)
  cleanup.push(() => services.dispose())
  const fiber = await root.plugin(namingPlugin, {})
  cleanup.push(() => fiber.dispose())
  const prepared = await turns.prepare({ threadId: 'this-chat', input: [], additionalContext: { existing: { kind: 'application', value: 'Keep me' } } })
  expect(prepared.additionalContext?.conversation_title?.value).toContain('conversation/set_title')
  expect(prepared.additionalContext?.existing?.value).toBe('Keep me')
  const invoke = (name: string) => tools.execute({ callId: 'call', threadId: 'this-chat', turnId: 'turn', namespace: 'conversation', tool: 'set_title', arguments: { title: name, threadId: 'another-chat' } })
  expect((await invoke('Improve Alto navigation')).success).toBe(true)
  expect(request).toHaveBeenLastCalledWith('thread/name/set', { threadId: 'this-chat', name: 'Improve Alto navigation' })
  await root.waterfall('conversation/rename', 'this-chat', 'My pinned title', async () => { title = 'My pinned title' })
  expect((await invoke('Different subject')).contentItems[0]?.text).toContain('"updated": false')
  expect(title).toBe('My pinned title')
  await extensions.call(CONVERSATION_RENAME, { id: 'this-chat', title: 'Another manual title' })
  expect(extensions.snapshot()[CONVERSATION_TITLES_STATE]).toEqual({ 'this-chat': { title: 'Another manual title', manual: true } })
  await fiber.dispose()
  expect((await turns.prepare({ threadId: 'this-chat', input: [] })).additionalContext).toBeUndefined()
  expect(extensions.snapshot()[CONVERSATION_TITLES_STATE]).toBeUndefined()
})

it('follows titles only for default tabs and invalidates bindings when the chat changes', () => {
  const snapshot: ConversationTitleSnapshot = { chat: { title: 'Fix unread navigation', manual: false } }
  const source = conversationTabNames({ snapshot: () => ({ snapshot: { extensions: { [CONVERSATION_TITLES_STATE]: snapshot } } }) } as unknown as ClientHostService)
  const view: WorkspaceView = { id: 'tab', name: 'New chat 2', workspace: '/repo', focusedPaneId: 'pane', root: { type: 'pane', id: 'pane', workspace: '/repo', thread: { id: 'chat', title: 'Untitled conversation', cwd: '/repo', preview: '', createdAt: 1, updatedAt: 1 } } }
  expect(source.match?.(view)).toBe('chat')
  expect(source.match?.({ ...view, name: 'Backup' })).toBeUndefined()
  expect(source.name('chat')).toBe('Fix unread navigation')
  expect(source.valid?.('other-chat', view)).toBe(false)
  expect(source.valid?.('chat', view)).toBe(true)
  snapshot.chat!.title = 'Keep conversation names current'
  expect(source.name('chat')).toBe('Keep conversation names current')
})
