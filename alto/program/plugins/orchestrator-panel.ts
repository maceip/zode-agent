import type { AgentTask } from './orchestrator-api.js'
import type { ClientOverlays } from '../../src/client/plugin-api.js'

export const AGENTS_PIN_KEY = 'alto.agents.pinned'
export const AGENTS_TOGGLE_ACTION = 'panel.agents.toggle'
export type AgentsPanelMode = 'hidden' | 'floating' | 'pinned'
export interface AgentsPanelSnapshot { mode: AgentsPanelMode; open: boolean; pinned: boolean; focusOnOpen: boolean; inspect?: AgentTask; inspectRevision?: number }
export interface PanelPreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export class AgentsPanelController {
  private inspectRevision = 0
  private state: AgentsPanelSnapshot
  private listeners = new Set<() => void>()
  constructor(private readonly overlays: ClientOverlays, private readonly overlayId: string, private readonly storage?: PanelPreferenceStorage) {
    let pinned = false
    try { pinned = storage?.getItem(AGENTS_PIN_KEY) === 'true' } catch {}
    this.state = { mode: pinned ? 'pinned' : 'hidden', open: pinned, pinned, focusOnOpen: false }
  }
  snapshot = (): AgentsPanelSnapshot => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  // Like the sidebar button: a click pins; the keyboard shortcut only reveals.
  toggle = (): void => { this.transition(this.state.pinned ? 'hidden' : 'pinned') }
  toggleTemporary = (): void => { this.transition(this.state.open ? 'hidden' : 'floating', true) }
  inspect = (task: AgentTask): void => {
    if (!this.state.open) this.transition('floating', true)
    this.state = { ...this.state, inspect: task, inspectRevision: ++this.inspectRevision, focusOnOpen: true }
    for (const listener of this.listeners) listener()
  }
  hide = (): void => { this.transition('hidden') }
  setPinned = (pinned: boolean): void => { this.transition(pinned ? 'pinned' : 'floating') }
  syncOverlay = (): void => {
    if (this.state.mode === 'floating' && this.overlays.snapshot() !== this.overlayId) this.transition('hidden')
  }
  private transition(mode: AgentsPanelMode, focusOnOpen = false): void {
    if (this.state.mode === mode) return
    this.state = { mode, open: mode !== 'hidden', pinned: mode === 'pinned', focusOnOpen }
    try { this.storage?.setItem(AGENTS_PIN_KEY, String(this.state.pinned)) } catch {}
    if (mode === 'floating') this.overlays.open(this.overlayId)
    else this.overlays.close(this.overlayId)
    for (const listener of this.listeners) listener()
  }
  dispose(): void { this.listeners.clear(); this.overlays.close(this.overlayId) }
}

export interface PaneHeaderBounds { top: number; bottom: number; width: number; height: number }
/** Ignore hidden workspaces and lower split rows when finding the top chrome. */
export function agentsPanelTop(headers: readonly PaneHeaderBounds[], fallback: number): number {
  const visible = headers.filter((rect) => rect.width > 0 && rect.height > 0)
  const top = Math.min(...visible.map((rect) => rect.top))
  return visible.length ? Math.max(...visible.filter((rect) => Math.abs(rect.top - top) < 2).map((rect) => rect.bottom)) : fallback
}

declare module 'cordis' {
  interface Context { clientAgentsPanel: AgentsPanelController }
}
