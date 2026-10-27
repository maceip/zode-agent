import { paneToolbarStyles } from './pane-toolbar.js'
import {
  ChevronLeft,
  ChevronRight,
  Globe2,
  RotateCw,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from 'react'
import type { Context } from 'cordis'
import {
  clientStyles,
  type BrowserPlugin,
  type ClientUiService,
} from '../../src/client/plugin-api.js'
import type {
  ClientNativeView,
  ClientNativeViewsService,
} from '../../src/client/native-views.js'
import {
  nativeViewUrl,
  type NativeViewAction,
  type NativeViewState,
} from '../../src/shared/native-views.js'
import type {
  BrowserStartPage,
  BrowserStartPageRegistration,
  BrowserWorkspace,
  ClientBrowserService,
  ClientBrowserSnapshot,
} from './browser-api.js'
import { movePaneTabs, type PaneTabsProps } from './pane-tabs-api.js'
import type { WorkspacePaneKindProps } from './workspace-layout-api.js'
import type { WorkspacePaneNode } from './workspace-layout-state.js'
import styles from './browser-workspace.css'

export interface BrowserTab {
  id: string
  title: string
  url: string
  startPageId?: string
}

export interface BrowserTabsState {
  version: 1
  activeId: string
  nextOrdinal: number
  hiddenStartPageIds: string[]
  tabs: BrowserTab[]
}

export class BrowserRegistry implements ClientBrowserService {
  private readonly entries = new Map<string, BrowserStartPage>()
  private readonly listeners = new Set<() => void>()
  private state: ClientBrowserSnapshot = { revision: 0, startPages: [] }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientBrowserSnapshot => this.state

  registerStartPage(owner: Context, page: BrowserStartPage): BrowserStartPageRegistration {
    const registered = { ...page, url: nativeViewUrl(page.url) }
    const dispose = owner.effect(() => {
      if (this.entries.has(page.id)) throw new Error(`browser start page "${page.id}" is already registered`)
      this.entries.set(page.id, registered)
      this.emit()
      return () => {
        if (this.entries.get(page.id) === registered) this.entries.delete(page.id)
        this.emit()
      }
    }, `clientBrowser.registerStartPage(${JSON.stringify(page.id)})`)
    return { dispose: async () => dispose() }
  }

  dispose(): void {
    this.entries.clear()
    this.listeners.clear()
    this.state = { revision: this.state.revision + 1, startPages: [] }
  }

  private emit(): void {
    this.state = {
      revision: this.state.revision + 1,
      startPages: [...this.entries.values()].toSorted((left, right) => (
        (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id)
      )),
    }
    for (const listener of this.listeners) listener()
  }
}

export function browserWorkspaceForPane(pane: WorkspacePaneNode): BrowserWorkspace {
  const parts = pane.workspace.trim().replaceAll('\\', '/').split('/').filter(Boolean)
  const identity = (pane.projectId ?? pane.workspace) || 'unassigned'
  return {
    key: `workspace:${identity}`,
    name: parts.at(-1) ?? 'Unassigned',
    path: pane.workspace,
    ...(pane.projectId ? { projectId: pane.projectId } : {}),
  }
}

export function browserStartPagesForWorkspace(
  pages: readonly BrowserStartPage[],
  workspace: Readonly<BrowserWorkspace>,
): BrowserStartPage[] {
  return pages.filter((page) => {
    try {
      return page.availableIn?.(workspace) ?? true
    } catch (error) {
      console.error(`Browser start page "${page.id}" rejected workspace "${workspace.key}"`, error)
      return false
    }
  })
}

export function normalizeBrowserInput(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('Enter a web address')
  if (/^[a-z][a-z\d+.-]*:/iu.test(value)) return nativeViewUrl(value)
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/iu.test(value)
  return nativeViewUrl(`${local ? 'http' : 'https'}://${value}`)
}

function startTab(page: BrowserStartPage): BrowserTab {
  return {
    id: `start:${encodeURIComponent(page.id)}`,
    title: page.title,
    url: page.url,
    startPageId: page.id,
  }
}

function blankTab(ordinal: number): BrowserTab {
  return { id: `browser-${ordinal}`, title: 'New Tab', url: '' }
}

export function initialBrowserTabs(pages: readonly BrowserStartPage[]): BrowserTabsState {
  const tabs = pages.map(startTab)
  if (!tabs.length) tabs.push(blankTab(1))
  return {
    version: 1,
    activeId: tabs[0]!.id,
    nextOrdinal: tabs[0]!.id === 'browser-1' ? 2 : 1,
    hiddenStartPageIds: [],
    tabs,
  }
}

export function parseBrowserTabs(
  value: unknown,
  pages: readonly BrowserStartPage[],
): BrowserTabsState {
  if (!value || typeof value !== 'object') return initialBrowserTabs(pages)
  const candidate = value as Partial<BrowserTabsState>
  if (candidate.version !== 1 || !Array.isArray(candidate.tabs)) return initialBrowserTabs(pages)
  const tabs = candidate.tabs.flatMap((tab) => (
    tab
      && typeof tab.id === 'string'
      && typeof tab.title === 'string'
      && typeof tab.url === 'string'
      ? [{
          id: tab.id,
          title: tab.title,
          url: tab.url,
          ...(typeof tab.startPageId === 'string' ? { startPageId: tab.startPageId } : {}),
        }]
      : []
  ))
  if (!tabs.length) return initialBrowserTabs(pages)
  const maxOrdinal = tabs.reduce((maximum, tab) => {
    const match = /^browser-(\d+)$/u.exec(tab.id)
    return Math.max(maximum, match ? Number(match[1]) : 0)
  }, 0)
  return reconcileBrowserTabs({
    version: 1,
    activeId: typeof candidate.activeId === 'string'
      && tabs.some((tab) => tab.id === candidate.activeId)
      ? candidate.activeId
      : tabs[0]!.id,
    nextOrdinal: typeof candidate.nextOrdinal === 'number'
      ? Math.max(candidate.nextOrdinal, maxOrdinal + 1)
      : maxOrdinal + 1,
    hiddenStartPageIds: Array.isArray(candidate.hiddenStartPageIds)
      ? candidate.hiddenStartPageIds.filter((id): id is string => typeof id === 'string')
      : [],
    tabs,
  }, pages)
}

export function reconcileBrowserTabs(
  current: BrowserTabsState,
  pages: readonly BrowserStartPage[],
): BrowserTabsState {
  const definitions = new Map(pages.map((page) => [page.id, page]))
  let tabs = current.tabs.flatMap((tab) => {
    if (!tab.startPageId) return [tab]
    const page = definitions.get(tab.startPageId)
    if (!page) return []
    return [{
      ...tab,
      title: tab.url === page.url ? page.title : tab.title,
    }]
  })
  const represented = new Set(tabs.flatMap((tab) => tab.startPageId ? [tab.startPageId] : []))
  tabs = [
    ...tabs,
    ...pages.filter((page) => (
      !represented.has(page.id) && !current.hiddenStartPageIds.includes(page.id)
    )).map(startTab),
  ]
  let nextOrdinal = current.nextOrdinal
  if (!tabs.length) {
    tabs = [blankTab(nextOrdinal)]
    nextOrdinal += 1
  }
  const activeId = tabs.some((tab) => tab.id === current.activeId)
    ? current.activeId
    : tabs[0]!.id
  const unchanged = activeId === current.activeId
    && nextOrdinal === current.nextOrdinal
    && tabs.length === current.tabs.length
    && tabs.every((tab, index) => {
      const previous = current.tabs[index]
      return tab.id === previous?.id
        && tab.title === previous.title
        && tab.url === previous.url
        && tab.startPageId === previous.startPageId
    })
  return unchanged ? current : { ...current, activeId, nextOrdinal, tabs }
}

function browserStorageKey(workspaceId: string, paneId: string): string {
  return `codex-cordis.browser-tabs:${workspaceId}:${paneId}`
}

function readState(key: string, pages: readonly BrowserStartPage[]): BrowserTabsState {
  try {
    const stored = window.localStorage.getItem(key)
    return parseBrowserTabs(stored ? JSON.parse(stored) : undefined, pages)
  } catch {
    return initialBrowserTabs(pages)
  }
}

function writeState(key: string, state: BrowserTabsState): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // Browser tabs remain live when persistence is unavailable.
  }
}

