import {
  Check,
  Search,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  clientStyles,
  type BrowserPlugin,
  type ClientOverlays,
  type ClientHostService,
} from '../../src/client/plugin-api.js'
import { SEARCH_PREVIEW, searchSurface } from './search-api.js'
import { latestSearchPreview } from './search-preview.js'
import { isRecord, threadRecencyAt, type ThreadSummary } from '../../src/shared/protocol.js'
import type { ClientWorkspaceLayoutService, WorkspaceTabTarget } from './workspace-layout-api.js'
import type { ClientSessionService, ClientSessionSnapshot } from './session-api.js'
import type {
  ClientThreadStatusService,
  ClientThreadStatusSnapshot,
  ThreadWorkStatus,
} from './thread-status-api.js'
import {
  OptionalThreadStatusService,
  threadWorkStatus,
} from './thread-status-api.js'
import { ConversationPaneOverlay } from './ui/conversation-overlay.js'
import { useStoreSelector } from './ui/store-selector.js'
import { ThreadStatusIndicator } from './ui/thread-status.js'
import styles from './search.css'

export interface SearchItem {
  id: string
  label: string
  detail?: string
  preview?: ReactNode
  keywords?: string
  active?: boolean
  status?: ThreadWorkStatus | undefined
  disabled?: boolean
  onSelect: () => void
}

export function isSearchShortcut(event: Pick<globalThis.KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey'>): boolean {
  return event.key.toLocaleLowerCase() === 'k'
    && (event.metaKey || event.ctrlKey)
    && !event.shiftKey
}

