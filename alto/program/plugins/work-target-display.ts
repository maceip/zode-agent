import type { ClientSessionSnapshot } from './session-api.js'
import type { WorkCheckout, WorkProviderDescriptor } from './work-contexts-api.js'

export interface WorkTargetDisplay {
  local: boolean
  label: string
  location: string
  branch?: string
  url?: string
  checkoutId?: string
  statusTone?: WorkCheckout['statusTone']
}

function webUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

export function workTargetDisplay(
  session: Pick<ClientSessionSnapshot, 'remoteLocation' | 'remoteWorkspaceName' | 'remoteWorkspace' | 'providerId' | 'providers'>,
  target: WorkCheckout | undefined,
  checkouts: readonly WorkCheckout[],
  providers: readonly WorkProviderDescriptor[],
): WorkTargetDisplay | undefined {
  if (session.remoteLocation) {
    const workspace = session.remoteWorkspace
    const name = workspace?.name ?? session.remoteWorkspaceName
    const provider = session.providers?.find((candidate) => candidate.id === session.providerId)?.location
    const remote = name && provider ? [target, ...checkouts].find((checkout) => (
      checkout?.kind === provider.id && checkout.kind !== 'local' && checkout.location === name
    )) : undefined
    const branch = workspace?.branch ?? remote?.branch
    const url = webUrl(workspace?.url) ?? webUrl(remote?.url)
    return {
      local: false,
      label: session.remoteLocation,
      location: name ?? session.remoteLocation,
      ...(branch ? { branch } : {}),
      ...(url ? { url } : {}),
      ...(remote?.statusTone ? { statusTone: remote.statusTone } : {}),
    }
  }
  if (!target) return undefined
  const local = target.kind === 'local'
  const url = local ? undefined : webUrl(target.url)
  return {
    local,
    label: local ? 'Local' : providers.find((provider) => provider.id === target.kind)?.label ?? target.kind,
    location: target.location,
    branch: target.branch,
    ...(local ? { checkoutId: target.id } : {}),
    ...(url ? { url } : {}),
    ...(target.statusTone ? { statusTone: target.statusTone } : {}),
  }
}
