import type { ClientSessionSnapshot } from '../session-api.js'

type Provider = NonNullable<ClientSessionSnapshot['providers']>[number]

export function agentSelection(providers: readonly Provider[], providerId: string) {
  const selected = providers.find((provider) => provider.id === providerId)
  const agentId = selected?.agentId ?? providerId
  const locationId = selected?.location?.id ?? 'local'
  const locations = [...new Map(providers.map((provider) => {
    const location = provider.location ?? { id: 'local', label: 'Local' }
    return [location.id, location] as const
  })).values()].map((location) => ({
    ...location,
    provider: providers.find((provider) => (provider.location?.id ?? 'local') === location.id
      && (provider.agentId ?? provider.id) === agentId),
  }))
  return {
    label: selected?.label ?? 'Codex',
    locationId,
    locationLabel: selected?.location?.label ?? 'Local',
    locations,
    agents: providers.filter((provider) => (provider.location?.id ?? 'local') === locationId),
  }
}