export function filterSearchItems(
  items: SearchItem[],
  query: string,
): SearchItem[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((item) => {
    if (!terms.length) return true
    const searchable = `${item.label} ${item.detail ?? ''} ${item.keywords ?? ''}`.toLocaleLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
}

export function searchThreads(
  threads: readonly ThreadSummary[],
  tabs: readonly WorkspaceTabTarget[],
  status: ClientThreadStatusSnapshot,
  currentThreadId?: string,
): ThreadSummary[] {
  const candidates = new Map<string, ThreadSummary>()
  for (const thread of [...tabs.flatMap((tab) => tab.threads ?? []), ...threads]) {
    const previous = candidates.get(thread.id)
    if (!previous || thread.updatedAt >= previous.updatedAt) candidates.set(thread.id, thread)
  }
  const unread = new Map(status.finished.filter((id) => id !== currentThreadId).map((id, index) => [id, index]))
  return [...candidates.values()].sort((left, right) => {
    const leftUnread = unread.get(left.id), rightUnread = unread.get(right.id)
    if (leftUnread !== undefined || rightUnread !== undefined) {
      return (leftUnread ?? Infinity) - (rightUnread ?? Infinity)
    }
    return threadRecencyAt(right) - threadRecencyAt(left) || left.id.localeCompare(right.id)
  })
}

export function openSearchThread(layout: ClientWorkspaceLayoutService, thread: ThreadSummary): void {
  if (!layout.focusThread(thread.id)) layout.newTab(undefined, thread)
}

const noSubscription = (): (() => void) => () => {}

function ChatPreview({ thread, session, host }: {
  thread: ThreadSummary
  session: ClientSessionService | undefined
  host: ClientHostService
}): ReactNode {
  const live = useSyncExternalStore(session?.subscribe ?? noSubscription, () => {
    const state = session?.snapshot()
    return state?.threadId === thread.id ? latestSearchPreview(state.activities) : ''
  })
  const [saved, setSaved] = useState<{ id: string; updatedAt: number; text: string }>()
  useEffect(() => {
    if (live) return
    let active = true
    void host.call(SEARCH_PREVIEW, { threadId: thread.id }).then((value) => {
      if (active && isRecord(value) && typeof value.preview === 'string') {
        setSaved({ id: thread.id, updatedAt: thread.updatedAt, text: value.preview })
      }
    }).catch(() => {})
    return () => { active = false }
  }, [host, thread.id, thread.updatedAt, live])
  const stored = saved?.id === thread.id && saved.updatedAt === thread.updatedAt ? saved.text : ''
  return <span>{live || stored || thread.cwd}</span>
}

function SearchPalette({
  open,
  label,
  placeholder,
  items,
  onClose,
}: {
  open: boolean
  label: string
  placeholder: string
  items: SearchItem[]
  onClose: () => void
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const results = useMemo(
    () => filterSearchItems(items, query),
    [items, query],
  )

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => setActiveIndex(0), [query])

  useEffect(() => {
    if (!open) return
    const list = listRef.current
    const active = resultRefs.current[activeIndex]
    if (!list || !active) return
    const listRect = list.getBoundingClientRect()
    const itemRect = active.getBoundingClientRect()
    if (itemRect.top < listRect.top) {
      list.scrollTop -= listRect.top - itemRect.top
    } else if (itemRect.bottom > listRect.bottom) {
      list.scrollTop += itemRect.bottom - listRect.bottom
    }
  }, [activeIndex, open, results])

  if (!open) return null

  const select = (item: SearchItem | undefined): void => {
    if (!item || item.disabled) return
    onClose()
    item.onSelect()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => results.length ? (current + 1) % results.length : 0)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => results.length
        ? (current - 1 + results.length) % results.length
        : 0)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      select(results[activeIndex])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <ConversationPaneOverlay className={`${clientStyles.overlayLayer} search-backdrop`} onMouseDown={onClose}>
      <section
        className={`${clientStyles.floatingPanel} search-palette`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-palette-input">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            aria-label={label}
            placeholder={placeholder}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div ref={listRef} className="search-results" role="listbox" aria-label="Search results">
          {results.map((item, index) => (
            <button
              ref={(node) => { resultRefs.current[index] = node }}
              className={`search-result ${index === activeIndex ? 'active' : ''}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              disabled={item.disabled}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(item)}
              key={item.id}
            >
              <span className="search-result-copy">
                <strong>{item.label}</strong>
                {item.preview ?? (item.detail && <span>{item.detail}</span>)}
              </span>
              <span className="search-result-meta">
                <ThreadStatusIndicator status={item.status} />
                {item.active && <Check className="search-result-check" size={15} />}
              </span>
            </button>
          ))}
          {!results.length && <div className="search-empty">No matching conversations.</div>}
        </div>
      </section>
    </ConversationPaneOverlay>
  )
}

interface SearchSessionSnapshot {
  threadId?: string
}

function searchSessionSnapshot(
  state: ClientSessionSnapshot,
): SearchSessionSnapshot {
  return {
    ...(state.threadId ? { threadId: state.threadId } : {}),
  }
}

function searchSessionSnapshotEqual(
  left: SearchSessionSnapshot,
  right: SearchSessionSnapshot,
): boolean {
  return left.threadId === right.threadId
}

function OpenSearchSurface({
  surface,
  session,
  threadStatus,
  overlays,
  layout,
  host,
}: {
  surface: typeof searchSurface
  session: ClientSessionService
  threadStatus: ClientThreadStatusService
  overlays: ClientOverlays
  layout: ClientWorkspaceLayoutService
  host: ClientHostService
}): ReactNode {
  const state = useStoreSelector(session, searchSessionSnapshot, searchSessionSnapshotEqual)
  const statusState = useSyncExternalStore(threadStatus.subscribe, threadStatus.snapshot)
  useSyncExternalStore(layout.subscribe, layout.snapshot)
  const tabs = layout.tabs()
  const threads = searchThreads([], tabs, statusState, state.threadId)
  const panes = layout.paneTargets()
  const threadItems = threads.map((thread): SearchItem => {
    const tab = tabs.find((tab) => tab.threadIds.includes(thread.id))
    const conversationTitle = thread.title.trim()
    const title = conversationTitle && conversationTitle !== 'Untitled conversation'
      ? conversationTitle
      : tab?.title || conversationTitle || 'Untitled conversation'
    return {
      id: `thread:${thread.id}`,
      label: title,
      detail: thread.preview || thread.cwd,
      preview: <ChatPreview thread={thread} host={host} session={panes.find((pane) => pane.session.snapshot().threadId === thread.id)?.session} />,
      keywords: `${thread.cwd} ${thread.title}`,
      active: thread.id === state.threadId,
      status: threadWorkStatus(statusState, thread.id),
      onSelect: () => {
        openSearchThread(layout, thread)
        threadStatus.acknowledge(thread.id)
      },
    }
  })
  const unread = (item: SearchItem): boolean => item.status === 'finished' && !item.active
  const label = surface.label ?? 'Search'
  const placeholder = surface.kind === 'search'
    ? surface.placeholder ?? 'Search conversations…'
    : 'Search conversations…'
  const items: SearchItem[] = [
    ...threadItems.filter(unread),
    ...threadItems.filter((item) => !unread(item)),
  ]

  return (
    <SearchPalette
      open
      label={label}
      placeholder={placeholder}
      items={items}
      onClose={() => overlays.close('search')}
    />
  )
}

function SearchSurface({
  surface,
  session,
  threadStatus,
  overlays,
  layout,
  host,
}: {
  surface: typeof searchSurface
  session: ClientSessionService
  threadStatus: ClientThreadStatusService
  overlays: ClientOverlays
  layout: ClientWorkspaceLayoutService
  host: ClientHostService
}): ReactNode {
  const activeOverlay = useSyncExternalStore(overlays.subscribe, overlays.snapshot)
  if (activeOverlay !== 'search') return null
  return (
    <OpenSearchSurface
      surface={surface}
      session={session}
      threadStatus={threadStatus}
      overlays={overlays}
      layout={layout}
      host={host}
    />
  )
}

const searchClient: BrowserPlugin = (ctx) => {
  const session = ctx.clientSession
  const threadStatus = new OptionalThreadStatusService(ctx)
  const overlays = ctx.clientUi.overlays
  ctx.effect(() => {
    const shortcut = (event: globalThis.KeyboardEvent): void => {
      if (!isSearchShortcut(event)) return
      event.preventDefault()
      if (!event.repeat) overlays.toggle('search')
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, 'search.shortcut')
  const BoundSearchRoot = () => (
    <SearchSurface
      surface={searchSurface}
      session={session}
      threadStatus={threadStatus}
      overlays={overlays}
      layout={ctx.clientWorkspaceLayout}
      host={ctx.clientHost}
    />
  )
  ctx.clientUi.registerRoot(ctx, 'default-search', BoundSearchRoot)
  ctx.clientUi.registerStyle(ctx, 'default-search', String(styles))
  return () => threadStatus.dispose()
}

searchClient.inject = ['clientUi', 'clientSession', 'clientWorkspaceLayout', 'clientHost']
searchClient.resources = { provides: { roots: ['default-search'] } }

export default searchClient
