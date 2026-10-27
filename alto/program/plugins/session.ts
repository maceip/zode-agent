import type {} from './conversation-titles-api.js'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord } from '../../src/shared/protocol.js'
import { SESSION_CODEX_START, SESSION_THREAD_RENAME, SESSION_WORKSPACE_STATE } from './session-api.js'
import { ensureScratchWorkspace } from './session-workspace.js'

interface CodexConfigAccess {
  setThreadName?: (threadId: string, name: string) => Promise<void>
  client?: {
    request<T>(method: string, params: unknown): Promise<T>
  }
}

async function setThreadName(codex: unknown, threadId: string, name: string): Promise<void> {
  const access = codex as CodexConfigAccess
  if (typeof access.setThreadName === 'function') {
    await access.setThreadName(threadId, name)
    return
  }
  if (!access.client) throw new Error('Codex thread naming is unavailable')
  await access.client.request('thread/name/set', { threadId, name })
}

const session: HarnessPlugin = async (ctx) => {
  const workspace = await ensureScratchWorkspace()
  ctx.clientExtensions.registerState(ctx, SESSION_WORKSPACE_STATE, workspace)
  const codex = ctx.codex
  const initialDefaults = codex.snapshot().defaults
  const defaults = ctx.clientExtensions.registerState(
    ctx,
    'session.defaults',
    initialDefaults ? { ...initialDefaults } : null,
  )
  // Reading config starts Codex. Wait for a Codex action to load it, so ACP
  // users can open Alto and choose an agent without installing Codex.
  ctx.effect(() => {
    const changed = (): void => {
      const snapshot = codex.snapshot()
      if (snapshot.status === 'ready') defaults.update(snapshot.defaults ? { ...snapshot.defaults } : null)
    }
    codex.on('status', changed)
    return () => { codex.off('status', changed) }
  }, 'session.defaults')
  ctx.clientExtensions.registerMethod(ctx, SESSION_CODEX_START, async () => {
    await codex.start()
    return null
  })
  ctx.clientExtensions.registerMethod(ctx, SESSION_THREAD_RENAME, async (payload) => {
    if (!isRecord(payload)) throw new Error('thread rename request is required')
    const threadId = typeof payload.threadId === 'string' ? payload.threadId.trim() : ''
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (!threadId) throw new Error('threadId is required')
    if (!name) throw new Error('chat name is required')
    await ctx.waterfall('conversation/rename', threadId, name, () => setThreadName(ctx.codex, threadId, name))
    return { threadId, name }
  })
}

session.inject = ['clientExtensions', 'codex']

export default session
