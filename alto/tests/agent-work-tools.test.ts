import { expect, it, vi } from 'vitest'
import type { DynamicToolCall, DynamicToolHandler, HarnessContext } from '../src/server/plugin-api.js'
import workActions from '../program/plugins/work-actions.js'

it('opens local work from Claude in another Claude chat and rejects unsupported retargets before changing Git', async () => {
  const threadId = 'acp-11111111-1111-1111-1111-111111111111'
  const nextId = 'acp-22222222-2222-2222-2222-222222222222'
  const checkout = { id: 'checkout', kind: 'local', branch: 'feature', location: '/tmp/worktree', projectId: 'project' }
  const methods = new Map<string, DynamicToolHandler>()
  const create = vi.fn(async () => ({ summary: { id: nextId, providerId: 'claude', cwd: checkout.location } }))
  const startThread = vi.fn()
  const openPane = vi.fn(async () => ({ paneId: 'new-pane' }))
  const createLocalBranch = vi.fn()
  let available = true
  const ctx = {
    codex: { permissionModeForTurn: () => undefined, startThread, threadSummary: vi.fn() },
    get: (name: string) => name === 'agentChats' && available ? ctx.agentChats : undefined,
    agentChats: { open: async () => ({ summary: { id: threadId, providerId: 'claude' } }), create, rename: vi.fn() },
    workContexts: { checkout: () => checkout, snapshot: () => ({ workstreams: [], providers: [] }),
      setThreadTarget: vi.fn(), targetForThread: () => undefined, createLocalBranch },
    workspaceCommands: { openPane },
    tools: { register: (_owner: unknown, spec: { name: string }, handler: DynamicToolHandler) => methods.set(spec.name, handler) },
  }
  ;(workActions as (ctx: HarnessContext) => void)(ctx as unknown as HarnessContext)
  const call: DynamicToolCall = { callId: 'call', threadId, turnId: 'turn', permissionMode: 'full', tool: 'select', arguments: { checkoutId: checkout.id, open: 'right' } }
  await methods.get('select')!(call)
  expect(create).toHaveBeenCalledWith('claude', checkout.location, 'full')
  expect(startThread).not.toHaveBeenCalled()
  expect(openPane).toHaveBeenCalledWith(expect.objectContaining({ anchorThreadId: threadId,
    thread: expect.objectContaining({ id: nextId, providerId: 'claude' }) }))
  await expect(methods.get('select')!({ ...call, arguments: { checkoutId: checkout.id } })).rejects.toThrow('new local pane')
  await expect(methods.get('create')!({ ...call, arguments: { branch: 'new', execution: 'local' } })).rejects.toThrow('new local pane')
  expect(createLocalBranch).not.toHaveBeenCalled()
  await expect(methods.get('select')!({ ...call, permissionMode: 'ask' })).rejects.toThrow('Full access')
  available = false
  await expect(methods.get('create')!({ ...call, arguments: { branch: 'new', execution: 'local', sourceCheckoutId: 'checkout', open: 'right' } })).rejects.toThrow('ACP chats is unavailable')
  expect(createLocalBranch).not.toHaveBeenCalled()
})
