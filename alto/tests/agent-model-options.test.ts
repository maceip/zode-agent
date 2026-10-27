import { describe, expect, it } from 'vitest'
import { draftAgentConfig, initialAgentConfig, legacyAgentConfig, resolveDraftConfigValue } from '../program/plugins/agent-model-options.js'
import type { AgentConfigOption } from '../src/server/services/agent-registry.js'

describe('Claude draft model choices', () => {
  const model = (options: AgentConfigOption['options']): AgentConfigOption => ({
    id: 'model', name: 'Model', category: 'model', currentValue: 'default', options,
  })

  it('offers Opus 5.5 and effort levels without overriding the agent defaults', () => {
    const config = initialAgentConfig('claude')
    expect(config[0]).toMatchObject({ currentValue: 'default', options: expect.arrayContaining([
      { value: 'claude-opus-5-5', name: 'Opus 5.5' },
    ]) })
    expect(config[1]?.currentValue).toBe('default')
    expect(config[1]?.options.map(option => option.value)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(initialAgentConfig('pi')).toEqual([])
  })

  it.each(['opus', 'opus[1m]', 'claude-opus-5-5', 'claude-opus-5-5[1m]'])(
    'resolves an exact Opus 5.5 choice to the advertised %s option', (value) => {
      expect(resolveDraftConfigValue('claude', model([{ value, name: 'Opus 5.5' }]), 'claude-opus-5-5')).toBe(value)
    },
  )

  it.each(['Opus 4.6', 'Opus', 'Opus 5.50', 'Opus 5.5 fast'])(
    'does not infer Opus 5.5 from the ambiguous or different model %s', (name) => {
      expect(resolveDraftConfigValue('claude', model([{ value: 'opus[1m]', name }]), 'claude-opus-5-5')).toBeUndefined()
    },
  )

  it('preserves exact IDs and does not guess between multiple context variants', () => {
    const config = model([{ value: 'opus', name: 'Opus 5.5' }, { value: 'opus[1m]', name: 'Opus 5.5' }])
    expect(resolveDraftConfigValue('claude', config, 'opus')).toBe('opus')
    expect(resolveDraftConfigValue('claude', config, 'claude-opus-5-5')).toBeUndefined()
    expect(resolveDraftConfigValue('pi', model([{ value: 'opus[1m]', name: 'Opus 5.5' }]), 'opus')).toBeUndefined()
    expect(resolveDraftConfigValue('claude', model([{ value: 'opus[1m]', name: 'Opus 5.5' }]), 'opus')).toBe('opus[1m]')
  })

  it('resolves the current adapter catalog from its versioned description without changing the context variant', () => {
    const config = model([
      { value: 'opus', name: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { value: 'opus[1m]', name: 'Opus (1M context)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks' },
    ])
    config.currentValue = 'opus'
    expect(resolveDraftConfigValue('claude', config, 'claude-opus-5-5')).toBe('opus')
    config.currentValue = 'opus[1m]'
    expect(resolveDraftConfigValue('claude', config, 'claude-opus-5-5')).toBe('opus[1m]')
    expect(resolveDraftConfigValue('claude', config, 'claude-opus-5-4')).toBeUndefined()
  })

  it('offers effort when moving from a cached Haiku catalog to Opus, and hides it for Haiku', () => {
    const known = [model([{ value: 'haiku', name: 'Haiku 4.5' }, { value: 'opus[1m]', name: 'Opus 5.5' }])]
    known[0]!.currentValue = 'haiku'
    expect(initialAgentConfig('claude', known)).toEqual(known)
    const config = draftAgentConfig('claude', known, 'opus[1m]')
    expect(config.find(option => option.category === 'thought_level')?.options.map(option => option.value)).toContain('max')
    expect(draftAgentConfig('claude', initialAgentConfig('claude'), 'haiku').some(option => option.category === 'thought_level')).toBe(false)
    expect(known).toHaveLength(1)
  })
})

describe('Gemini draft model choices', () => {
  it('offers explicit Argon and CLI model choices without inventing reasoning settings', () => {
    const config = initialAgentConfig('gemini')
    expect(config).toHaveLength(1)
    expect(config[0]).toMatchObject({ id: '__model', category: 'model', currentValue: 'default' })
    expect(config[0]?.options.map(option => option.value)).toEqual([
      'default', 'gemini-4-argon', 'auto', 'gemini-3.1-pro-preview', 'gemini-3-pro-preview',
      'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-3.8-flash',
      'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite',
    ])
    expect(draftAgentConfig('gemini', config, 'gemini-4-argon')).toEqual(config)
    expect(resolveDraftConfigValue('gemini', config[0]!, 'gemini-4-argon')).toBe('gemini-4-argon')
    expect(resolveDraftConfigValue('gemini', config[0]!, 'unknown')).toBeUndefined()
    config[0]!.options[1]!.name = 'Changed'
    expect(initialAgentConfig('gemini')[0]?.options[1]?.name).toBe('Gemini 4 Argon')
  })

  it('extends only a legacy Gemini catalog and retains the agent-provided labels', () => {
    const config: AgentConfigOption[] = [{ id: '__model', name: 'Model', category: 'model', currentValue: 'auto', options: [
      { value: 'auto', name: 'Automatic selection', description: 'Agent-provided description' },
    ] }]
    const extended = legacyAgentConfig('gemini', config)
    expect(extended[0]?.options[0]).toEqual({ value: 'auto', name: 'Automatic selection', description: 'Agent-provided description' })
    expect(extended[0]?.options).toContainEqual({ value: 'gemini-4-argon', name: 'Gemini 4 Argon' })
    expect(extended[0]?.options.some(option => option.value === 'default')).toBe(false)
    const count = extended[0]!.options.length
    expect(legacyAgentConfig('gemini', extended)[0]?.options).toHaveLength(count)
    expect(legacyAgentConfig('pi', [])).toEqual([])
    expect(legacyAgentConfig('gemini', [])).toEqual([])
  })
})

describe('learned agent catalogs', () => {
  it.each(['claude', 'gemini', 'pi'])('keeps an empty learned %s catalog authoritative', agentId => {
    expect(initialAgentConfig(agentId, [])).toEqual([])
  })

  it('preserves learned non-model options instead of adding a fallback catalog', () => {
    const config: AgentConfigOption[] = [{ id: 'mode', name: 'Mode', category: 'mode', currentValue: 'a',
      options: [{ value: 'a', name: 'A' }] }]
    const learned = initialAgentConfig('gemini', config)
    expect(learned).toEqual(config)
    learned[0]!.currentValue = 'changed'
    expect(config[0]?.currentValue).toBe('a')
  })
})
