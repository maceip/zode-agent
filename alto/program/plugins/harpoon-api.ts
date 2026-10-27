import type { ThreadSummary } from '../../src/shared/protocol.js'

export interface HarpoonSlot {
  index: number
  threadId?: string
  thread?: ThreadSummary
  active: boolean
}

export interface ClientHarpoonSnapshot {
  revision: number
  slots: readonly HarpoonSlot[]
  candidates: readonly ThreadSummary[]
  selectedThreadId?: string
  activeThreadId?: string
}

export interface ClientHarpoonService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientHarpoonSnapshot
  open(): void
  toggleCurrentTag(): void
  toggleTag(threadId: string): void
  removeSlot(index: number): void
  openSlot(index: number): void
  selectThread(threadId: string): void
  moveSelection(direction: 1 | -1): void
  selectBoundary(boundary: 'first' | 'last'): void
  toggleSelected(): void
  assignSelectedSlot(index: number): void
  openSelected(): void
}

declare module 'cordis' {
  interface Context {
    clientHarpoon: ClientHarpoonService
  }
}
