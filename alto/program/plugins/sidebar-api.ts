import type { ComponentType } from 'react'

export type ClientSidebarMode = 'hidden' | 'floating' | 'pinned'

export interface ClientSidebarSnapshot {
  revision: number
  mode: ClientSidebarMode
  collapsed: boolean
  pinned: boolean
  workspaceKey: string
}

export interface ClientSidebarAction {
  id: string
  order?: number
  renderer: ComponentType
}

export interface ClientSidebarActionRegistration {
  dispose(): Promise<void>
}

export interface ClientSidebarService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientSidebarSnapshot
  toggle(): void
  setCollapsed(collapsed: boolean): void
  setPinned(pinned: boolean): void
  actions(): readonly ClientSidebarAction[]
  registerAction(
    owner: import('cordis').Context,
    action: ClientSidebarAction,
  ): ClientSidebarActionRegistration
}

declare module 'cordis' {
  interface Context {
    clientSidebar: ClientSidebarService
  }
}
