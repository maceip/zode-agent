import { describe, expect, it, vi } from 'vitest'
import { ChatHistoryStore, groupChatHistory, mergeChatHistory } from '../program/plugins/chat-history-model.js'
import { readChatHistoryPage } from '../program/plugins/chat-history.js'
import { CHAT_HISTORY_PAGE_SIZE, type ChatHistoryPage } from '../program/plugins/chat-history-api.js'
import { historyWorkspace, openHistoryChat } from '../program/plugins/chat-history.client.js'
import type { ThreadSummary } from '../src/shared/protocol.js'
import type { ClientWorkspaceLayoutService } from '../program/plugins/workspace-layout-api.js'
import { WorkspaceLayoutRegistry } from '../program/plugins/workspace-layout.client.js'

const chat = (id: string, updatedAt: number): ThreadSummary => ({
  id, title: `Chat ${id}`, preview: '', cwd: '/repo/project', createdAt: updatedAt, updatedAt,
})
const page = (threads: ThreadSummary[], nextCursor: string | null = null): ChatHistoryPage => ({ threads, nextCursor })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('chat history pages', () => {
  it('forwards the requested full-size pane kind without changing normal new-tab calls', () => {
    const registry = new WorkspaceLayoutRegistry()
    const newTab = vi.fn()
    const unbind = registry.bindController({ tabs: () => [], paneTargets: () => [], newTab } as unknown as Parameters<typeof registry.bindController>[0])
    registry.newTab()
    registry.newTab('history')
    expect(newTab.mock.calls).toEqual([[undefined], ['history']])
    unbind()
    registry.newTab('history')
    expect(newTab).toHaveBeenCalledTimes(2)
  })

  it('forwards an explicit project or projectless chat without changing the selected thread', () => {
    const registry = new WorkspaceLayoutRegistry()
    const newTab = vi.fn()
    const unbind = registry.bindController({ tabs: () => [], paneTargets: () => [], newTab } as unknown as Parameters<typeof registry.bindController>[0])
    const project = { id: 'atlas', name: 'Atlas', primaryRoot: '/repo/atlas', roots: ['/repo/atlas'] }
    const thread = chat('existing', 10)
    registry.newTab(undefined, undefined, project)
    registry.newTab(undefined, undefined, null)
    registry.newTab(undefined, thread)
    expect(newTab.mock.calls).toEqual([
      [undefined, undefined, project],
      [undefined, undefined, null],
      [undefined, thread],
    ])
    unbind()
  })

  it('requests one cursor page of top-level chats and uses the shared summary parser and workspace classifier', async () => {
    const request = vi.fn().mockResolvedValue({ data: [
      { id: 'a', name: 'Actual chat name', preview: 'First message', cwd: '/repo', createdAt: 10, updatedAt: 20 },
      { malformed: true },
    ], nextCursor: 'older' })
    const classify = vi.fn(async (threads: ThreadSummary[]) => threads.map((thread) => ({ ...thread, projectId: 'project' })))
    const result = await readChatHistoryPage({ request }, classify, 'cursor')
    expect(request).toHaveBeenCalledExactlyOnceWith('thread/list', {
      cursor: 'cursor', limit: CHAT_HISTORY_PAGE_SIZE, sortKey: 'recency_at', sortDirection: 'desc',
      sourceKinds: ['cli', 'vscode', 'appServer'],
    })
    expect(result.threads).toHaveLength(1)
    expect(result.threads[0]).toMatchObject({ id: 'a', title: 'Actual chat name', projectId: 'project' })
    expect(result.nextCursor).toBe('older')
  })

  it('rejects malformed responses and a repeated cursor', async () => {
    const classify = async (threads: ThreadSummary[]) => threads
    await expect(readChatHistoryPage({ request: async () => ({}) }, classify)).rejects.toThrow('invalid history page')
    await expect(readChatHistoryPage({ request: async () => ({ data: [], nextCursor: 'same' }) }, classify, 'same')).rejects.toThrow('repeated')
  })

  it('uses recency and deduplicates overlapping pages without overwriting a newer entry', () => {
    const result = mergeChatHistory([chat('a', 30), chat('b', 20)], [chat('b', 10), { ...chat('c', 5), recencyAt: 40 }])
    expect(result.map((thread) => thread.id)).toEqual(['c', 'a', 'b'])
    expect(result[2]?.updatedAt).toBe(20)
  })

  it('groups dates in local time, including yesterday across a daylight-saving boundary', () => {
    const now = new Date(2026, 2, 9, 12)
    const date = (day: number, hour: number) => new Date(2026, 2, day, hour).getTime() / 1000
    const result = groupChatHistory([chat('today', date(9, 0)), chat('yesterday', date(8, 0)), chat('older', date(7, 23)), chat('unknown', 0)], now)
    expect(result.map((group) => group.label).slice(0, 2)).toEqual(['Today', 'Yesterday'])
    expect(result.at(-1)?.label).toBe('Earlier')
    expect(result).toHaveLength(4)
  })

  it('only loads once for concurrent requests and stops at the end', async () => {
    const pending = deferred<ChatHistoryPage>()
    const read = vi.fn(() => pending.promise)
    const store = new ChatHistoryStore(read)
    const first = store.load()
    await store.load()
    expect(read).toHaveBeenCalledTimes(1)
    pending.resolve(page([chat('a', 1)]))
    await first
    await store.load()
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.snapshot()).toMatchObject({ loaded: true, loading: false, nextCursor: null })
  })

  it('continues with the native cursor, retaining older loaded pages', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([chat('a', 3)], 'page-2'))
      .mockResolvedValueOnce(page([chat('a', 3), chat('b', 2)]))
    const store = new ChatHistoryStore(read)
    await store.load()
    await store.load()
    expect(read.mock.calls).toEqual([[undefined], ['page-2']])
    expect(store.snapshot().threads.map((thread) => thread.id)).toEqual(['a', 'b'])
  })

  it('keeps rows after errors and retries the failed page', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([chat('a', 3)], 'page-2'))
      .mockRejectedValueOnce(new Error('Disconnected'))
      .mockResolvedValueOnce(page([chat('b', 2)]))
    const store = new ChatHistoryStore(read)
    await store.load()
    await store.load()
    expect(store.snapshot().threads).toHaveLength(1)
    expect(store.snapshot().error).toBe('Disconnected')
    await store.retry()
    expect(read.mock.calls.at(-1)).toEqual(['page-2'])
    expect(store.snapshot().threads).toHaveLength(2)
    expect(store.snapshot().error).toBe('')
  })

  it('can retry a refresh after reaching the end of history', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([chat('a', 1)]))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page([chat('b', 2)]))
    const store = new ChatHistoryStore(read)
    await store.load()
    await store.load(true)
    await store.retry()
    expect(read).toHaveBeenCalledTimes(3)
    expect(store.snapshot().threads.map((thread) => thread.id)).toEqual(['b'])
  })

  it('ignores an older in-flight request after refresh', async () => {
    const old = deferred<ChatHistoryPage>()
    const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([chat('fresh', 5)]))
    const store = new ChatHistoryStore(read)
    const loading = store.load()
    await store.load(true)
    old.resolve(page([chat('stale', 1)], 'stale-cursor'))
    await loading
    expect(store.snapshot().threads.map((thread) => thread.id)).toEqual(['fresh'])
    expect(store.snapshot().nextCursor).toBeNull()
  })

  it('does not publish an asynchronous completion after disposal', async () => {
    const pending = deferred<ChatHistoryPage>()
    const store = new ChatHistoryStore(() => pending.promise)
    const listener = vi.fn()
    store.subscribe(listener)
    const loading = store.load()
    listener.mockClear()
    store.dispose()
    pending.resolve(page([chat('a', 1)]))
    await loading
    expect(listener).not.toHaveBeenCalled()
    expect(store.snapshot().threads).toEqual([])
  })

  it('rejects cursor cycles across multiple pages', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([chat('a', 3)], 'b'))
      .mockResolvedValueOnce(page([chat('b', 2)], 'c'))
      .mockResolvedValueOnce(page([chat('c', 1)], 'b'))
    const store = new ChatHistoryStore(read)
    await store.load(); await store.load(); await store.load()
    expect(store.snapshot().error).toContain('repeated')
    expect(store.snapshot().threads).toHaveLength(2)
  })

  it('focuses an existing chat without creating a duplicate pane', () => {
    const layout = { focusThread: vi.fn(() => true), openPane: vi.fn() }
    openHistoryChat(layout as unknown as ClientWorkspaceLayoutService, chat('a', 1))
    expect(layout.focusThread).toHaveBeenCalledWith('a')
    expect(layout.openPane).not.toHaveBeenCalled()
  })

  it('opens other chats through the normal pane API while preserving History', () => {
    const layout = { focusThread: vi.fn(() => false), openPane: vi.fn() }
    const thread = { ...chat('a', 1), projectId: 'repo' }
    openHistoryChat(layout as unknown as ClientWorkspaceLayoutService, thread)
    expect(layout.openPane).toHaveBeenCalledWith({ kind: 'chat', direction: 'horizontal', thread, workspace: thread.cwd, projectId: 'repo' })
  })

  it('does not infer a workspace for explicitly unassigned chats', () => {
    expect(historyWorkspace(chat('a', 1), [])).toBe('No workspace')
    expect(historyWorkspace({ ...chat('a', 1), projectId: 'p' }, [{ id: 'p', name: 'Project' } as never])).toBe('Project')
  })
})
