import type { AgentConfigOption, AgentProviderSnapshot } from '../../src/server/services/agent-registry.js'
import { isRecord } from '../../src/shared/protocol.js'

export const MODEL_DEFAULTS_STATE = 'model-defaults'
export const MODEL_DEFAULTS_SET = 'model-defaults.set'
export const MODEL_DEFAULTS_DISCOVER = 'model-defaults.discover'
export const MODEL_DEFAULTS_STATUS = 'model-defaults.status'

export interface ModelDefaultsChoice {
  model?: string
  effort?: string
}

export interface ModelDefaultsPreferences {
  providerId: string
  choices: Record<string, ModelDefaultsChoice>
}

export interface ModelDefaultsUpdate {
  providerId: string
  model?: string | null
  effort?: string | null
}

export interface ModelDefaultsDiscovery {
  configOptions: AgentConfigOption[]
  provider: AgentProviderSnapshot
}

export interface ModelDefaultsStatus {
  preferences: ModelDefaultsPreferences
  providers: AgentProviderSnapshot[]
  nativeCodex: Pick<AgentProviderSnapshot, 'status' | 'activeSessionIds'>
}

export function validDefaultProviderId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
}

export function validDefaultChoice(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
    && value.length <= 256 && !/[\r\n\0]/.test(value)
}

/** Missing or malformed extension state does not change an existing draft. */
export function modelDefaults(value: unknown): ModelDefaultsPreferences | undefined {
  if (!isRecord(value) || !validDefaultProviderId(value.providerId) || !isRecord(value.choices)) return undefined
  const choices: Array<[string, ModelDefaultsChoice]> = []
  for (const [id, choice] of Object.entries(value.choices)) {
    if (!validDefaultProviderId(id) || !isRecord(choice)) return undefined
    if (choice.model !== undefined && !validDefaultChoice(choice.model)) return undefined
    if (choice.effort !== undefined && !validDefaultChoice(choice.effort)) return undefined
    choices.push([id, {
      ...(typeof choice.model === 'string' ? { model: choice.model } : {}),
      ...(typeof choice.effort === 'string' ? { effort: choice.effort } : {}),
    }])
  }
  return { providerId: value.providerId, choices: Object.fromEntries(choices) }
}
