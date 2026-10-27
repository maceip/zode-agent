import type { AgentChats } from './agent-chats.js'
import { isAgentChatId } from './agent-chats-api.js'
import { requireAgentChats } from './agent-chats-access.js'
import { z } from 'zod'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import type { JsonValue } from '../../src/shared/protocol.js'
import { EMPTY_ORCHESTRATOR, ORCHESTRATOR_OPEN, ORCHESTRATOR_REFRESH, ORCHESTRATOR_STATE, ORCHESTRATOR_STOP } from './orchestrator-api.js'
import { NativeAgentMonitor, type NativeAgentRuntime } from './orchestrator-model.js'

const json = (value: unknown): JsonValue => value as JsonValue
const scope = z.object({ parentThreadId: z.string().min(1), id: z.string().min(1) })
const orchestrator: HarnessPlugin = (ctx) => {
  ctx.ui.register(ctx, { id: 'orchestrator-toggle', slot: 'header-right', order: 990, nodes: [] })
  const registration = ctx.clientExtensions.registerState(ctx, ORCHESTRATOR_STATE, json(EMPTY_ORCHESTRATOR))
  // Use the existing app-server connection, including experimental native
  // ancestry filters not yet exposed by CodexService's top-level chat list.
  const access = ctx.codex as unknown as { client?: NativeAgentRuntime }
  let active = true
  let agentChats: AgentChats | undefined
  let nativeSnapshot = EMPTY_ORCHESTRATOR
  let revision = 0
  const snapshot = () => {
    const tasks = agentChats?.tasks() ?? []
    return { revision, tasks: [...nativeSnapshot.tasks, ...tasks], ...(!tasks.length && nativeSnapshot.error ? { error: nativeSnapshot.error } : {}) }
  }
  const publish = () => { if (!active) return; revision++; registration.update(json(snapshot())) }
  // ACP contributes tasks without owning the native monitor or panel methods.
  ctx.inject(['agentChats'], (child) => {
    agentChats = child.agentChats
    child.on('agent-chats/changed', publish)
    publish()
    return () => { agentChats = undefined; publish() }
  })
  const monitor = new NativeAgentMonitor({
    request: async (method, params) => {
      if (!access.client) throw new Error('Native subagent history is unavailable in this runtime.')
      await ctx.codex.start()
      return access.client.request(method, params)
    },
  }, (value) => { nativeSnapshot = value; publish() })
  ctx.effect(() => {
    if (ctx.codex.snapshot().status === 'ready') void monitor.refresh()
    const refresh = setInterval(() => { if (ctx.codex.snapshot().status === 'ready') void monitor.refresh() }, 30_000)
    return () => { active = false; clearInterval(refresh); monitor.dispose() }
  }, 'orchestrator.monitor')
  ctx.on('codex/notification', (notification) => monitor.notification(notification))
  ctx.effect(() => {
    let previous = ctx.codex.snapshot().status
    const changed = (): void => {
      const status = ctx.codex.snapshot().status
      if (status === previous) return
      previous = status
      if (status === 'ready') void monitor.refresh()
      else monitor.connectionLost()
    }
    ctx.codex.on('status', changed)
    return () => { ctx.codex.off('status', changed) }
  }, 'orchestrator.connection')
  ctx.clientExtensions.registerMethod(ctx, ORCHESTRATOR_REFRESH, async (payload) => {
    const input = z.object({ parentThreadId: z.string().min(1).optional() }).parse(payload ?? {})
    if (input.parentThreadId ? !isAgentChatId(input.parentThreadId) : ctx.codex.snapshot().status === 'ready') {
      await monitor.refresh(input.parentThreadId)
    }
    publish()
    return json(snapshot())
  })
  ctx.clientExtensions.registerMethod(ctx, ORCHESTRATOR_OPEN, async (payload) => {
    const input = scope.extend({ cursor: z.string().optional() }).parse(payload)
    if (isAgentChatId(input.parentThreadId)) return json(await requireAgentChats(ctx).taskHistory(input.parentThreadId, input.id))
    return json(await monitor.history(input.parentThreadId, input.id, input.cursor))
  })
  ctx.clientExtensions.registerMethod(ctx, ORCHESTRATOR_STOP, async (payload) => {
    const input = scope.partial({ id: true }).parse(payload)
    if (isAgentChatId(input.parentThreadId)) await requireAgentChats(ctx).stopTask(input.parentThreadId, input.id)
    else await monitor.stop(input.parentThreadId, input.id)
    publish()
    return json(snapshot())
  })
}
orchestrator.inject = ['codex', 'clientExtensions', 'ui']
export default orchestrator