function NativeBrowserSurface({
  url,
  active,
  focused,
  nativeViews,
  ui,
  ready,
  changed,
}: {
  url: string
  active: boolean
  focused: boolean
  nativeViews: ClientNativeViewsService
  ui: ClientUiService
  ready: (view: ClientNativeView | undefined) => void
  changed: (state: NativeViewState) => void
}): ReactNode {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<ClientNativeView | undefined>(undefined)
  const syncRef = useRef<() => void>(() => undefined)
  const activeRef = useRef(active)
  const focusedRef = useRef(focused)
  const readyRef = useRef(ready)
  const changedRef = useRef(changed)
  const initialUrl = useRef(url).current
  const nativeViewsOccluded = useSyncExternalStore(
    ui.overlays.subscribe,
    ui.overlays.nativeViewsOccluded,
  )
  const nativeViewsOccludedRef = useRef(nativeViewsOccluded)
  const [problem, setProblem] = useState<string>()

  activeRef.current = active
  focusedRef.current = focused
  readyRef.current = ready
  changedRef.current = changed
  nativeViewsOccludedRef.current = nativeViewsOccluded

  useEffect(() => {
    let live = true
    let frame: number | undefined
    let unsubscribe = (): void => undefined

    const sync = (): void => {
      if (frame !== undefined) return
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        const mount = mountRef.current
        const view = viewRef.current
        if (!mount || !view) return
        if (!activeRef.current) {
          view.setVisible(false)
          return
        }
        const rect = mount.getBoundingClientRect()
        const left = Math.max(0, rect.left)
        const top = Math.max(0, rect.top)
        const right = Math.min(window.innerWidth, rect.right)
        const bottom = Math.min(window.innerHeight, rect.bottom)
        const width = Math.max(0, right - left)
        const height = Math.max(0, bottom - top)
        view.setBounds({ x: left, y: top, width, height })
        view.setVisible(
          activeRef.current
          && !nativeViewsOccludedRef.current
          && width > 1
          && height > 1
          && document.visibilityState === 'visible',
        )
      })
    }
    syncRef.current = sync

    void nativeViews.create({ url: initialUrl }).then((view) => {
      if (!live) {
        void view.destroy()
        return
      }
      viewRef.current = view
      readyRef.current(view)
      changedRef.current(view.snapshot())
      unsubscribe = view.subscribe(() => changedRef.current(view.snapshot()))
      sync()
      if (activeRef.current && focusedRef.current) view.focus()
    }).catch((error: unknown) => {
      if (live) setProblem(error instanceof Error ? error.message : String(error))
    })

    return () => {
      live = false
      if (syncRef.current === sync) syncRef.current = () => undefined
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      unsubscribe()
      const view = viewRef.current
      viewRef.current = undefined
      readyRef.current(undefined)
      void view?.destroy()
    }
  }, [initialUrl, nativeViews])

  useEffect(() => {
    if (!active) {
      viewRef.current?.setVisible(false)
      return
    }
    const sync = (): void => syncRef.current()
    const observer = new ResizeObserver(sync)
    if (mountRef.current) observer.observe(mountRef.current)
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [active])

  useEffect(() => syncRef.current(), [active, nativeViewsOccluded])
  useEffect(() => {
    if (active && focused) viewRef.current?.focus()
  }, [active, focused])

  return (
    <div className="browser-native-surface" data-native-pane-surface="" ref={mountRef}>
      {problem ? <p>{problem}</p> : null}
    </div>
  )
}

