import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ClientHostService } from '../../../src/client/plugin-api.js'
import type { AgentConfigOption, AgentProviderSnapshot } from '../../../src/server/services/agent-registry.js'
import { isRecord, type HarnessSnapshot } from '../../../src/shared/protocol.js'
import { AGENT_CHATS_STATE, type AgentChatCatalog } from '../agent-chats-api.js'
import { draftAgentConfig, initialAgentConfig, resolveDraftConfigValue } from '../agent-model-options.js'
import {
  MODEL_DEFAULTS_DISCOVER,
  MODEL_DEFAULTS_SET,
  MODEL_DEFAULTS_STATE,
  modelDefaults,
  type ModelDefaultsChoice,
} from '../model-defaults-api.js'
import type { ClientSessionSnapshot } from '../session-api.js'
import { SettingsRow } from './settings.js'

type DefaultsProvider = Pick<AgentProviderSnapshot,
  'id' | 'label' | 'agentId' | 'location' | 'remoteLocation' | 'protocol' | 'configOptions'>
type Choice = AgentConfigOption['options'][number]

export function defaultModelProviders(snapshot: HarnessSnapshot | undefined): DefaultsProvider[] {
  const catalog = snapshot?.extensions[AGENT_CHATS_STATE]
  const providers = isRecord(catalog) && Array.isArray(catalog.providers)
    ? (catalog as unknown as AgentChatCatalog).providers : []
  return [{ id: 'codex', label: 'Codex', agentId: 'codex', protocol: 'codex-app-server',
    location: { id: 'local', label: 'Local' } }, ...providers.filter((provider) => provider.id !== 'codex')]
}

export function defaultsProviderLabel(provider: DefaultsProvider): string {
  const location = provider.location?.label ?? provider.remoteLocation
    ?? (provider.protocol === 'remote' ? 'Remote' : 'Local')
  return `${provider.label} · ${location}`
}

export function defaultsModelChoices(
  provider: DefaultsProvider | undefined,
  snapshot: HarnessSnapshot | undefined,
  choice: ModelDefaultsChoice | undefined,
  discovered?: AgentConfigOption[],
): { models: Choice[]; efforts: Choice[] } {
  if (!provider) return { models: [], efforts: [] }
  if (provider.id === 'codex' || provider.agentId === 'codex') {
    const models = snapshot?.codex.models ?? []
    const selected = choice?.model
      ? models.find((model) => model.id === choice.model)
      : models.find((model) => model.isDefault) ?? models[0]
    return {
      models: models.map((model) => ({ value: model.id, name: model.displayName })),
      efforts: (selected?.supportedReasoningEfforts ?? []).map((effort) => ({
        value: effort.reasoningEffort, name: effort.reasoningEffort,
        ...(effort.description ? { description: effort.description } : {}),
      })),
    }
  }
  const agentId = provider.agentId ?? provider.id
  const initial = initialAgentConfig(agentId, discovered ?? provider.configOptions)
  const model = initial.find((option) => option.category === 'model')
  const resolved = model && choice?.model ? resolveDraftConfigValue(agentId, model, choice.model) : undefined
  const config = draftAgentConfig(agentId, initial, resolved ?? choice?.model)
  const models = config.find((option) => option.category === 'model')?.options ?? []
  if (choice?.model && resolved && resolved !== choice.model) {
    const alias = models.find((option) => option.value === resolved)
    if (alias) models.push({ value: choice.model, name: alias.description?.split(' · ')[0] ?? alias.name })
  }
  return {
    models,
    efforts: config.find((option) => option.category === 'thought_level')?.options ?? [],
  }
}

export function currentSessionModelSummary(state: ClientSessionSnapshot): { model: string; effort: string } {
  const providerId = state.providerId ?? 'codex'
  const label = state.providers?.find((provider) => provider.id === providerId)?.label
    ?? (providerId === 'codex' ? 'Codex' : providerId)
  const models = state.models ?? (providerId === 'codex' ? state.harness?.codex.models : undefined) ?? []
  const selected = state.session.model
    ? models.find((model) => model.id === state.session.model)
    : models.find((model) => model.isDefault) ?? models[0]
  return {
    model: selected?.displayName ?? state.session.model ?? `${label} default`,
    effort: state.session.effort ?? selected?.defaultReasoningEffort ?? 'Agent default',
  }
}

function localDiscovery(provider: DefaultsProvider | undefined): boolean {
  return provider?.protocol === 'acp' && !provider.remoteLocation
    && (!provider.location || provider.location.id === 'local')
}

function savedChoice(value: string | undefined, choices: Choice[]): boolean {
  return value !== undefined && !choices.some((choice) => choice.value === value)
}

function defaultAlias(choice: Choice): boolean {
  return choice.value === 'default' && choice.name === 'Agent default'
}

function selectedChoice(value: string | undefined, choices: Choice[]): string {
  return choices.some((choice) => choice.value === value && defaultAlias(choice)) ? '' : value ?? ''
}

function ChoiceOptions({ choices, value }: { choices: Choice[]; value: string | undefined }): ReactNode {
  return <>
    <option value="">Agent default</option>
    {savedChoice(value, choices) && <option value={value} disabled>{value} (saved; unavailable)</option>}
    {choices.filter((choice) => !defaultAlias(choice)).map((choice) => <option value={choice.value} key={choice.value}>{choice.name}</option>)}
  </>
}

