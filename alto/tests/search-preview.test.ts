import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from 'cordis'
import type { ClientExtensionHandler } from '../src/server/plugin-api.js'
import { latestSearchPreview } from '../program/plugins/search-preview.js'
import searchPlugin from '../program/plugins/search.js'
import { SEARCH_PREVIEW } from '../program/plugins/search-api.js'
import { agentChatStateKey } from '../program/plugins/agent-chats-api.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('uses the last chat message and skips tool output, reasoning, and empty placeholders', () => {
  expect(latestSearchPreview([
    { kind: 'user', content: 'First prompt' },
    { kind: 'agent', content: 'Earlier answer' },
    { kind: 'user', content: 'Follow-up question' },
    { kind: 'agent', content: 'Latest answer\n  with details' },
    { kind: 'reasoning', content: 'Internal reasoning' },
    { kind: 'command', content: 'Terminal output' },
    { kind: 'agent', content: '' },
  ])).toBe('Latest answer with details')
  expect(latestSearchPreview([{ kind: 'agent', content: 'Old reply' }, { kind: 'user', content: 'Newest prompt' }])).toBe('Newest prompt')
})

it('handles attachment-only messages, questions, long messages, and empty chats', () => {
  expect(latestSearchPreview([{ kind: 'user', content: '', attachments: [{ name: 'file.ts', path: '/file.ts', size: 3, mediaType: 'text/plain' }] }])).toBe('Attachment')
  expect(latestSearchPreview([{ kind: 'agent', content: '', questions: [{ title: 'Which option?' }] }])).toBe('Which option?')
  const preview = latestSearchPreview([{ kind: 'agent', content: 'x'.repeat(1000) }])
  expect(preview).toHaveLength(240)
  expect(preview.endsWith('…')).toBe(true)
  expect(latestSearchPreview([])).toBe('')
})

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'alto-search-preview-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const handlers = new Map<string, ClientExtensionHandler>()
  const extensions: Record<string, unknown> = {}
  const listThreadTurns = vi.fn(async () => ({ messages: [
    { id: 'first', role: 'user', text: 'First prompt' },
    { id: 'last', role: 'agent', text: 'Latest saved reply' },
  ] }))
  await (searchPlugin as (ctx: Context, config: {}) => unknown)({
    ui: { registerSurface: vi.fn() }, program: { projectRoot: directory },
    codex: { listThreadTurns }, clientExtensions: {
      registerMethod: (_owner: unknown, name: string, handler: ClientExtensionHandler) => { handlers.set(name, handler) },
      snapshot: () => extensions,
    },
  } as unknown as Context, {})
  return { directory, extensions, listThreadTurns, preview: (threadId: string) => handlers.get(SEARCH_PREVIEW)!({ threadId }) }
}

it('reads a bounded recent native history page without resuming the conversation', async () => {
  const f = await fixture()
  expect(await f.preview('native-chat')).toEqual({ preview: 'Latest saved reply' })
  expect(f.listThreadTurns).toHaveBeenCalledExactlyOnceWith('native-chat', undefined, 2)
})

it('uses live ACP activity first and otherwise reads saved activity without starting its provider', async () => {
  const f = await fixture()
  const id = 'acp-12345678-1234-1234-1234-123456789abc'
  await mkdir(path.join(f.directory, '.codex-cordis', 'agent-chats'), { recursive: true })
  await writeFile(path.join(f.directory, '.codex-cordis', 'agent-chats', `${id}.json`), JSON.stringify({
    summary: { id, providerId: 'claude', providerSessionId: 'provider-session' },
    activities: [{ kind: 'user', content: 'Opening prompt' }, { kind: 'agent', content: 'Latest ACP reply' }],
  }))
  expect(await f.preview(id)).toEqual({ preview: 'Latest ACP reply' })
  f.extensions[agentChatStateKey(id)] = { activities: [{ kind: 'agent', content: 'New streaming reply' }] }
  expect(await f.preview(id)).toEqual({ preview: 'New streaming reply' })
  expect(f.listThreadTurns).not.toHaveBeenCalled()
})
