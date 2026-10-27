import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ClientHostService } from '../src/client/plugin-api.js'
import type { HarnessSnapshot } from '../src/shared/protocol.js'
import type { ClientSessionSnapshot } from '../program/plugins/session-api.js'
import {
  currentSessionModelSummary,
  defaultModelProviders,
  defaultsModelChoices,
  defaultsProviderLabel,
  ModelDefaultsSettings,
} from '../program/plugins/ui/model-defaults.js'

const require = createRequire(import.meta.url)
const snapshot = {
  codex: { models: [{ id: 'codex-global', displayName: 'Codex global', isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] },
  extensions: {
    'model-defaults': { providerId: 'gemini', choices: { gemini: { model: 'gemini-4-argon' } } },
    'agent-chats': { providers: [
      { id: 'claude', agentId: 'claude', label: 'Claude', protocol: 'acp', location: { id: 'local', label: 'Local' } },
      { id: 'gemini', agentId: 'gemini', label: 'Gemini', protocol: 'acp', location: { id: 'local', label: 'Local' } },
      { id: 'pi', agentId: 'pi', label: 'Pi', protocol: 'acp', location: { id: 'local', label: 'Local' } },
      { id: 'cloud-gemini', agentId: 'gemini', label: 'Gemini', protocol: 'remote', location: { id: 'cloud', label: 'Cloud' } },
    ], threads: [] },
  },
} as unknown as HarnessSnapshot

describe('model defaults settings', () => {
  it('lists enabled agents with their locations from the global host catalog', () => {
    const providers = defaultModelProviders(snapshot)
    expect(providers.map((provider) => provider.id)).toEqual(['codex', 'claude', 'gemini', 'pi', 'cloud-gemini'])
    expect(providers.map(defaultsProviderLabel)).toEqual(['Codex · Local', 'Claude · Local', 'Gemini · Local', 'Pi · Local', 'Gemini · Cloud'])
  })

  it('limits Claude reasoning to the chosen model and respects explicit catalogs', () => {
    const claude = defaultModelProviders(snapshot).find((provider) => provider.id === 'claude')!
    expect(defaultsModelChoices(claude, snapshot, { model: 'haiku' }).efforts).toEqual([])
    expect(defaultsModelChoices(claude, snapshot, { model: 'opus' }).efforts.map((effort) => effort.value)).toContain('max')
    expect(defaultsModelChoices(claude, snapshot, { model: 'sonnet' }).efforts.map((effort) => effort.value)).not.toContain('max')
    const native = [{ id: 'model', name: 'Model', category: 'model', currentValue: 'native', options: [{ value: 'native', name: 'Native model' }] }]
    expect(defaultsModelChoices(claude, snapshot, {}, native).models).toEqual(native[0]!.options)
  })

  it('uses the shared native Codex catalog for remote Codex models and model-specific reasoning', () => {
    const advertised = [{ id: 'model', name: 'Model', category: 'model', currentValue: 'remote-only',
      options: [{ value: 'remote-only', name: 'Remote cached model' }] }]
    const remote = { id: 'cloud-codex', agentId: 'codex', label: 'Codex', protocol: 'remote' as const,
      location: { id: 'cloud', label: 'Cloud' }, configOptions: advertised }
    const native = { ...snapshot, codex: { ...snapshot.codex, models: [...snapshot.codex.models,
      { id: 'codex-fast', displayName: 'Codex fast', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    ] } }
    expect(defaultsModelChoices(remote, native, undefined, advertised)).toEqual({
      models: [{ value: 'codex-global', name: 'Codex global' }, { value: 'codex-fast', name: 'Codex fast' }],
      efforts: [{ value: 'high', name: 'high' }],
    })
    expect(defaultsModelChoices(remote, native, { model: 'codex-fast', effort: 'high' }).efforts)
      .toEqual([{ value: 'low', name: 'low' }])
    expect(defaultsModelChoices(remote, native, { model: 'retired-codex-model' }).efforts).toEqual([])
  })

  it('summarizes the active provider without borrowing another provider’s Codex models', () => {
    const active = { providerId: 'gemini', providers: [{ id: 'gemini', label: 'Gemini' }],
      models: [{ id: 'gemini-4-argon', displayName: 'Gemini 4 Argon' }],
      session: { model: 'gemini-4-argon' }, harness: snapshot,
    } as unknown as ClientSessionSnapshot
    expect(currentSessionModelSummary(active)).toEqual({ model: 'Gemini 4 Argon', effort: 'Agent default' })
    expect(currentSessionModelSummary({ ...active, models: [], session: { workspace: '', permissionMode: 'ask' } }))
      .toEqual({ model: 'Gemini default', effort: 'Agent default' })
  })

  it('keeps a supported saved Claude version visible when the adapter advertises a family alias', () => {
    const claude = defaultModelProviders(snapshot).find((provider) => provider.id === 'claude')!
    const native = [
      { id: 'model', name: 'Model', category: 'model', currentValue: 'opus', options: [
        { value: 'opus', name: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      ] },
      { id: 'effort', name: 'Reasoning', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
    ]
    const choice = { model: 'claude-opus-5-5', effort: 'high' }
    const choices = defaultsModelChoices(claude, snapshot, choice, native)
    expect(choices.models).toContainEqual({ value: 'claude-opus-5-5', name: 'Opus 5.5' })
    expect(choices.efforts).toEqual(native[1]!.options)
    expect(choice.model).toBe('claude-opus-5-5')
    expect(native[0]!.options).toHaveLength(1)
    expect(defaultsModelChoices(claude, snapshot, { model: 'claude-opus-5-4' }, native).models)
      .not.toContainEqual(expect.objectContaining({ value: 'claude-opus-5-4' }))
  })

  it('shows persisted choices without starting discovery or configuring a chat at mount', () => {
    const call = vi.fn()
    const state = { connected: true, snapshot }
    const host = { call, subscribe: () => () => undefined, snapshot: () => state } as unknown as ClientHostService
    const markup = renderToStaticMarkup(<ModelDefaultsSettings host={host} workspace="/tmp/project" />)
    expect(markup).toContain('Gemini · Local')
    expect(markup).toContain('gemini-4-argon')
    expect(markup).toContain('Default reasoning effort')
    expect(markup).toContain('Agent default')
    expect(call).not.toHaveBeenCalled()
  })
})

it.skipIf(process.platform !== 'darwin')('chooses and remembers any-agent defaults without changing active chats or provisioning remote agents', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron') as string, [
    path.resolve('tests/fixtures/model-defaults.cjs'),
  ], { cwd: process.cwd(), env, timeout: 40_000, maxBuffer: 2 * 1024 * 1024 })
  expect(stdout).toContain('Any-agent settings checks passed')
}, 45_000)