function SelectShell({ children }: { children: ReactNode }): ReactNode {
  return <span className="model-defaults-select">
    {children}
    <ChevronDown size={14} strokeWidth={1.7} aria-hidden="true" />
  </span>
}

export function ModelDefaultsSettings({ host, workspace }: {
  host: ClientHostService
  workspace: string
}): ReactNode {
  const hostState = useSyncExternalStore(host.subscribe, host.snapshot, host.snapshot)
  const snapshot = hostState.snapshot
  const preferences = modelDefaults(snapshot?.extensions[MODEL_DEFAULTS_STATE])
  const providerId = preferences?.providerId ?? 'codex'
  const providers = defaultModelProviders(snapshot)
  const provider = providers.find((candidate) => candidate.id === providerId)
  const choice = preferences?.choices[providerId]
  const [discovered, setDiscovered] = useState<Record<string, AgentConfigOption[]>>({})
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [problem, setProblem] = useState<string>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const { models, efforts } = defaultsModelChoices(provider, snapshot, choice, discovered[providerId])
  const ready = hostState.connected && preferences !== undefined
  const busy = saving || refreshing
  const staleModel = savedChoice(choice?.model, models)
  const staleEffort = savedChoice(choice?.effort, efforts)

  async function save(change: { providerId: string; model?: string | null; effort?: string | null }): Promise<void> {
    setProblem(undefined)
    setSaving(true)
    try {
      await host.call(MODEL_DEFAULTS_SET, change)
    } catch (error) {
      if (mounted.current) setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  async function discover(): Promise<void> {
    if (!localDiscovery(provider)) return
    setProblem(undefined)
    setRefreshing(true)
    try {
      const result = await host.call(MODEL_DEFAULTS_DISCOVER, {
        providerId, cwd: workspace || snapshot?.server.projectRoot || '',
      })
      if (mounted.current && isRecord(result) && Array.isArray(result.configOptions)) {
        setDiscovered((previous) => ({ ...previous, [providerId]: result.configOptions as unknown as AgentConfigOption[] }))
      }
    } catch (error) {
      if (mounted.current) setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }

  function selectModel(value: string): void {
    const nextChoice = { ...choice }
    if (value) nextChoice.model = value
    else delete nextChoice.model
    const nextEfforts = defaultsModelChoices(provider, snapshot, nextChoice, discovered[providerId]).efforts
    const clearEffort = choice?.effort !== undefined
      && !nextEfforts.some((effort) => effort.value === choice.effort)
    void save({ providerId, model: value || null, ...(clearEffort ? { effort: null } : {}) })
  }

  return <div className="settings-page model-defaults-settings">
    <section className="settings-section">
      <h2>New chat defaults</h2>
      <p className="model-defaults-description">Choose the agent, model, and reasoning for new chats. Each agent remembers its own choices.</p>
      <div className="settings-card">
        <SettingsRow as="label" label="Default agent" description="Enabled agents and their locations">
          <SelectShell>
            <select aria-label="Default agent" value={providerId} disabled={!ready || busy}
              onChange={(event) => void save({ providerId: event.target.value })}>
              {!provider && <option value={providerId} disabled>{providerId} (saved; unavailable)</option>}
              {providers.map((candidate) => <option value={candidate.id} key={candidate.id}>{defaultsProviderLabel(candidate)}</option>)}
            </select>
          </SelectShell>
        </SettingsRow>
        <SettingsRow as="label" label="Default model" description="Use the agent default or select a model">
          <SelectShell>
            <select aria-label="Default model" value={selectedChoice(choice?.model, models)} disabled={!ready || busy || !provider || (!models.length && !choice?.model)}
              onChange={(event) => selectModel(event.target.value)}>
              <ChoiceOptions choices={models} value={choice?.model} />
            </select>
          </SelectShell>
        </SettingsRow>
        <SettingsRow as="label" label="Reasoning effort"
          description={efforts.length ? 'Available reasoning levels for this model' : 'This agent uses its default reasoning'}>
          <SelectShell>
            <select aria-label="Default reasoning effort" value={efforts.length ? selectedChoice(choice?.effort, efforts) : ''}
              disabled={!ready || busy || !provider || !efforts.length}
              onChange={(event) => void save({ providerId, effort: event.target.value || null })}>
              <ChoiceOptions choices={efforts} value={efforts.length ? choice?.effort : undefined} />
            </select>
          </SelectShell>
        </SettingsRow>
        {localDiscovery(provider) && <SettingsRow label="Available models" description="Load choices from the local agent without sending a message">
          <button className="model-defaults-load" type="button" disabled={!ready || busy} onClick={() => void discover()}>
            {refreshing ? 'Loading…' : discovered[providerId] ? 'Refresh models' : 'Load models'}
          </button>
        </SettingsRow>}
      </div>
      {(!provider || staleModel) && <p className="model-defaults-note">The saved {provider ? 'model' : 'agent'} is currently unavailable. Choose an available option before starting a new chat.</p>}
      {staleEffort && <p className="model-defaults-note">Saved reasoning “{choice?.effort}” is unavailable for this model.
        {' '}<button type="button" disabled={!ready || busy || !provider} onClick={() => void save({ providerId, effort: null })}>Use agent default</button>
      </p>}
      <div className="model-defaults-status" role="status" aria-live="polite">
        {problem ? <span className="model-defaults-error">{problem}</span>
          : !preferences ? 'Loading defaults…'
            : !hostState.connected ? 'Connect to Alto to change defaults.'
              : saving ? 'Saving…' : ''}
      </div>
    </section>
  </div>
}
