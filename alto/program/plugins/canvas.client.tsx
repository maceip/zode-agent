import {
  PanelsTopLeft,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { Context } from 'cordis'
import { clientStyles, type BrowserPlugin } from '../../src/client/plugin-api.js'
import type { JsonValue } from '../../src/shared/protocol.js'
import type { ClientSessionSnapshot } from './session-api.js'
import type { WorkspacePaneKindProps } from './workspace-layout-api.js'
import type { WorkspacePaneNode } from './workspace-layout-state.js'
import type {
  CanvasDockItem,
  CanvasDockItemRegistration,
  CanvasDockItemProps,
  CanvasPage,
  CanvasPageContent,
  CanvasPageContentRegistration,
  CanvasPageDropPosition,
  CanvasPageProps,
  CanvasStorage,
  CanvasWidget,
  CanvasWidgetRegistration,
  CanvasWorkspace,
  ClientCanvasService,
  ClientCanvasSnapshot,
} from './canvas-api.js'
import styles from './canvas.css'

interface CanvasPageState extends CanvasPage {
  contentId?: string
}

interface LegacyPersistedCanvas {
  version: 1
  collapsed: boolean
  width: number
  layout: Record<string, unknown>
}

interface LegacyTabbedCanvas {
  version: 2
  collapsed: boolean
  width: number
  activePageId: string
  nextPageOrdinal: number
  pages: Array<CanvasPage & { layout?: Record<string, unknown> }>
}

interface LegacyDockedCanvas {
  version: 3
  collapsed: boolean
  width: number
  activePageId: string
  nextPageOrdinal: number
  hiddenContentIds: string[]
  pages: CanvasPageState[]
}

interface PersistedCanvas {
  version: 4
  activePageId: string
  nextPageOrdinal: number
  hiddenContentIds: string[]
  pages: CanvasPageState[]
}

function safeRead<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key)
    return value === null ? fallback : JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function safeWrite(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Canvas persistence is optional; the live UI still works when storage is unavailable.
  }
}

function readCanvas(key: string, fallback: PersistedCanvas): PersistedCanvas {
  const value = safeRead<
    Partial<PersistedCanvas>
    | Partial<LegacyDockedCanvas>
    | Partial<LegacyTabbedCanvas>
    | Partial<LegacyPersistedCanvas>
    | null
  >(key, null)
  if (!value) return fallback
  if (value.version === 1) {
    return fallback
  }
  if (
    (value.version !== 2 && value.version !== 3 && value.version !== 4)
    || !Array.isArray(value.pages)
    || !value.pages.length
  ) {
    return fallback
  }
  const pages = value.pages.filter((page): page is CanvasPageState => (
    Boolean(page)
    && typeof page.id === 'string'
    && typeof page.title === 'string'
  )).map((page) => ({
    id: page.id,
    title: page.title,
    ...('contentId' in page && typeof page.contentId === 'string'
      ? { contentId: page.contentId }
      : {}),
  }))
  if (!pages.length) return fallback
  const activePageId = typeof value.activePageId === 'string'
    && pages.some((page) => page.id === value.activePageId)
    ? value.activePageId
    : pages[0]!.id
  const maxOrdinal = pages.reduce((max, page) => {
    const match = /^page-(\d+)$/.exec(page.id)
    return Math.max(max, match ? Number(match[1]) : 1)
  }, 1)
  return {
    version: 4,
    activePageId,
    nextPageOrdinal: typeof value.nextPageOrdinal === 'number'
      ? Math.max(value.nextPageOrdinal, maxOrdinal + 1)
      : maxOrdinal + 1,
    hiddenContentIds: (value.version === 3 || value.version === 4) && Array.isArray(value.hiddenContentIds)
      ? value.hiddenContentIds.filter((id): id is string => typeof id === 'string')
      : [],
    pages,
  }
}

export function canvasWorkspaceKey(
  state: Pick<ClientSessionSnapshot, 'activeProjectId' | 'session'>,
): string {
  const workspace = state.activeProjectId ?? state.session.workspace ?? 'unassigned'
  return `workspace:${workspace}`
}

