import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, type Plugin } from 'cordis'
import { expect, it, vi } from 'vitest'
import type { AgentChats } from '../program/plugins/agent-chats.js'
import orchestrator from '../program/plugins/orchestrator.js'
import workActions from '../program/plugins/work-actions.js'
import workspaceLayout from '../program/plugins/workspace-layout.js'
import { clientExtensionRegistryPlugin } from '../src/server/services/client-extension-registry.js'
import { toolRegistryPlugin } from '../src/server/services/tool-registry.js'

it('keeps core plugins and native tools alive when ACP chats is absent, loaded, unloaded, and replaced', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alto-optional-acp-'))
  const root = new Context()
  const fibers: Array<{ dispose(): Promise<unknown> }> = []
  const checkout = { id: 'checkout', kind: 'local', branch: 'feature', location: directory, projectId: 'project' }
  const startThread = vi.fn(async () => ({ thread: { id: 'native-new' } }))
  const registerSurface = vi.fn()
  const services: Plugin = (ctx) => {
    ctx.provide('codex', { permissionModeForTurn: () => 'full', startThread,
      threadSummary: async () => ({ id: 'native-parent', cwd: directory }),
      client: { request: async () => ({ data: [] }) },
      on: vi.fn(), off: vi.fn(), snapshot: () => ({ status: 'ready' }),
    } as unknown as Context['codex'])
    ctx.provide('program', { projectRoot: directory } as Context['program'])
    ctx.provide('projects', { registerSource: () => ({ update: vi.fn() }) } as unknown as Context['projects'])
    ctx.provide('ui', { register: vi.fn(), registerSurface, registerShellRegion: vi.fn() } as unknown as Context['ui'])
    ctx.provide('workContexts', { checkout: () => checkout, setThreadTarget: vi.fn(), targetForThread: () => undefined,
      snapshot: () => ({ workstreams: [], providers: [] }),
    } as unknown as Context['workContexts'])
  }
  services.provide = ['codex', 'program', 'projects', 'ui', 'workContexts']
  const parentThreadId = 'acp-11111111-1111-1111-1111-111111111111'
  const task = { id: `${parentThreadId}:child`, parentThreadId, threadId: `${parentThreadId}:child`, status: 'working' }
  const installChats = async (text: string) => {
    const plugin: Plugin = (ctx) => {
      ctx.provide('agentChats', { tasks: () => [task], taskHistory: async () => ({ messages: [{ id: 'output', role: 'agent', text }] }) } as unknown as AgentChats)
    }
    plugin.provide = 'agentChats'
    const fiber = await root.plugin(plugin)
    fibers.push(fiber)
    return fiber
  }
  try {
    for (const plugin of [services, clientExtensionRegistryPlugin, toolRegistryPlugin, workspaceLayout, workActions, orchestrator]) {
      fibers.push(await root.plugin(plugin))
    }
    const commands = root.workspaceCommands
    const openPane = vi.spyOn(commands, 'openPane').mockResolvedValue({ workspaceId: 'workspace', paneId: 'pane' })
    const invoke = (tool: string, args = {}, threadId = 'native-parent') => root.tools.execute({
      callId: 'call', threadId, turnId: 'turn', tool: 'cordis', arguments: { operation: 'invoke', tool, arguments: args },
    })
    const assertNativeWorks = async () => {
      expect(root.workspaceCommands).toBe(commands)
      expect(registerSurface).toHaveBeenCalledOnce()
      expect((await invoke('workspace/open_pane')).success).toBe(true)
      expect((await invoke('work/select', { checkoutId: checkout.id, open: 'right' })).success).toBe(true)
      await expect(root.clientExtensions.call('orchestrator.refresh', {})).resolves.toMatchObject({ tasks: [] })
      expect(openPane).toHaveBeenLastCalledWith(expect.objectContaining({ thread: expect.objectContaining({ id: 'native-new' }) }))
    }
    await assertNativeWorks()
    const first = await installChats('First child')
    expect(root.clientExtensions.snapshot()['orchestrator']).toMatchObject({ tasks: [task] })
    const beforeChange = root.clientExtensions.snapshot()['orchestrator'] as { revision: number }
    root.emit('agent-chats/changed')
    expect(root.clientExtensions.snapshot()['orchestrator']).toMatchObject({ revision: beforeChange.revision + 1 })
    expect(root.workspaceCommands).toBe(commands)
    await expect(root.clientExtensions.call('orchestrator.open', { parentThreadId, id: task.id })).resolves.toMatchObject({ messages: [{ text: 'First child' }] })
    await first.dispose()
    expect(root.clientExtensions.snapshot()['orchestrator']).toMatchObject({ tasks: [] })
    const withoutChats = root.clientExtensions.snapshot()['orchestrator']
    root.emit('agent-chats/changed')
    expect(root.clientExtensions.snapshot()['orchestrator']).toEqual(withoutChats)
    await assertNativeWorks()
    await expect(root.clientExtensions.call('orchestrator.open', { parentThreadId, id: task.id })).rejects.toThrow('ACP chats is unavailable')
    const unavailable = await invoke('workspace/open_pane', {}, parentThreadId)
    expect(unavailable.success).toBe(false)
    const second = await installChats('Replacement child')
    expect(root.clientExtensions.snapshot()['orchestrator']).toMatchObject({ tasks: [task] })
    const beforeReplacementChange = root.clientExtensions.snapshot()['orchestrator'] as { revision: number }
    root.emit('agent-chats/changed')
    expect(root.clientExtensions.snapshot()['orchestrator']).toMatchObject({ revision: beforeReplacementChange.revision + 1 })
    await expect(root.clientExtensions.call('orchestrator.open', { parentThreadId, id: task.id })).resolves.toMatchObject({ messages: [{ text: 'Replacement child' }] })
    await second.dispose()
    await assertNativeWorks()
    expect(startThread).toHaveBeenCalledTimes(6)
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
