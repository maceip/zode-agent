import type {
  WorkCheckout,
  WorkContextSnapshot,
  Workstream,
  WorkTarget,
} from './work-contexts-api.js'
import type { JsonValue } from '../../src/shared/protocol.js'

export interface ClientWorkContextsService {
  subscribe(listener: () => void): () => void
  snapshot(): WorkContextSnapshot
  refresh(location?: string): Promise<void>
  workstreamForPath(path: string, projectId?: string): Workstream | undefined
  localCheckoutForPath(path: string, projectId?: string): WorkCheckout | undefined
  targetForThread(threadId: string | undefined): WorkTarget | undefined
  openLocation(checkoutId: string): Promise<void>
  setTarget(threadId: string, checkoutId: string): Promise<void>
  createLocalBranch(
    threadId: string,
    sourceCheckoutId: string,
    branch: string,
    placement: 'checkout' | 'worktree',
    baseRef?: string,
  ): Promise<void>
  createProviderTarget(
    providerId: string,
    threadId: string,
    sourceCheckoutId: string,
    options?: Record<string, JsonValue>,
  ): Promise<void>
  createProviderBranchTarget(
    providerId: string,
    threadId: string,
    sourceCheckoutId: string,
    branch: string,
    baseRef?: string,
    options?: Record<string, JsonValue>,
  ): Promise<void>
}

declare module 'cordis' {
  interface Context {
    clientWorkContexts: ClientWorkContextsService
  }
}