export function canvasWorkspace(
  state: Pick<ClientSessionSnapshot, 'activeProjectId' | 'projects' | 'session'>,
): CanvasWorkspace {
  const project = state.activeProjectId
    ? state.projects.find((candidate) => candidate.id === state.activeProjectId)
    : undefined
  const parts = state.session.workspace.trim().replaceAll('\\', '/').split('/').filter(Boolean)
  return {
    key: canvasWorkspaceKey(state),
    name: project?.name ?? parts.at(-1) ?? 'Unassigned',
    path: state.session.workspace,
    ...(state.activeProjectId ? { projectId: state.activeProjectId } : {}),
  }
}

export function canvasWorkspaceForPane(pane: WorkspacePaneNode): CanvasWorkspace {
  const parts = pane.workspace.trim().replaceAll('\\', '/').split('/').filter(Boolean)
  const identity = (pane.projectId ?? pane.workspace) || 'unassigned'
  return {
    key: `workspace:${identity}`,
    name: parts.at(-1) ?? 'Unassigned',
    path: pane.workspace,
    ...(pane.projectId ? { projectId: pane.projectId } : {}),
  }
}

export function canvasPageContentsForWorkspace(
  contents: readonly CanvasPageContent[],
  workspace: Readonly<CanvasWorkspace>,
): CanvasPageContent[] {
  return contents.filter((content) => {
    try {
      return content.availableIn?.(workspace) ?? true
    } catch (error) {
      console.error(`Canvas page "${content.id}" rejected workspace "${workspace.key}"`, error)
      return false
    }
  })
}

export function canvasPageScopeKey(workspaceKey: string, pageId: string): string {
  return `${workspaceKey}:page:${pageId}`
}

export function nextCanvasPageTitle(pages: readonly CanvasPage[]): string {
  const used = new Set(pages.flatMap((page) => {
    const match = /^Canvas (\d+)$/.exec(page.title)
    return match ? [Number(match[1])] : []
  }))
  let ordinal = 1
  while (used.has(ordinal)) ordinal += 1
  return `Canvas ${ordinal}`
}

export function nextBlankCanvasPage(
  pages: readonly CanvasPage[],
  ordinal: number,
): CanvasPage {
  return {
    id: `page-${ordinal}`,
    title: nextCanvasPageTitle(pages),
  }
}

export function reorderCanvasPages<T extends CanvasPage>(
  pages: T[],
  id: string,
  targetId: string,
  position: CanvasPageDropPosition,
): T[] {
  if (id === targetId) return pages
  const source = pages.find((page) => page.id === id)
  if (!source || !pages.some((page) => page.id === targetId)) return pages
  const reordered = pages.filter((page) => page.id !== id)
  const targetIndex = reordered.findIndex((page) => page.id === targetId)
  reordered.splice(targetIndex + (position === 'after' ? 1 : 0), 0, source)
  return reordered
}

export class CanvasRegistry implements ClientCanvasService {
  private readonly pageEntries = new Map<string, CanvasPageContent>()
  private readonly dockEntries = new Map<string, CanvasDockItem>()
  private readonly listeners = new Set<() => void>()
  private state: ClientCanvasSnapshot = {
    revision: 0,
    pageContents: [],
    dockItems: [],
  }

  constructor(private readonly togglePane: () => void = () => undefined) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientCanvasSnapshot => this.state

  toggle(): void {
    this.togglePane()
  }

  registerPage(owner: Context, page: CanvasPageContent): CanvasPageContentRegistration {
    let active = false
    const dispose = owner.effect(() => {
      if (this.pageEntries.has(page.id)) throw new Error(`canvas page "${page.id}" is already registered`)
      active = true
      this.pageEntries.set(page.id, page)
      this.emit()
      return () => {
        active = false
        if (this.pageEntries.get(page.id) === page) this.pageEntries.delete(page.id)
        this.emit()
      }
    }, `clientCanvas.registerPage(${JSON.stringify(page.id)})`)

    return {
      dispose: async () => {
        if (active) await dispose()
      },
    }
  }

  registerWidget(owner: Context, widget: CanvasWidget): CanvasWidgetRegistration {
    const LegacyWidget = widget.component
    const Page = ({ storage }: CanvasPageProps) => <LegacyWidget storage={storage} />
    return this.registerPage(owner, {
      id: widget.id,
      title: widget.title,
      component: Page,
      ...(widget.order === undefined ? {} : { order: widget.order }),
    })
  }