function BrowserPane({
  workspaceId,
  pane,
  focused,
  visible,
  closePane,
  registry,
  nativeViews,
  ui,
  Tabs,
}: WorkspacePaneKindProps & {
  registry: BrowserRegistry
  nativeViews: ClientNativeViewsService
  ui: ClientUiService
  Tabs: ComponentType<PaneTabsProps>
}): ReactNode {
  useSyncExternalStore(registry.subscribe, registry.snapshot)
  const workspace = useMemo(() => browserWorkspaceForPane(pane), [pane])
  const registryState = registry.snapshot()
  const startPages = useMemo(
    () => browserStartPagesForWorkspace(registryState.startPages, workspace),
    [registryState, workspace],
  )
  const key = browserStorageKey(workspaceId, pane.id)
  const [state, setState] = useState(() => readState(key, startPages))
  const views = useRef(new Map<string, ClientNativeView>())
  const [viewStates, setViewStates] = useState<Record<string, NativeViewState>>({})
  const [address, setAddress] = useState('')
  const [addressProblem, setAddressProblem] = useState<string>()
  const editingAddress = useRef(false)
  const addressInput = useRef<HTMLInputElement>(null)
  const activeTab = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0]!
  const activeView = views.current.get(activeTab.id)
  const activeViewState = viewStates[activeTab.id]

  useEffect(() => writeState(key, state), [key, state])
  useEffect(() => {
    setState((current) => reconcileBrowserTabs(current, startPages))
  }, [startPages])
  useEffect(() => {
    if (!editingAddress.current) setAddress(activeTab.url)
  }, [activeTab.id, activeTab.url])
  useEffect(() => {
    if (focused && !activeTab.url) addressInput.current?.focus()
  }, [activeTab.id, activeTab.url, focused])

  const updateTab = (id: string, update: (tab: BrowserTab) => BrowserTab): void => {
    setState((current) => {
      const tabs = current.tabs.map((tab) => tab.id === id ? update(tab) : tab)
      return tabs.every((tab, index) => tab === current.tabs[index]) ? current : { ...current, tabs }
    })
  }

  const navigate = (event: FormEvent): void => {
    event.preventDefault()
    try {
      const url = normalizeBrowserInput(address)
      setAddressProblem(undefined)
      updateTab(activeTab.id, (tab) => tab.url === url ? tab : { ...tab, url, title: tab.title || 'Loading…' })
      void activeView?.navigate(url)
    } catch (error) {
      setAddressProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const create = (): void => {
    setState((current) => {
      const tab = blankTab(current.nextOrdinal)
      return {
        ...current,
        activeId: tab.id,
        nextOrdinal: current.nextOrdinal + 1,
        tabs: [...current.tabs, tab],
      }
    })
  }

  const close = (id: string): void => {
    setState((current) => {
      if (current.tabs.length <= 1) return current
      const index = current.tabs.findIndex((tab) => tab.id === id)
      if (index < 0) return current
      const closing = current.tabs[index]!
      const tabs = current.tabs.filter((tab) => tab.id !== id)
      return {
        ...current,
        tabs,
        activeId: current.activeId === id
          ? tabs[Math.min(index, tabs.length - 1)]!.id
          : current.activeId,
        hiddenStartPageIds: closing.startPageId
          ? [...new Set([...current.hiddenStartPageIds, closing.startPageId])]
          : current.hiddenStartPageIds,
      }
    })
  }

  const action = (action: NativeViewAction): void => {
    void activeView?.perform(action)
  }

  const pageById = new Map(startPages.map((page) => [page.id, page]))
  return (
    <div className={`${clientStyles.pane} browser-workspace-pane`}>
      <div className={`${clientStyles.paneHeader} browser-workspace-tabs workspace-local-tabbar`}>
        <Tabs
          tabs={state.tabs.map((tab) => ({
            id: tab.id,
            title: tab.title,
            icon: tab.startPageId ? pageById.get(tab.startPageId)?.icon ?? Globe2 : Globe2,
          }))}
          activeId={state.activeId}
          label="Browser tabs"
          createLabel="New browser tab"
          activate={(id) => setState((current) => ({ ...current, activeId: id }))}
          create={create}
          close={close}
          {...(closePane ? {
            closeLast: closePane,
            closeLastLabel: 'Close Browser pane',
          } : {})}
          move={(id, targetId, position) => setState((current) => ({
            ...current,
            tabs: [...movePaneTabs(current.tabs, id, targetId, position)],
          }))}
        />
      </div>
      <form className={`${paneToolbarStyles.toolbar} browser-workspace-toolbar`} onSubmit={navigate}>
        <div className={paneToolbarStyles.group}>
          <button className={clientStyles.iconButton} type="button" aria-label="Back" title="Back" disabled={!activeViewState?.canGoBack} onClick={() => action('back')}>
            <ChevronLeft size={14} />
          </button>
          <button className={clientStyles.iconButton} type="button" aria-label="Forward" title="Forward" disabled={!activeViewState?.canGoForward} onClick={() => action('forward')}>
            <ChevronRight size={14} />
          </button>
          <button className={clientStyles.iconButton} type="button" aria-label="Reload" title="Reload" disabled={!activeTab.url} onClick={() => action('reload')}>
            <RotateCw className={activeViewState?.loading ? 'is-loading' : ''} size={14} />
          </button>
        </div>
        <input
          ref={addressInput}
          value={address}
          aria-label="Web address"
          aria-invalid={Boolean(addressProblem)}
          title={addressProblem}
          placeholder="Search or enter website name"
          onFocus={() => { editingAddress.current = true }}
          onBlur={() => {
            editingAddress.current = false
            setAddress(activeTab.url)
          }}
          onChange={(event) => setAddress(event.target.value)}
        />
      </form>
      <div className="browser-workspace-surfaces">
        {state.tabs.map((tab) => {
          const active = tab.id === activeTab.id
          return (
            <div className={`browser-workspace-surface${active ? ' is-active' : ''}`} key={tab.id}>
              {tab.url ? (
                nativeViews.available() ? (
                  <NativeBrowserSurface
                    url={tab.url}
                    active={visible && active}
                    focused={focused && active}
                    nativeViews={nativeViews}
                    ui={ui}
                    ready={(view) => {
                      if (view) views.current.set(tab.id, view)
                      else {
                        views.current.delete(tab.id)
                        setViewStates((current) => {
                          if (!(tab.id in current)) return current
                          const next = { ...current }
                          delete next[tab.id]
                          return next
                        })
                      }
                    }}
                    changed={(next) => {
                      setViewStates((current) => current[tab.id] === next ? current : { ...current, [tab.id]: next })
                      updateTab(tab.id, (current) => {
                        const title = next.title.trim() || current.title
                        return current.url === next.url && current.title === title
                          ? current
                          : { ...current, url: next.url, title }
                      })
                    }}
                  />
                ) : (
                  <div className="browser-workspace-unavailable">
                    <Globe2 size={22} />
                    <strong>Open this page in Alto Desktop</strong>
                    <span>Authenticated browser tabs use the native desktop surface.</span>
                    <a href={tab.url} rel="noreferrer" target="_blank">Open in a browser</a>
                  </div>
                )
              ) : (
                <button className="browser-workspace-empty" type="button" onClick={() => addressInput.current?.focus()}>
                  <Globe2 size={24} />
                  <span>Enter an address to start browsing</span>
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const browserWorkspace: BrowserPlugin = (ctx) => {
  const registry = new BrowserRegistry()
  const Tabs = ctx.clientPaneTabs.renderer
  ctx.provide('clientBrowser', registry)
  ctx.clientWorkspaceLayout.registerPaneKind(ctx, {
    id: 'browser',
    label: 'Browser',
    description: 'A native web browser with persistent tabs',
    shortcut: 'b',
    icon: Globe2,
    renderer: (props) => (
      <BrowserPane
        {...props}
        registry={registry}
        nativeViews={ctx.clientNativeViews}
        ui={ctx.clientUi}
        Tabs={Tabs}
      />
    ),
  })
  ctx.clientUi.registerStyle(ctx, 'browser-workspace', String(styles))
  return () => registry.dispose()
}

browserWorkspace.inject = [
  'clientNativeViews',
  'clientPaneTabs',
  'clientWorkspaceLayout',
  'clientUi',
]
browserWorkspace.provide = 'clientBrowser'

export default browserWorkspace
