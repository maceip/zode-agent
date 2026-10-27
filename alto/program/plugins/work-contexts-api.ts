import type { Context } from 'cordis'
import type { JsonValue } from '../../src/shared/protocol.js'

export type WorkCheckoutKind = string
export type LocalBranchPlacement = 'checkout' | 'worktree'

export interface WorkCheckout {
  id: string
  kind: WorkCheckoutKind
  projectId: string
  branch: string
  label: string
  location: string
  repository?: string
  head?: string
  dirty?: boolean
  primary?: boolean
  status?: string
  statusTone?: 'neutral' | 'progress' | 'success' | 'warning' | 'danger'
  message?: string
  url?: string
  lastUsedAt?: string
}

export interface Workstream {
  id: string
  projectId: string
  name: string
  branch: string
  repository?: string
  checkouts: WorkCheckout[]
}

export interface WorkTarget extends WorkCheckout {
  checkoutId: string
  updatedAt: string
}

export interface WorkContextSnapshot {
  version: 1
  revision: number
  workstreams: Workstream[]
  providers: WorkProviderDescriptor[]
  threadTargets: Record<string, WorkTarget>
  updatedAt: string
  problem?: string
}

export interface WorkContextSourceSnapshot {
  checkouts: WorkCheckout[]
}

export interface WorkContextSourceRegistration {
  update(snapshot: WorkContextSourceSnapshot): void
  dispose(): Promise<void>
}

export interface WorkProviderDescriptor {
  id: string
  label: string
  description?: string
  supportsExistingTarget: boolean
  supportsBranchTarget: boolean
}

export interface WorkProviderTargetInput {
  threadId: string
  source: WorkCheckout
  options?: Record<string, JsonValue>
}

export interface WorkProviderBranchInput extends WorkProviderTargetInput {
  branch: string
  baseRef?: string
}

export interface WorkProvider {
  id: string
  label: string
  description?: string
  createTarget?(input: WorkProviderTargetInput): Promise<WorkCheckout>
  createBranchTarget?(input: WorkProviderBranchInput): Promise<WorkCheckout>
}

export interface WorkProviderRegistration extends WorkContextSourceRegistration {}

export interface WorkContextRegistryService {
  snapshot(): WorkContextSnapshot
  refresh(): Promise<WorkContextSnapshot>
  registerSource(
    owner: Context,
    id: string,
    snapshot: WorkContextSourceSnapshot,
  ): WorkContextSourceRegistration
  registerProvider(
    owner: Context,
    provider: WorkProvider,
    snapshot?: WorkContextSourceSnapshot,
  ): WorkProviderRegistration
  createProviderTarget(
    providerId: string,
    threadId: string,
    sourceCheckoutId: string,
    options?: Record<string, JsonValue>,
  ): Promise<WorkCheckout>
  createProviderBranchTarget(
    providerId: string,
    threadId: string,
    sourceCheckoutId: string,
    branch: string,
    baseRef?: string,
    options?: Record<string, JsonValue>,
  ): Promise<WorkCheckout>
  createLocalBranch(
    sourceCheckoutId: string,
    branch: string,
    placement: LocalBranchPlacement,
    baseRef?: string,
  ): Promise<WorkCheckout>
  createLocalWorktree(
    sourceCheckoutId: string,
    branch: string,
    baseRef?: string,
  ): Promise<WorkCheckout>
  checkout(id: string): WorkCheckout | undefined
  localCheckoutForPath(path: string): WorkCheckout | undefined
  targetForThread(threadId: string): WorkTarget | undefined
  setThreadTarget(threadId: string, checkout: WorkCheckout | undefined): Promise<void>
}

declare module 'cordis' {
  interface Context {
    workContexts: WorkContextRegistryService
  }
}