  registerDockItem(owner: Context, item: CanvasDockItem): CanvasDockItemRegistration {
    let active = false
    const dispose = owner.effect(() => {
      if (this.dockEntries.has(item.id)) throw new Error(`canvas dock item "${item.id}" is already registered`)
      active = true
      this.dockEntries.set(item.id, item)
      this.emit()
      return () => {
        active = false
        if (this.dockEntries.get(item.id) === item) this.dockEntries.delete(item.id)
        this.emit()
      }
    }, `clientCanvas.registerDockItem(${JSON.stringify(item.id)})`)

    return {
      dispose: async () => {
        if (active) await dispose()
      },
    }
  }

  dispose(): void {
    this.pageEntries.clear()
    this.dockEntries.clear()
    this.listeners.clear()
    this.state = {
      revision: this.state.revision + 1,
      pageContents: [],
      dockItems: [],
    }
  }

  private emit(): void {
    this.state = {
      revision: this.state.revision + 1,
      pageContents: [...this.pageEntries.values()].toSorted((left, right) => (
        (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id)
      )),
      dockItems: [...this.dockEntries.values()].toSorted((left, right) => (
        (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id)
      )),
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

class ScopedStorage implements CanvasStorage {
  constructor(
    readonly scopeKey: string,
    private readonly namespace: string,
    private readonly legacyScopeKey?: string,
  ) {}

  read<T extends JsonValue>(key: string, fallback: T): T {
    try {
      const value = window.localStorage.getItem(this.key(this.scopeKey, key))
      if (value !== null) return JSON.parse(value) as T
      if (this.legacyScopeKey) {
        const legacy = window.localStorage.getItem(this.key(this.legacyScopeKey, key))
        if (legacy !== null) return JSON.parse(legacy) as T
      }
    } catch {
      // Fall through to the caller's default when storage is unavailable or malformed.
    }
    return fallback
  }

  write(key: string, value: JsonValue): void {
    safeWrite(this.key(this.scopeKey, key), value)
  }

  remove(key: string): void {
    try {
      window.localStorage.removeItem(this.key(this.scopeKey, key))
      if (this.legacyScopeKey) {
        window.localStorage.removeItem(this.key(this.legacyScopeKey, key))
      }
    } catch {
      // See write(): storage failures do not disable the live widget.
    }
  }

  private key(scopeKey: string, key: string): string {
    return `codex-cordis.canvas.widget:${scopeKey}:${this.namespace}:${key}`
  }
}

export function canvasPageIdForContent(contentId: string): string {
  return `content:${encodeURIComponent(contentId)}`
}

export function canvasPageTitle(
  content: CanvasPageContent,
  workspace: Readonly<CanvasWorkspace>,
): string {
  try {
    return content.titleForWorkspace?.(workspace).trim() || content.title
  } catch (error) {
    console.error(`Canvas page "${content.id}" could not derive its title`, error)
    return content.title
  }
}

function contentPage(
  content: CanvasPageContent,
  workspace: Readonly<CanvasWorkspace>,
  id = canvasPageIdForContent(content.id),
): CanvasPageState {
  return { id, title: canvasPageTitle(content, workspace), contentId: content.id }
}

function samePages(left: readonly CanvasPageState[], right: readonly CanvasPageState[]): boolean {
  return left.length === right.length && left.every((page, index) => {
    const other = right[index]
    return page.id === other?.id
      && page.title === other.title
      && page.contentId === other.contentId
  })
}

function reconcilePageContents(
  current: PersistedCanvas,
  contents: readonly CanvasPageContent[],
  workspace: Readonly<CanvasWorkspace>,
): PersistedCanvas {
  const definitions = new Map(contents.map((content) => [content.id, content]))
  let pages = current.pages.flatMap((page) => {
    if (!page.contentId) return [page]
    const content = definitions.get(page.contentId)
    return content ? [{ ...page, title: canvasPageTitle(content, workspace) }] : []
  })
  const represented = new Set(pages.flatMap((page) => page.contentId ? [page.contentId] : []))
  const available = contents.filter((content) => (
    !represented.has(content.id) && !current.hiddenContentIds.includes(content.id)
  ))

  if (
    available.length > 0
    && pages.length === 1
    && pages[0]?.id === 'main'
    && !pages[0].contentId
    && /^Canvas \d+$/.test(pages[0].title)
  ) {
    const [first, ...rest] = available
    pages = [
      contentPage(first!, workspace, 'main'),
      ...rest.map((content) => contentPage(content, workspace)),
    ]
  } else {
    pages = [...pages, ...available.map((content) => contentPage(content, workspace))]
  }

  if (pages.length === 0) pages = [{ id: 'main', title: 'Canvas 1' }]
  const activePageId = pages.some((page) => page.id === current.activePageId)
    ? current.activePageId
    : pages[0]!.id
  if (activePageId === current.activePageId && samePages(pages, current.pages)) return current
  return { ...current, activePageId, pages }
}

function CanvasDock({
  activePageId,
  activatePage,
  closePane,
  closePage,
  createPage,
  items,
  movePage,
  pages,
  scopeKey,
}: {
  activePageId: string
  activatePage: (id: string) => void
  closePane?: () => void
  closePage: (id: string) => void
  createPage: () => void
  items: readonly CanvasDockItem[]
  movePage: (id: string, targetId: string, position: CanvasPageDropPosition) => void
  pages: readonly CanvasPage[]
  scopeKey: string
}): ReactNode {
  if (!items.length) return null
  const grows = items.some((item) => item.grow)
  return (
    <div
      className={`canvas-dock ${grows ? 'canvas-dock-grow' : ''}`}
      role="toolbar"
      aria-label="Canvas controls"
    >
      {items.map((item) => {
        const Item = item.component
        const storage = new ScopedStorage(scopeKey, `dock:${item.id}`)
        const props: CanvasDockItemProps = {
          activePageId,
          activatePage,
          ...(closePane ? { closePane } : {}),
          closePage,
          createPage,
          movePage,
          pages,
          storage,
        }
        return (
          <div
            className={`canvas-dock-item ${item.grow ? 'canvas-dock-item-grow' : ''}`}
            data-canvas-dock-item={item.id}
            key={item.id}
          >
            <Item {...props} />
          </div>
        )
      })}
    </div>
  )
}

function CanvasPageBody({
  active,
  content,
  focused,
  page,
  scopeKey,
  workspace,
}: {
  active: boolean
  content: CanvasPageContent | undefined
  focused: boolean
  page: CanvasPageState
  scopeKey: string
  workspace: Readonly<CanvasWorkspace>
}): ReactNode {
  const Content = content?.component
  const storage = content ? new ScopedStorage(
    canvasPageScopeKey(scopeKey, page.id),
    content.id,
    scopeKey,
  ) : undefined
  return (
    <div
      className="canvas-page-content"
      data-canvas-page-content={content?.id ?? 'blank'}
      hidden={!active}
    >
      {Content && storage ? (
        <Content
          storage={storage}
          page={page}
          workspace={workspace}
          active={active}
          focused={focused}
        />
      ) : (
        <div className="canvas-page-empty">
          <strong>Blank canvas</strong>
          <span>Ask Codex to turn this tab into anything.</span>
        </div>
      )}
    </div>
  )
}

function ScopedCanvas({
  active,
  closePane,
  focused,
  scopeKey,
  workspace,
  registry,
}: {
  active: boolean
  closePane?: () => void
  focused: boolean
  scopeKey: string
  workspace: CanvasWorkspace
  registry: ClientCanvasService
}): ReactNode {
  const registryState = useSyncExternalStore(registry.subscribe, registry.snapshot)
  const pageContents = useMemo(() => canvasPageContentsForWorkspace(
    registryState.pageContents,
    workspace,
  ), [
    registryState.pageContents,
    workspace.key,
    workspace.name,
    workspace.path,
    workspace.projectId,
  ])
  const storageKey = `codex-cordis.canvas:${scopeKey}`
  const fallback: PersistedCanvas = {
    version: 4,
    activePageId: 'main',
    nextPageOrdinal: 2,
    hiddenContentIds: [],
    pages: [{ id: 'main', title: 'Canvas 1' }],
  }
  const [persisted, setPersisted] = useState(() => reconcilePageContents(
    readCanvas(storageKey, fallback),
    pageContents,
    workspace,
  ))
  const activePage = persisted.pages.find((page) => page.id === persisted.activePageId)
    ?? persisted.pages[0]!
  const dockPages = useMemo(() => {
    const definitions = new Map(pageContents.map((content) => [content.id, content]))
    return persisted.pages.map((page): CanvasPage => {
      const content = page.contentId ? definitions.get(page.contentId) : undefined
      return content?.icon ? { ...page, icon: content.icon } : page
    })
  }, [pageContents, persisted.pages])

  useEffect(
    () => safeWrite(storageKey, persisted),
    [persisted, storageKey],
  )
  useEffect(() => {
    setPersisted((current) => reconcilePageContents(current, pageContents, workspace))
  }, [
    pageContents,
    workspace.key,
    workspace.name,
    workspace.path,
    workspace.projectId,
  ])
  const activatePage = (id: string): void => {
    setPersisted((current) => current.activePageId !== id
      && current.pages.some((page) => page.id === id)
      ? { ...current, activePageId: id }
      : current)
  }

  const createPage = (): void => {
    setPersisted((current) => {
      const ordinal = current.nextPageOrdinal
      const page = nextBlankCanvasPage(current.pages, ordinal)
      return {
        ...current,
        activePageId: page.id,
        nextPageOrdinal: ordinal + 1,
        pages: [...current.pages, page],
      }
    })
  }

  const closePage = (id: string): void => {
    setPersisted((current) => {
      if (current.pages.length <= 1) return current
      const index = current.pages.findIndex((page) => page.id === id)
      if (index < 0) return current
      const pages = current.pages.filter((page) => page.id !== id)
      const hiddenContentIds = current.pages[index]?.contentId
        ? [...new Set([...current.hiddenContentIds, current.pages[index]!.contentId!])]
        : current.hiddenContentIds
      const activePageId = current.activePageId === id
        ? pages[Math.min(index, pages.length - 1)]!.id
        : current.activePageId
      return { ...current, activePageId, hiddenContentIds, pages }
    })
  }

  const movePage = (
    id: string,
    targetId: string,
    position: CanvasPageDropPosition,
  ): void => {
    setPersisted((current) => {
      const pages = reorderCanvasPages(current.pages, id, targetId, position)
      return pages === current.pages ? current : { ...current, pages }
    })
  }

  return (
    <section
      className={`${clientStyles.pane} canvas-pane`}
      aria-label="Canvas"
    >
      <header className={`${clientStyles.paneHeader} canvas-header workspace-local-tabbar`}>
        <CanvasDock
          activePageId={activePage.id}
          activatePage={activatePage}
          {...(closePane ? { closePane } : {})}
          closePage={closePage}
          createPage={createPage}
          items={registryState.dockItems}
          movePage={movePage}
          pages={dockPages}
          scopeKey={scopeKey}
        />
      </header>
      <div className="canvas-page-host">
        {persisted.pages.map((page) => {
          const content = page.contentId
            ? pageContents.find((candidate) => candidate.id === page.contentId)
            : undefined
          return (
            <CanvasPageBody
              active={active && page.id === activePage.id}
              content={content}
              focused={focused && page.id === activePage.id}
              key={page.id}
              page={page}
              scopeKey={scopeKey}
              workspace={workspace}
            />
          )
        })}
      </div>
    </section>
  )
}

const canvasClient: BrowserPlugin = (ctx) => {
  const registry = new CanvasRegistry(() => ctx.clientWorkspaceLayout.togglePaneKind('canvas'))
  ctx.provide('clientCanvas', registry)
  const CanvasPane = ({ pane, focused, visible, closePane }: WorkspacePaneKindProps) => {
    const workspace = canvasWorkspaceForPane(pane)
    return (
      <ScopedCanvas
        active={visible}
        {...(closePane ? { closePane } : {})}
        focused={focused}
        scopeKey={workspace.key}
        workspace={workspace}
        registry={registry}
        key={workspace.key}
      />
    )
  }
  ctx.clientWorkspaceLayout.registerPaneKind(ctx, {
    id: 'canvas',
    label: 'Canvas',
    description: 'Free-form plugin pages with persistent tabs',
    shortcut: 'v',
    icon: PanelsTopLeft,
    renderer: CanvasPane,
  })
  ctx.clientUi.registerStyle(ctx, 'canvas', String(styles))
  return () => registry.dispose()
}

canvasClient.inject = ['clientUi', 'clientWorkspaceLayout']
canvasClient.provide = 'clientCanvas'

export default canvasClient
