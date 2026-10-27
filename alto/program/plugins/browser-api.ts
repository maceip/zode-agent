import type { ComponentType } from 'react'

export interface BrowserWorkspace {
  key: string
  name: string
  path: string
  projectId?: string
}

export interface BrowserStartPage {
  id: string
  title: string
  url: string
  icon?: ComponentType<{ size?: number; className?: string }>
  order?: number
  availableIn?: (workspace: Readonly<BrowserWorkspace>) => boolean
}

export interface BrowserStartPageRegistration {
  dispose(): Promise<void>
}

export interface ClientBrowserSnapshot {
  revision: number
  startPages: readonly BrowserStartPage[]
}

export interface ClientBrowserService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientBrowserSnapshot
  registerStartPage(
    owner: import('cordis').Context,
    page: BrowserStartPage,
  ): BrowserStartPageRegistration
}

declare module 'cordis' {
  interface Context {
    clientBrowser: ClientBrowserService
  }
}
