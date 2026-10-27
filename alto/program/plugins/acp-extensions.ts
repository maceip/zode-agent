import { z } from 'zod'
import type { Stream } from '@agentclientprotocol/sdk'
import { isRecord } from '../../src/shared/protocol.js'

const taskId = z.string().min(1).max(1024)
const update = z.discriminatedUnion('sessionUpdate', [
  z.object({ sessionUpdate: z.literal('subagent_spawned'), subagentSessionId: taskId, name: z.string(), task: z.string(), capabilities: z.object({ cancel: z.boolean().optional() }) }),
  z.object({ sessionUpdate: z.literal('subagent_state_update'), subagentSessionId: taskId, state: z.enum(['completed', 'failed', 'cancelled', 'disconnected']) }),
  z.object({ sessionUpdate: z.literal('async_task_spawned'), asyncTaskId: taskId, name: z.string(), description: z.string(), canStop: z.boolean() }),
  z.object({ sessionUpdate: z.literal('async_task_progress'), asyncTaskId: taskId, description: z.string().optional(), summary: z.string().optional() }),
  z.object({ sessionUpdate: z.literal('async_task_state_update'), asyncTaskId: taskId, state: z.enum(['running', 'paused', 'completed', 'failed', 'stopped']), summary: z.string().optional() }),
])
export const childNotification = z.object({ sessionId: taskId, update })
export type ChildNotification = z.infer<typeof childNotification>
export const CHILD_UPDATE = '_alto/child_update'
const extensionNames = new Set(update.options.map((option) => option.shape.sessionUpdate.value))

// The released ACP schema rejects draft child-session updates. Route just these
// negotiated extensions to their own parser; keep SDK validation for stable ACP.
export function withChildUpdates(stream: Stream): Stream {
  return { ...stream, readable: stream.readable.pipeThrough(new TransformStream({
    transform(message, controller) {
      if ('method' in message && message.method === 'session/update' && isRecord(message.params)
        && isRecord(message.params.update) && extensionNames.has(message.params.update.sessionUpdate as never)) {
        controller.enqueue({ ...message, method: CHILD_UPDATE })
      } else controller.enqueue(message)
    },
  })) }
}

export const childCapabilities = { jetbrains: { air: { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'] } } }
export function supportsChildren(meta: unknown): boolean {
  if (!isRecord(meta) || !isRecord(meta.jetbrains) || !isRecord(meta.jetbrains.air)) return false
  return Array.isArray(meta.jetbrains.air.capabilities) && meta.jetbrains.air.capabilities.includes('nativeSubagentSessions')
}
