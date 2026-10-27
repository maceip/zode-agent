import type { ComponentType } from 'react'

export interface CodeExplorerProps {
  workspace: string
  /** When present, constrain the tree to this set (for example, changed files). */
  paths?: readonly string[]
  activePath?: string
  label: string
  select(path: string): void
}

export interface CodeExplorerContribution {
  id: string
  component: ComponentType<CodeExplorerProps>
  priority?: number
}

export interface ClientCodeExplorerSnapshot {
  revision: number
  explorer?: CodeExplorerContribution
}

export interface CodeExplorerRegistration {
  dispose(): Promise<void>
}

export interface ClientCodeExplorerService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientCodeExplorerSnapshot
  register(
    owner: import('cordis').Context,
    contribution: CodeExplorerContribution,
  ): CodeExplorerRegistration
}

declare module 'cordis' {
  interface Context {
    clientCodeExplorer: ClientCodeExplorerService
  }
}
