import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import orchestrator from '../program/plugins/orchestrator.js'
import type { HarnessContext } from '../src/server/plugin-api.js'

describe('native agent plugin boundaries', () => {
  it('registers inspection without custom tools or prompt injection', async () => {
    const methods = new Map<string, (input: unknown) => Promise<unknown>>()
    const events = new Map<string, Function>()
    const disposers: Array<() => void> = []
    const request = vi.fn(async () => ({ data: [] }))
    const registerTool = vi.fn()
    const ctx = {
      get: (name: string) => name === 'agentChats' ? ctx.agentChats : undefined,
      inject: (_services: string[], apply: (child: unknown) => () => void) => { disposers.push(apply(ctx)) },
      agentChats: { tasks: () => [] },
      codex: { client: { request }, start: vi.fn(async () => {}), on: vi.fn(), off: vi.fn(), snapshot: () => ({ status: 'ready' }) },
      ui: { register: vi.fn() },
      tools: { register: registerTool },
      clientExtensions: {
        registerState: () => ({ update: vi.fn() }),
        registerMethod: (_owner: unknown, name: string, handler: (input: unknown) => Promise<unknown>) => methods.set(name, handler),
      },
      on: (event: string, handler: Function) => events.set(event, handler),
      effect: (effect: () => () => void) => { disposers.push(effect()) },
    }
    ;(orchestrator as (ctx: HarnessContext) => void)(ctx as unknown as HarnessContext)
    try {
      await methods.get('orchestrator.refresh')!({ parentThreadId: 'parent' })
      expect(registerTool).not.toHaveBeenCalled()
      expect(events.has('codex/turn/prepare')).toBe(false)
      expect(methods.has('orchestrator.open')).toBe(true)
      expect(request).toHaveBeenCalledWith('thread/loaded/list', { limit: 100 })
    } finally { for (const dispose of disposers) dispose() }
  })
  it('keeps inspection in the parent panel without resuming children', async () => {
    const client = await readFile(new URL('../program/plugins/orchestrator.client.tsx', import.meta.url), 'utf8')
    const model = await readFile(new URL('../program/plugins/orchestrator-model.ts', import.meta.url), 'utf8')
    expect(client).toContain('<AgentConversation')
    expect(client).not.toContain('layout.openPane')
    expect(client).not.toContain('layout.focusThread')
    expect(model).not.toContain("'thread/resume'")
    expect(model).not.toContain("'thread/start'")
    expect(model).not.toContain("'turn/start'")
  })
})

it('publishes and manages Claude children even while the native Codex monitor is unavailable', async () => {
  const parentThreadId = 'acp-11111111-1111-1111-1111-111111111111'
  const task = { id: `${parentThreadId}:child`, threadId: `${parentThreadId}:child`, parentThreadId, status: 'working' }
  const methods = new Map<string, (input: unknown) => Promise<unknown>>()
  const events = new Map<string, () => void>()
  const disposers: Array<() => void> = []
  const update = vi.fn()
  const taskHistory = vi.fn(async () => ({ messages: [{ id: 'output', role: 'agent', text: 'Child output' }] }))
  const stopTask = vi.fn(async () => {})
  const ctx = {
    get: (name: string) => name === 'agentChats' ? ctx.agentChats : undefined,
    inject: (_services: string[], apply: (child: unknown) => () => void) => { disposers.push(apply(ctx)) },
    agentChats: { tasks: () => [task], taskHistory, stopTask },
    codex: { on: vi.fn(), off: vi.fn(), snapshot: () => ({ status: 'failed' }) },
    ui: { register: vi.fn() },
    clientExtensions: {
      registerState: () => ({ update }),
      registerMethod: (_owner: unknown, name: string, handler: (input: unknown) => Promise<unknown>) => methods.set(name, handler),
    },
    on: (name: string, handler: () => void) => events.set(name, handler),
    effect: (effect: () => () => void) => { disposers.push(effect()) },
  }
  ;(orchestrator as (ctx: HarnessContext) => void)(ctx as unknown as HarnessContext)
  try {
    await methods.get('orchestrator.refresh')!({ parentThreadId })
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ tasks: [task] }))
    expect(update.mock.lastCall?.[0].error).toBeUndefined()
    const history = await methods.get('orchestrator.open')!({ parentThreadId, id: task.id })
    expect(history).toMatchObject({ messages: [{ text: 'Child output' }] })
    expect(taskHistory).toHaveBeenCalledWith(parentThreadId, task.id)
    await methods.get('orchestrator.stop')!({ parentThreadId, id: task.id })
    expect(stopTask).toHaveBeenCalledWith(parentThreadId, task.id)
    const before = update.mock.calls.length
    events.get('agent-chats/changed')!()
    expect(update.mock.calls.length).toBeGreaterThan(before)
  } finally { for (const dispose of disposers) dispose() }
})
