import { describe, expect, it } from 'vitest'
import { agentSelection } from '../program/plugins/ui/agent-selection.js'

const providers = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'pi', label: 'Pi' },
  ...['codex', 'claude'].map((agentId) => ({
    id: `cloud-${agentId}`, agentId, label: agentId === 'codex' ? 'Codex' : 'Claude',
    location: { id: 'cloud', label: 'Cloud' },
  })),
]

describe('agent and location selection', () => {
  it('keeps the agent when moving between local and remote execution', () => {
    const local = agentSelection(providers, 'claude')
    const remote = local.locations.find((location) => location.id === 'cloud')!
    expect(remote.provider?.id).toBe('cloud-claude')
    const cloud = agentSelection(providers, remote.provider!.id)
    expect(cloud.label).toBe('Claude')
    expect(cloud.locationLabel).toBe('Cloud')
    expect(cloud.locations.find((location) => location.id === 'local')?.provider?.id).toBe('claude')
  })

  it('only offers agents at the current location', () => {
    expect(agentSelection(providers, 'codex').agents.map((agent) => agent.id)).toEqual(['codex', 'claude', 'pi'])
    expect(agentSelection(providers, 'cloud-codex').agents.map((agent) => agent.id)).toEqual(['cloud-codex', 'cloud-claude'])
  })

  it('does not substitute another agent when a location cannot run the selected one', () => {
    const selection = agentSelection(providers, 'pi')
    expect(selection.locations.map((location) => location.id)).toEqual(['local', 'cloud'])
    expect(selection.locations.find((location) => location.id === 'cloud')?.provider).toBeUndefined()
  })
})
