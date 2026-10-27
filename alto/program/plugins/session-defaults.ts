import { isRecord, type CodexSessionDefaults, type HarnessSnapshot, type PermissionMode } from '../../src/shared/protocol.js'
import { MODEL_DEFAULTS_STATE, modelDefaults } from './model-defaults-api.js'
import { SESSION_WORKSPACE_STATE } from './session-api.js'

export function defaultWorkspace(harness: HarnessSnapshot | undefined): string {
  const workspace = harness?.extensions[SESSION_WORKSPACE_STATE]
  return typeof workspace === 'string' ? workspace : ''
}

export function configuredDefaults(
  harness: HarnessSnapshot | undefined,
): CodexSessionDefaults | undefined {
  const extension = harness?.extensions['session.defaults']
  let defaults: CodexSessionDefaults | undefined
  if (
    isRecord(extension)
    && typeof extension.permissionMode === 'string'
    && ['ask', 'auto', 'full'].includes(extension.permissionMode)
  ) {
    defaults = {
      permissionMode: extension.permissionMode as PermissionMode,
      ...(typeof extension.model === 'string' ? { model: extension.model } : {}),
      ...(typeof extension.effort === 'string' ? { effort: extension.effort } : {}),
    }
  }
  defaults ??= harness?.codex.defaults
  const saved = modelDefaults(harness?.extensions[MODEL_DEFAULTS_STATE])?.choices.codex
  if (!saved?.model && !saved?.effort) return defaults
  const selected = harness?.codex.models.find((model) => model.id === saved.model)
  const model = saved.model ?? defaults?.model
  const effort = saved.effort ?? (saved.model ? selected?.defaultReasoningEffort : defaults?.effort)
  return {
    permissionMode: defaults?.permissionMode ?? 'ask',
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}
