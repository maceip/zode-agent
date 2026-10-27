import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NativeAgentMonitor, nativeParent } from '../program/plugins/orchestrator-model.js'
import { AgentHistoryCache } from '../program/plugins/orchestrator-cache.js'
import { taskActive, tasksForChat } from '../program/plugins/orchestrator-api.js'
import { AgentTaskRow } from '../program/plugins/orchestrator.client.js'
import { AgentHistoryMessage, mergeAgentHistory } from '../program/plugins/orchestrator-history.client.js'
import type { ClientMarkdownService } from '../program/plugins/markdown-api.js'

const child = { id: 'child', name: 'Review the change', parentThreadId: 'parent', cwd: '/repo', createdAt: 1, updatedAt: 2, status: { type: 'notLoaded' } }
const turn = { id: 'turn', status: 'completed', startedAt: 1, completedAt: 2, items: [
  { id: 'input', type: 'userMessage', content: [{ type: 'text', text: 'Review this' }] },
  { id: 'tool', type: 'commandExecution', command: 'git diff', status: 'completed', aggregatedOutput: 'diff output' },
  { id: 'reply', type: 'agentMessage', text: '**Result** <script>bad()</script>', phase: 'final_answer' },
] }
function harness(threads: Record<string, unknown>[] = [child], latestTurn = turn) {
  const records = new Map(threads.map((thread) => [thread.id, thread]))
  records.set('parent', { id: 'parent', name: 'Parent title' })
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'thread/loaded/list') return { data: threads.map((thread) => thread.id) }
    if (method === 'thread/read') return { thread: records.get(params.threadId) }
    if (method === 'thread/turns/list') return { data: [latestTurn], nextCursor: params.cursor ? 'older' : null }
    if (method === 'turn/interrupt') return {}
    throw new Error('Unexpected method ' + method)
  })
  const publish = vi.fn()
  const monitor = new NativeAgentMonitor({ request }, publish)
  return { monitor, request, publish, records }
}
describe('native agent monitor', () => {
  it('uses actual ancestry, including older native source metadata', () => {
    expect(nativeParent(child)).toBe('parent')
    expect(nativeParent({ source: { subAgent: { thread_spawn: { parent_thread_id: 'older-parent' } } } })).toBe('older-parent')
    expect(nativeParent({ source: 'appServer' })).toBeUndefined()
  })
  it('reads agents without starting or resuming threads', async () => {
    const h = harness()
    await h.monitor.refresh('parent')
    expect(h.request).toHaveBeenCalledWith('thread/loaded/list', { limit: 100 })
    expect(h.monitor.snapshot().tasks[0]).toMatchObject({ id: 'child', parentTitle: 'Parent title', status: 'unknown', result: '' })
    expect(h.request.mock.calls.every(([method]) => ['thread/loaded/list', 'thread/read'].includes(method))).toBe(true)
    h.monitor.dispose()
  })
  it('does not count an unfinished saved turn as running when its thread is unloaded or idle', async () => {
    const h = harness([
      child,
      { ...child, id: 'idle', status: { type: 'idle' } },
      { ...child, id: 'live', status: { type: 'active', activeFlags: [] } },
      { ...child, id: 'waiting', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } },
    ], { ...turn, status: 'inProgress' })
    try {
      await h.monitor.refresh()
      expect(h.monitor.snapshot().tasks.filter(taskActive).map((task) => task.id)).toEqual(['live', 'waiting'])
      expect(h.monitor.snapshot().tasks.find((task) => task.id === 'waiting')?.status).toBe('waiting')
      expect(h.monitor.snapshot().tasks.find((task) => task.id === 'child')?.status).toBe('unknown')
    } finally { h.monitor.dispose() }
  })
  it('never reads unloaded historical agents during refresh', async () => {
    const h = harness()
    const request = h.request.getMockImplementation()!
    h.request.mockImplementation((method, params) => method === 'thread/loaded/list' ? Promise.resolve({ data: [] }) : request(method, params))
    try {
      await h.monitor.refresh()
      expect(h.monitor.snapshot().tasks).toEqual([])
      expect(h.request.mock.calls.map(([method]) => method)).toEqual(['thread/loaded/list'])
      const page = await h.monitor.history('parent', 'child')
      expect(page.messages.at(-1)?.text).toContain('Result')
    } finally { h.monitor.dispose() }
  })
  it('uses one paginated loaded list across simultaneous panel scopes and caches parent classification', async () => {
    const h = harness()
    const request = h.request.getMockImplementation()!
    h.records.set('root', { id: 'root', name: 'Main chat' })
    h.request.mockImplementation((method, params) => method === 'thread/loaded/list'
      ? Promise.resolve(params.cursor ? { data: ['child'] } : { data: ['root'], nextCursor: 'next' })
      : request(method, params))
    try {
      await Promise.all([h.monitor.refresh(), h.monitor.refresh('parent')])
      expect(h.request.mock.calls.filter(([method]) => method === 'thread/loaded/list')).toHaveLength(2)
      expect(h.request).toHaveBeenCalledWith('thread/loaded/list', { limit: 100, cursor: 'next' })
      expect(h.monitor.snapshot().tasks.map((task) => task.id)).toEqual(['child'])
      h.request.mockClear()
      await h.monitor.refresh()
      expect(h.request.mock.calls.filter(([method]) => method === 'thread/read').map(([, params]) => params.threadId)).not.toContain('root')
      expect(h.request.mock.calls.some(([method]) => method === 'thread/turns/list' || method === 'thread/list')).toBe(false)
    } finally { h.monitor.dispose() }
  })
  it('drops vanished agents from active counts without mistaking a new spawn for a vanished agent', async () => {
    const live = { ...child, status: { type: 'active', activeFlags: [] } }
    const h = harness([live])
    const request = h.request.getMockImplementation()!
    try {
      await h.monitor.refresh()
      let finish!: (value: unknown) => void
      h.request.mockImplementation((method, params) => method === 'thread/loaded/list'
        ? new Promise((resolve) => { finish = resolve }) : request(method, params))
      const pending = h.monitor.refresh()
      h.monitor.notification({ method: 'thread/started', params: { thread: { ...live, id: 'new' } } })
      finish({ data: [] })
      await pending
      expect(h.monitor.snapshot().tasks.filter(taskActive).map((task) => task.id)).toEqual(['new'])
    } finally { h.monitor.dispose() }
  })
  it('preserves a completion notification received during a slower status read', async () => {
    const live = { ...child, status: { type: 'active', activeFlags: [] } }
    const h = harness([live])
    const request = h.request.getMockImplementation()!
    try {
      await h.monitor.refresh()
      let finish!: (value: unknown) => void
      h.request.mockImplementation((method, params) => method === 'thread/read' && params.threadId === 'child'
        ? new Promise((resolve) => { finish = resolve }) : request(method, params))
      const pending = h.monitor.refresh()
      await vi.waitFor(() => expect(finish).toBeDefined())
      h.monitor.notification({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'turn', status: 'completed' } } })
      finish({ thread: live })
      await pending
      expect(h.monitor.snapshot().tasks[0]?.status).toBe('done')
    } finally { h.monitor.dispose() }
  })
  it('clears live counts when the connection is lost and restores verified status on refresh', async () => {
    const h = harness([{ ...child, status: { type: 'active', activeFlags: [] } }])
    try {
      await h.monitor.refresh()
      expect(h.monitor.snapshot().tasks.filter(taskActive)).toHaveLength(1)
      h.monitor.connectionLost()
      expect(h.monitor.snapshot().tasks.filter(taskActive)).toHaveLength(0)
      expect(h.monitor.snapshot().error).toContain('Reconnecting')
      await h.monitor.refresh()
      expect(h.monitor.snapshot().tasks.filter(taskActive)).toHaveLength(1)
      expect(h.monitor.snapshot().error).toBeUndefined()
    } finally { h.monitor.dispose() }
  })
  it('stops counting idle agents immediately when a turn completion notification was missed', async () => {
    const h = harness([{ ...child, status: { type: 'active', activeFlags: [] } }])
    try {
      await h.monitor.refresh()
      expect(h.monitor.snapshot().tasks.filter(taskActive)).toHaveLength(1)
      h.monitor.notification({ method: 'thread/status/changed', params: { threadId: 'child', status: { type: 'idle' } } })
      expect(h.monitor.snapshot().tasks.filter(taskActive)).toHaveLength(0)
      await vi.waitFor(() => expect(h.monitor.snapshot().tasks[0]?.status).toBe('done'))
    } finally { h.monitor.dispose() }
  })
  it('coalesces loaded agent results and does not publish or scan turns on unchanged refreshes', async () => {
    vi.useFakeTimers()
    const h = harness(Array.from({ length: 100 }, (_, index) => ({ ...child, id: `child-${index}`, status: { type: 'active', activeFlags: [] } })))
    try {
      await h.monitor.refresh()
      await vi.advanceTimersByTimeAsync(100)
      expect(h.publish).toHaveBeenCalledTimes(1)
      expect(h.publish.mock.calls[0]![0]).toEqual(h.monitor.snapshot())
      expect(h.monitor.snapshot().tasks).toHaveLength(100)
      const revision = h.monitor.snapshot().revision
      h.publish.mockClear()
      await h.monitor.refresh()
      await vi.advanceTimersByTimeAsync(100)
      expect(h.publish).not.toHaveBeenCalled()
      expect(h.monitor.snapshot().revision).toBe(revision)
      expect(h.request.mock.calls.some(([method]) => method === 'thread/turns/list' || method === 'thread/list')).toBe(false)
    } finally { h.monitor.dispose(); vi.useRealTimers() }
  })
  it('publishes partial results while another loaded agent status is still being read', async () => {
    vi.useFakeTimers()
    const h = harness([child, { ...child, id: 'slow' }])
    const request = h.request.getMockImplementation()!
    let finish!: (value: unknown) => void
    h.request.mockImplementation((method, params) => method === 'thread/read' && params.threadId === 'slow'
      ? new Promise((resolve) => { finish = resolve }) : request(method, params))
    try {
      const refresh = h.monitor.refresh()
      await vi.advanceTimersByTimeAsync(100)
      expect(h.publish).toHaveBeenCalledTimes(1)
      expect(h.publish.mock.calls[0]![0].tasks).toEqual([expect.objectContaining({ id: 'child', status: 'unknown' })])
      finish({ thread: { ...child, id: 'slow', status: { type: 'active', activeFlags: [] } } })
      await refresh
      await vi.advanceTimersByTimeAsync(100)
      expect(h.publish).toHaveBeenCalledTimes(2)
      expect(h.publish.mock.calls[1]![0]).toEqual(h.monitor.snapshot())
      expect(h.monitor.snapshot().tasks.filter(taskActive)).toHaveLength(1)
    } finally { h.monitor.dispose(); vi.useRealTimers() }
  })
  it('keeps publishing current state during continuous notifications', async () => {
    vi.useFakeTimers()
    const h = harness()
    try {
      await h.monitor.refresh()
      await vi.advanceTimersByTimeAsync(100)
      h.publish.mockClear()
      for (let index = 0; index < 10; index++) {
        h.monitor.notification({ method: 'item/completed', params: { threadId: 'child', item: { type: 'agentMessage', text: `Result ${index}` } } })
        await vi.advanceTimersByTimeAsync(20)
      }
      expect(h.publish).toHaveBeenCalledTimes(2)
      expect(h.publish.mock.calls.map(([snapshot]) => snapshot.tasks[0].result)).toEqual(['Result 4', 'Result 9'])
    } finally { h.monitor.dispose(); vi.useRealTimers() }
  })
  it('cancels pending publications when the monitor unloads', async () => {
    vi.useFakeTimers()
    const h = harness()
    try {
      await h.monitor.refresh()
      h.publish.mockClear()
      h.monitor.dispose()
      await vi.advanceTimersByTimeAsync(100)
      expect(h.publish).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { h.monitor.dispose(); vi.useRealTimers() }
  })
  it('includes nested descendants outside the recent parent list', async () => {
    const h = harness([{ ...child, id: 'grandchild', parentThreadId: 'middle' }])
    h.records.set('middle', { id: 'middle', name: 'Middle', parentThreadId: 'parent' })
    await h.monitor.refresh('parent')
    expect(tasksForChat(h.monitor.snapshot().tasks, 'parent').map((task) => task.id)).toEqual(['grandchild'])
    expect(h.monitor.snapshot().tasks[0]?.ancestorThreadIds).toEqual(['middle', 'parent'])
    h.monitor.dispose()
  })
  it('checks native parent membership before history or interrupts', async () => {
    const h = harness()
    await expect(h.monitor.history('unrelated', 'child')).rejects.toThrow('does not belong')
    await expect(h.monitor.stop('unrelated', 'child')).rejects.toThrow('does not belong')
    expect(h.request.mock.calls.some(([method]) => method === 'thread/turns/list' || method === 'turn/interrupt')).toBe(false)
    h.monitor.dispose()
  })
  it('paginates read-only history including tool output', async () => {
    const h = harness()
    const page = await h.monitor.history('parent', 'child', 'cursor')
    expect(h.request).toHaveBeenCalledWith('thread/turns/list', { threadId: 'child', cursor: 'cursor', limit: 5, sortDirection: 'desc', itemsView: 'full' })
    expect(page.olderCursor).toBe('older')
    expect(page.messages.map((message) => message.role)).toEqual(['user', 'agent'])
    expect(page.messages[1]?.tracesBefore?.[0]?.text).toContain('diff output')
    h.monitor.dispose()
  })
  it('retains live traces before the first reply', async () => {
    const h = harness()
    h.request.mockImplementation(async (method) => method === 'thread/read' ? { thread: child } : { data: [{ ...turn, status: 'inProgress', items: turn.items.slice(0, 2) }] })
    const page = await h.monitor.history('parent', 'child')
    expect(page.messages.at(-1)?.tracesBefore?.[0]?.text).toContain('diff output')
    h.monitor.dispose()
  })
  it('updates native states and ignores stale completions', async () => {
    const h = harness()
    await h.monitor.refresh()
    h.monitor.notification({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'new' } } })
    h.monitor.notification({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'old', status: 'completed' } } })
    expect(h.monitor.snapshot().tasks[0]?.status).toBe('working')
    h.monitor.notification({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'new', status: 'failed', error: { message: 'Failure' } } } })
    expect(h.monitor.snapshot().tasks[0]).toMatchObject({ status: 'failed', error: 'Failure' })
    h.monitor.dispose()
  })
  it('uses child status, not the wait tool status', async () => {
    const h = harness()
    await h.monitor.refresh()
    h.monitor.notification({ method: 'item/completed', params: { item: { type: 'collabAgentToolCall', status: 'completed', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } } } })
    expect(h.monitor.snapshot().tasks[0]?.status).toBe('working')
    h.monitor.notification({ method: 'item/completed', params: { item: { type: 'collabAgentToolCall', receiverThreadIds: ['child'], agentsStates: { child: { status: 'shutdown' } } } } })
    expect(h.monitor.snapshot().tasks[0]?.status).toBe('stopped')
    h.monitor.dispose()
  })
  it('interrupts only the selected active native turn without resuming', async () => {
    const h = harness()
    h.request.mockImplementation(async (method) => method === 'thread/read' ? { thread: child } : method === 'thread/turns/list' ? { data: [{ ...turn, status: 'inProgress' }] } : {})
    await h.monitor.stop('parent', 'child')
    expect(h.request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'child', turnId: 'turn' })
    expect(h.request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false)
    h.monitor.dispose()
  })
  it('neither publishes nor stops agents after unloading', async () => {
    const h = harness()
    let finish!: (value: unknown) => void
    h.request.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const refresh = h.monitor.refresh()
    h.monitor.dispose()
    finish({ data: [child] })
    await refresh
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.request).toHaveBeenCalledTimes(1)
  })
  it('reports unsupported native APIs instead of an empty success', async () => {
    const h = harness()
    h.request.mockRejectedValue(new Error('Unsupported method'))
    await h.monitor.refresh()
    expect(h.monitor.snapshot().error).toContain('Unsupported method')
    h.monitor.dispose()
  })
})
describe('history cache and rendering', () => {
  it('deduplicates reads, expires and invalidates on updates', async () => {
    let now = 0
    const cache = new AgentHistoryCache(() => now)
    const read = vi.fn(async () => ({ messages: [] }))
    await Promise.all([cache.get('child', undefined, read), cache.get('child', undefined, read)])
    expect(read).toHaveBeenCalledTimes(1)
    cache.invalidate('child')
    await cache.get('child', undefined, read)
    now = 4000
    await cache.get('child', undefined, read)
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('bounds pages and retries failed reads', async () => {
    const cache = new AgentHistoryCache()
    const read = vi.fn(async () => ({ messages: [] }))
    for (let index = 0; index < 33; index++) await cache.get(String(index), undefined, read)
    await cache.get('0', undefined, read)
    expect(read).toHaveBeenCalledTimes(34)
    await expect(cache.get('failure', undefined, async () => { throw Error('offline') })).rejects.toThrow('offline')
    await expect(cache.get('failure', undefined, read)).resolves.toEqual({ messages: [] })
  })
  it('merges live messages by ID', () => {
    const old = { id: 'a', role: 'agent' as const, text: 'old' }
    const next = { ...old, text: 'new' }
    expect(mergeAgentHistory([old], [next])).toEqual([next])
  })
  it('replaces the temporary trace anchor when the real reply arrives', () => {
    const pending = { id: 'child:turn:pending-agent-output', role: 'agent' as const, text: '' }
    const reply = { id: 'child:turn:reply', role: 'agent' as const, text: 'Done' }
    expect(mergeAgentHistory([pending], [reply])).toEqual([reply])
  })
  it('renders safe Markdown and opens history instead of a pane', async () => {
    const h = harness()
    await h.monitor.refresh()
    const task = h.monitor.snapshot().tasks[0]!
    const row = renderToStaticMarkup(createElement(AgentTaskRow, { task, onOpen: () => {}, onStop: () => {} }))
    expect(row).toContain('View history')
    expect(row).not.toContain('Open conversation')
    expect(row).not.toContain('<script>')
    const state = { revision: 1, codeBlocks: [], fileLinks: [] }
    const markdown = { snapshot: () => state, subscribe: () => () => {} } as unknown as ClientMarkdownService
    const page = await h.monitor.history('parent', 'child')
    const html = renderToStaticMarkup(createElement(AgentHistoryMessage, { message: page.messages[1]!, markdown }))
    expect(html).toContain('<strong>Result</strong>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('diff output')
    h.monitor.dispose()
  })
})
