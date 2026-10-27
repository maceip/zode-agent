import type { ClientOverlays } from '../../src/client/plugin-api.js'
import type { ClientWorkspaceLayoutService, WorkspaceTabTarget } from './workspace-layout-api.js'

export const TAB_SWITCHER_ID = 'workspace-tab-switcher'
export const TAB_RECENCY_KEY = 'alto.workspace-tab-recency'

export interface TabSwitcherSnapshot {
  tabs: readonly WorkspaceTabTarget[]
  selectedId?: string
}

type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>

export class WorkspaceTabSwitcher {
  private readonly listeners = new Set<() => void>()
  private recent: string[] = []
  private activeId: string | undefined
  private candidates: string[] | undefined
  private selectedId: string | undefined
  private state: TabSwitcherSnapshot = { tabs: [] }
  restoreFocus = true

  constructor(
    private readonly layout: Pick<ClientWorkspaceLayoutService, 'tabs' | 'selectTab' | 'subscribe'>,
    private readonly overlays: ClientOverlays,
    private readonly storage?: StorageAccess,
  ) {
    try {
      const saved: unknown = JSON.parse(storage?.getItem(TAB_RECENCY_KEY) ?? 'null')
      if (Array.isArray(saved)) this.recent = [...new Set(saved.filter((id): id is string => typeof id === 'string'))]
    } catch { /* Recency still works when local storage is unavailable. */ }
    this.sync()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): TabSwitcherSnapshot => this.state

  activate(): () => void {
    const stopLayout = this.layout.subscribe(() => this.sync())
    const stopOverlay = this.overlays.subscribe(() => {
      if (this.selectedId && this.overlays.snapshot() !== TAB_SWITCHER_ID) this.cancel()
    })
    this.sync()
    return () => {
      stopLayout()
      stopOverlay()
      this.cancel()
      this.listeners.clear()
    }
  }

  canCycle = (): boolean => (
    this.layout.tabs().length > 1
    && (!this.overlays.snapshot() || this.overlays.snapshot() === TAB_SWITCHER_ID)
  )

  cycle(direction: 1 | -1): void {
    if (!this.canCycle()) return
    this.sync()
    const tabs = this.state.tabs
    if (tabs.length < 2) return
    // Freeze the order for the entire held-Option gesture. Previewing a row
    // must not turn it into the most recently used tab.
    this.candidates ??= tabs.map((tab) => tab.id)
    const index = this.candidates.indexOf(this.selectedId ?? this.activeId ?? '')
    this.selectedId = this.candidates[(index + direction + this.candidates.length) % this.candidates.length]
    this.restoreFocus = true
    this.overlays.open(TAB_SWITCHER_ID)
    this.emit()
  }

  commit(id = this.selectedId): void {
    if (!id) return
    // Resolve the index now: a tab can move or close while the popup is open.
    const index = this.layout.tabs().findIndex((tab) => tab.id === id)
    this.restoreFocus = id === this.activeId || index < 0
    this.close()
    if (index >= 0) this.layout.selectTab(index)
  }

  cancel = (): void => {
    this.restoreFocus = true
    this.close()
  }

  private close(): void {
    this.selectedId = undefined
    this.candidates = undefined
    this.emit()
    this.overlays.close(TAB_SWITCHER_ID)
  }

  private sync(): void {
    const tabs = this.layout.tabs()
    if (!tabs.length) {
      // The layout mounts after this fiber. Don't erase persisted recency
      // while it is still restoring its tabs.
      if (this.selectedId) this.cancel()
      return
    }
    const activeId = tabs.find((tab) => tab.active)?.id
    const changed = activeId !== this.activeId
    this.activeId = activeId
    const liveIds = new Set(tabs.map((tab) => tab.id))
    const previous = this.recent.join('\n')
    this.recent = this.recent.filter((id) => liveIds.has(id))
    if (changed && activeId) this.recent = [activeId, ...this.recent.filter((id) => id !== activeId)]
    for (const tab of tabs) if (!this.recent.includes(tab.id)) this.recent.push(tab.id)
    if (previous !== this.recent.join('\n')) {
      try { this.storage?.setItem(TAB_RECENCY_KEY, JSON.stringify(this.recent)) } catch {}
    }
    if (changed && this.selectedId) { this.cancel(); return }
    if (this.candidates) {
      const oldIndex = this.candidates.indexOf(this.selectedId!)
      this.candidates = this.candidates.filter((id) => liveIds.has(id))
      if (this.candidates.length < 2) { this.cancel(); return }
      if (!this.candidates.includes(this.selectedId!)) {
        this.selectedId = this.candidates[Math.min(Math.max(oldIndex, 0), this.candidates.length - 1)]
      }
    }
    this.emit()
  }

  private emit(): void {
    const byId = new Map(this.layout.tabs().map((tab) => [tab.id, tab]))
    const tabs = (this.candidates ?? this.recent).flatMap((id) => byId.get(id) ?? [])
    if (this.state.selectedId === this.selectedId
      && tabs.length === this.state.tabs.length
      && tabs.every((tab, index) => {
        const previous = this.state.tabs[index]!
        return tab.id === previous.id && tab.title === previous.title && tab.active === previous.active
          && tab.threadIds.join('\0') === previous.threadIds.join('\0')
      })) return
    this.state = { tabs, ...(this.selectedId ? { selectedId: this.selectedId } : {}) }
    for (const listener of this.listeners) listener()
  }
}

export function releasesTabSwitcher(event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey'>): boolean {
  return !event.altKey && (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight' || event.key === 'Tab')
}
