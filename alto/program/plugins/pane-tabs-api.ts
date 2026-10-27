import type { ComponentType } from 'react'

export interface PaneTab {
  id: string
  title: string
  icon?: ComponentType<{ size?: number; className?: string }>
}

export type PaneTabDropPosition = 'before' | 'after'

export interface PaneTabsProps {
  tabs: readonly PaneTab[]
  activeId: string
  label: string
  createLabel: string
  minimumTabs?: number
  activate(id: string): void
  create(): void
  close(id: string): void
  closeLast?: () => void
  closeLastLabel?: string
  move?(id: string, targetId: string, position: PaneTabDropPosition): void
}

export const PANE_TABS_HOTKEY_ACTIONS = {
  create: 'pane-tabs.create',
} as const

export interface PaneTabsHost {
  active(): boolean
  create(): void
}

export interface PaneTabsHostRegistration {
  dispose(): void
}

export interface ClientPaneTabsService {
  renderer: ComponentType<PaneTabsProps>
  canCreateInActivePane(): boolean
  createInActivePane(): boolean
  registerHost(host: PaneTabsHost): PaneTabsHostRegistration
}

export function movePaneTabs<T extends { id: string }>(
  tabs: readonly T[],
  id: string,
  targetId: string,
  position: PaneTabDropPosition,
): readonly T[] {
  if (id === targetId) return tabs
  const source = tabs.findIndex((tab) => tab.id === id)
  const target = tabs.findIndex((tab) => tab.id === targetId)
  if (source < 0 || target < 0) return tabs
  const next = [...tabs]
  const [tab] = next.splice(source, 1)
  if (!tab) return tabs
  const nextTarget = next.findIndex((candidate) => candidate.id === targetId)
  next.splice(nextTarget + (position === 'after' ? 1 : 0), 0, tab)
  return next
}

declare module 'cordis' {
  interface Context {
    clientPaneTabs: ClientPaneTabsService
  }
}
