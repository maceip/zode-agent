import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import type { AgentProviderSnapshot } from '../../src/server/services/agent-registry.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import {
  MODEL_DEFAULTS_DISCOVER,
  MODEL_DEFAULTS_SET,
  MODEL_DEFAULTS_STATE,
  MODEL_DEFAULTS_STATUS,
  validDefaultChoice,
  validDefaultProviderId,
  type ModelDefaultsPreferences,
  type ModelDefaultsUpdate,
} from './model-defaults-api.js'
import { readModelDefaults, writeModelDefaults } from './model-defaults-store.js'

const modelDefaults: HarnessPlugin = (ctx) => {
  let active = true
  let saving = Promise.resolve()
  ctx.effect(() => () => {
    active = false
    return saving.catch(() => {})
  }, 'modelDefaults.lifetime')

  const codex = ctx.codex
  const agents = ctx.agents
  const extensions = ctx.clientExtensions
  const preferencesState = extensions.registerState(ctx, MODEL_DEFAULTS_STATE, null)
  let preferences: ModelDefaultsPreferences = { providerId: 'codex', choices: {} }
  let ready = Promise.resolve()
  const file = path.join(ctx.program.projectRoot, '.codex-cordis', 'model-defaults.json')
  const enabledProvider = (id: string) => id === 'codex' || agents.snapshot().some((provider) => provider.id === id)
  ctx.effect(() => {
    ready = readModelDefaults(file).then((saved) => {
      if (!active) return
      preferences = enabledProvider(saved.providerId) ? saved : { ...saved, providerId: 'codex' }
      preferencesState.update(preferences as unknown as JsonValue)
    })
    return () => ready.catch(() => {})
  }, 'modelDefaults.load')

  extensions.registerMethod(ctx, MODEL_DEFAULTS_SET, (payload) => {
    if (!isRecord(payload) || !validDefaultProviderId(payload.providerId)) throw new Error('An enabled providerId is required')
    for (const key of ['model', 'effort'] as const) {
      if (payload[key] !== undefined && payload[key] !== null && !validDefaultChoice(payload[key])) {
        throw new Error(`${key} must be a nonempty string or null`)
      }
    }
    const update = payload as unknown as ModelDefaultsUpdate
    const operation = saving.then(async () => {
      await ready
      if (!active) throw new Error('Model defaults are unavailable')
      if (!enabledProvider(update.providerId)) throw new Error('The default agent is no longer enabled')
      const choice = { ...preferences.choices[update.providerId] }
      for (const key of ['model', 'effort'] as const) {
        if (update[key] === null) delete choice[key]
        else if (typeof update[key] === 'string') choice[key] = update[key]
      }
      const next: ModelDefaultsPreferences = {
        providerId: update.providerId,
        choices: { ...preferences.choices, [update.providerId]: choice },
      }
      await writeModelDefaults(file, next)
      if (active) {
        preferences = next
        preferencesState.update(preferences as unknown as JsonValue)
      }
      return next as unknown as JsonValue
    })
    saving = operation.then(() => {}, () => {})
    return operation
  })

  extensions.registerMethod(ctx, MODEL_DEFAULTS_DISCOVER, async (payload) => {
    if (!active || !isRecord(payload) || !validDefaultProviderId(payload.providerId)) throw new Error('An enabled providerId is required')
    if (typeof payload.cwd !== 'string' || !path.isAbsolute(payload.cwd)) throw new Error('An absolute cwd is required')
    const provider = payload.providerId === 'codex' ? undefined : agents.provider(payload.providerId)
    const snapshot: AgentProviderSnapshot = provider?.snapshot() ?? {
      id: 'codex', label: 'Codex', protocol: 'codex-app-server', status: codex.snapshot().status,
      capabilities: { images: true, resources: true, mcpServers: false, sessionHistory: true, sessionModes: false },
      activeSessionIds: codex.snapshot().activeThreadIds,
    }
    if (!provider || snapshot.protocol !== 'acp' || snapshot.remoteLocation
      || (snapshot.location && snapshot.location.id !== 'local') || snapshot.capabilities.durableSession) {
      return { configOptions: snapshot.configOptions ?? [], provider: snapshot } as unknown as JsonValue
    }
    // Only an explicit discovery request starts a local agent. A temporary
    // session asks for the real catalog and closes without ever sending a prompt.
    const temporary = await provider.createSession({ cwd: payload.cwd, permissionMode: 'ask', mcpServers: [] })
    let configOptions = temporary.configOptions ?? []
    try {
      if (!active) throw new Error('Model defaults are unavailable')
      configOptions = structuredClone(configOptions)
    } finally {
      await provider.closeSession(temporary.id)
    }
    if (!active) throw new Error('Model defaults are unavailable')
    return { configOptions, provider: provider.snapshot() } as unknown as JsonValue
  })

  const status = async () => {
    await ready
    if (!active) throw new Error('Model defaults are unavailable')
    const native = codex.snapshot()
    return {
      preferences,
      providers: agents.snapshot(),
      nativeCodex: { status: native.status, activeSessionIds: native.activeThreadIds },
    }
  }
  extensions.registerMethod(ctx, MODEL_DEFAULTS_STATUS, async () => await status() as unknown as JsonValue)
  ctx.tools.register(ctx, {
    namespace: 'model-defaults', name: 'status',
    description: 'Inspect saved model defaults and enabled agent sessions without starting an agent.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }, status)
}

modelDefaults.inject = ['clientExtensions', 'codex', 'agents', 'program', 'tools']

export default modelDefaults
