import type { BrowserPlugin, ClientHostService } from '../../src/client/plugin-api.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import type {
  WorkCheckout,
  WorkContextSnapshot,
  WorkProviderDescriptor,
  Workstream,
  WorkTarget,
} from './work-contexts-api.js'
import type { ClientWorkContextsService } from './work-contexts-client-api.js'

const EMPTY: WorkContextSnapshot = {
  version: 1,
  revision: 0,
  workstreams: [],
  providers: [],
  threadTargets: {},
  updatedAt: new Date(0).toISOString(),
}

function checkout(value: unknown): WorkCheckout | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.kind !== 'string'
    || !/^[a-z][a-z0-9-]*$/iu.test(value.kind)
    || typeof value.projectId !== 'string'
    || typeof value.branch !== 'string'
    || typeof value.label !== 'string'
    || typeof value.location !== 'string'
  ) return undefined
  return value as unknown as WorkCheckout
}

function provider(value: unknown): WorkProviderDescriptor | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !/^[a-z][a-z0-9-]*$/iu.test(value.id)
    || typeof value.label !== 'string'
    || !value.label.trim()
    || typeof value.supportsExistingTarget !== 'boolean'
    || typeof value.supportsBranchTarget !== 'boolean'
  ) return undefined
  return value as unknown as WorkProviderDescriptor
}

function workstream(value: unknown): Workstream | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.projectId !== 'string'
    || typeof value.name !== 'string'
    || typeof value.branch !== 'string'
    || !Array.isArray(value.checkouts)
  ) return undefined
  const checkouts = value.checkouts.map(checkout)
  if (checkouts.some((candidate) => !candidate)) return undefined
  return { ...value, checkouts } as unknown as Workstream
}

function target(value: unknown): WorkTarget | undefined {
  const parsed = checkout(value)
  if (
    !parsed
    || !isRecord(value)
    || typeof value.checkoutId !== 'string'
    || typeof value.updatedAt !== 'string'
  ) return undefined
  return { ...parsed, checkoutId: value.checkoutId, updatedAt: value.updatedAt }
}

export function parseWorkContextSnapshot(value: unknown): WorkContextSnapshot {
  if (
    !isRecord(value)
    || value.version !== 1
    || typeof value.revision !== 'number'
    || typeof value.updatedAt !== 'string'
    || !Array.isArray(value.workstreams)
  ) return EMPTY
  const workstreams = value.workstreams.map(workstream)
  if (workstreams.some((candidate) => !candidate)) return EMPTY
  const providers = Array.isArray(value.providers) ? value.providers.map(provider) : []
  if (providers.some((candidate) => !candidate)) return EMPTY
  const threadTargets = isRecord(value.threadTargets)
    ? Object.fromEntries(Object.entries(value.threadTargets).flatMap(([threadId, candidate]) => {
        const parsed = target(candidate)
        return parsed ? [[threadId, parsed]] : []
      }))
    : {}
  return {
    version: 1,
    revision: value.revision,
    workstreams: workstreams as Workstream[],
    providers: providers as WorkProviderDescriptor[],
    threadTargets,
    updatedAt: value.updatedAt,
    ...(typeof value.problem === 'string' ? { problem: value.problem } : {}),
  }
}

function normalized(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/u, '')
}

function contains(root: string, candidate: string): boolean {
  const left = normalized(root)
  const right = normalized(candidate)
  return right === left || right.startsWith(`${left}/`)
}

export class ClientWorkContexts implements ClientWorkContextsService {
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private current = EMPTY

  constructor(private readonly host: ClientHostService) {
    this.read()
    this.unsubscribe = host.subscribe(() => this.read())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): WorkContextSnapshot => this.current

  async refresh(location?: string): Promise<void> {
    await this.host.call('work-contexts.refresh', location ? { location } : undefined)
  }

  workstreamForPath(candidate: string, projectId?: string): Workstream | undefined {
    const checkout = this.localCheckoutForPath(candidate, projectId)
    return checkout
      ? this.current.workstreams.find((stream) => stream.checkouts.some((item) => item.id === checkout.id))
      : this.current.workstreams.find((stream) => stream.projectId === projectId)
  }

  localCheckoutForPath(candidate: string, projectId?: string): WorkCheckout | undefined {
    return this.current.workstreams
      .filter((stream) => !projectId || stream.projectId === projectId)
      .flatMap((stream) => stream.checkouts)
      .filter((item) => item.kind === 'local' && contains(item.location, candidate))
      .toSorted((left, right) => right.location.length - left.location.length)[0]
  }

  targetForThread(threadId: string | undefined): WorkTarget | undefined {
    return threadId ? this.current.threadTargets[threadId] : undefined
  }

  async openLocation(checkoutId: string): Promise<void> {
    await this.host.call('work-contexts.open-location', { checkoutId })
  }

  async setTarget(threadId: string, checkoutId: string): Promise<void> {
    await this.host.call('work-contexts.set-target', { threadId, checkoutId })
  }

  async createLocalBranch(
    threadId: string,
    sourceCheckoutId: string,
    branch: string,
    placement: 'checkout' | 'worktree',
    baseRef?: string,
  ): Promise<void> {
    await this.host.call('work-contexts.create-branch', {
      threadId,
      sourceCheckoutId,
      branch,
      placement,
      ...(baseRef ? { baseRef } : {}),
    })
  }

  async createProviderTarget(
    providerId: string,
    threadId: string,
    sourceCheckoutId: string,
    options?: Record<string, JsonValue>,
  ): Promise<void> {
    await this.host.call('work-contexts.create-provider-target', {
      providerId,
      threadId,
      sourceCheckoutId,
      ...(options ? { options } : {}),
    })
  }

  async createProviderBranchTarget(
    providerId: string,
    threadId: string,
    sourceCheckoutId: string,
    branch: string,
    baseRef?: string,
    options?: Record<string, JsonValue>,
  ): Promise<void> {
    await this.host.call('work-contexts.create-provider-branch-target', {
      providerId,
      threadId,
      sourceCheckoutId,
      branch,
      ...(baseRef ? { baseRef } : {}),
      ...(options ? { options } : {}),
    })
  }

  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  private read(): void {
    const value = this.host.snapshot().snapshot?.extensions['work-contexts.state']
    const next = parseWorkContextSnapshot(value)
    if (next.revision === this.current.revision && next === this.current) return
    if (next.revision === this.current.revision && JSON.stringify(next) === JSON.stringify(this.current)) return
    this.current = next
    for (const listener of this.listeners) listener()
  }
}

const workContexts: BrowserPlugin = (ctx) => {
  const service = new ClientWorkContexts(ctx.clientHost)
  ctx.provide('clientWorkContexts', service)
  ctx.effect(() => () => service.dispose(), 'clientWorkContexts.lifecycle')
}

workContexts.inject = ['clientHost']
workContexts.provide = 'clientWorkContexts'

export default workContexts
