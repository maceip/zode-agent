import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  ACTIVITY_REVEAL_EVENT,
  type ActivityItem,
} from './ui/activity.js'
import type {
  BrowserPlugin,
  ClientSurfaceProps,
} from '../../src/client/plugin-api.js'
import styles from './scrollback.css'
import type { ClientConversationService } from './session-api.js'

interface ScrollMetrics {
  top: number
  height: number
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  currentPrompt: number
}

export interface ScrollbackPreview {
  title: string
  detail?: string
}

export interface PromptPosition {
  index: number
  top: number
}

const emptyMetrics: ScrollMetrics = {
  top: 0,
  height: 0,
  scrollHeight: 0,
  clientHeight: 0,
  scrollTop: 0,
  currentPrompt: 0,
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function scrollbackTickCount(
  scrollHeight: number,
  clientHeight: number,
  promptCount: number,
): number {
  if (promptCount < 2 || clientHeight < 220) return 0
  const overflow = scrollHeight - clientHeight
  return overflow >= Math.max(480, clientHeight) ? promptCount : 0
}

export function scrollbackMarkerIndices(
  promptCount: number,
  clientHeight: number,
  currentPrompt: number,
): number[] {
  if (promptCount <= 0) return []
  const capacity = Math.max(3, Math.floor((clientHeight - 10) / 12))
  if (promptCount <= capacity) {
    return Array.from({ length: promptCount }, (_, index) => index)
  }

  const markers = Array.from(
    { length: capacity },
    (_, index) => Math.round(index * (promptCount - 1) / (capacity - 1)),
  )
  const current = clamp(Math.round(currentPrompt), 0, promptCount - 1)
  if (!markers.includes(current)) {
    let nearest = 1
    for (let index = 2; index < markers.length - 1; index += 1) {
      if (Math.abs(markers[index]! - current) < Math.abs(markers[nearest]! - current)) {
        nearest = index
      }
    }
    markers[nearest] = current
    markers.sort((left, right) => left - right)
  }
  return markers
}

export function scrollTopForPrompt(
  promptTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const maximum = Math.max(0, scrollHeight - clientHeight)
  return clamp(promptTop - 20, 0, maximum)
}

export function scrollbackTickWidth(index: number, focus?: number): number {
  if (focus === undefined) return 6
  const distance = Math.abs(index - focus)
  return Math.round(6 + 14 * Math.exp(-(distance ** 2) / 5.5))
}

function compactText(value: string, limit: number): string {
  const compact = value
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return compact.length > limit ? `${compact.slice(0, limit - 1).trimEnd()}…` : compact
}

export function scrollbackPreview(
  activities: readonly ActivityItem[],
  selectedIndex: number,
): ScrollbackPreview | undefined {
  const selected = activities[selectedIndex]
  if (!selected) return undefined
  let anchorIndex = selectedIndex
  while (anchorIndex > 0 && activities[anchorIndex]?.kind !== 'user') anchorIndex -= 1
  const anchor = activities[anchorIndex]?.kind === 'user'
    ? activities[anchorIndex]
    : selected
  if (!anchor) return undefined
  const nextPrompt = activities.findIndex(
    (activity, index) => index > anchorIndex && activity.kind === 'user',
  )
  const response = activities
    .slice(anchorIndex + 1, nextPrompt < 0 ? undefined : nextPrompt)
    .find((activity) => activity.kind === 'agent')
  const title = compactText(anchor.content || anchor.title, 108)
  const detail = compactText(response?.content ?? (anchor === selected ? '' : selected.content), 180)
  return {
    title: title || anchor.title,
    ...(detail && detail !== title ? { detail } : {}),
  }
}

function activityTops(
  feed: HTMLElement,
  activityIds: readonly string[],
): ReadonlyMap<string, number> {
  const wanted = new Set(activityIds)
  const tops = new Map<string, number>()
  if (!wanted.size) return tops
  const feedRect = feed.getBoundingClientRect()
  for (const card of feed.querySelectorAll<HTMLElement>('[data-activity-id]')) {
    const activityId = card.dataset.activityId
    if (!activityId || !wanted.has(activityId)) continue
    tops.set(
      activityId,
      card.getBoundingClientRect().top - feedRect.top + feed.scrollTop,
    )
    if (tops.size === wanted.size) break
  }
  return tops
}

function promptPositions(
  promptIds: readonly string[],
  tops: ReadonlyMap<string, number>,
): PromptPosition[] {
  return promptIds.flatMap((activityId, index) => {
    const top = tops.get(activityId)
    return top === undefined ? [] : [{ index, top }]
  })
}

export function currentPromptAt(
  positions: readonly PromptPosition[],
  focus: number,
): number {
  if (!positions.length) return 0
  let lower = 0
  let upper = positions.length - 1
  let current = positions[0]!.index
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2)
    const candidate = positions[middle]!
    if (candidate.top <= focus) {
      current = candidate.index
      lower = middle + 1
    } else {
      upper = middle - 1
    }
  }
  return current
}

function metricsEqual(left: ScrollMetrics, right: ScrollMetrics): boolean {
  return left.top === right.top
    && left.height === right.height
    && left.scrollHeight === right.scrollHeight
    && left.clientHeight === right.clientHeight
    && left.scrollTop === right.scrollTop
    && left.currentPrompt === right.currentPrompt
}

export function ScrollbackSurface({
  surface,
  session,
  paneId,
  visible = true,
}: ClientSurfaceProps & {
  session: ClientConversationService
  paneId?: string
  visible?: boolean
}): ReactNode {
  const frozen = useRef(session.snapshot())
  const subscribe = useMemo(
    () => visible ? session.subscribe : (_listener: () => void) => () => undefined,
    [session, visible],
  )
  const snapshot = useMemo(() => () => {
    if (visible) frozen.current = session.snapshot()
    return frozen.current
  }, [session, visible])
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  const feedRef = useRef<HTMLElement | null>(null)
  const promptTopsRef = useRef<ReadonlyMap<string, number>>(new Map())
  const [metrics, setMetrics] = useState<ScrollMetrics>(emptyMetrics)
  const [hovered, setHovered] = useState<{
    index: number
    markerTop: number
    preview?: ScrollbackPreview
  }>()
  const promptIndices = useMemo(() => state.activities.flatMap(
    (activity, index) => activity.kind === 'user' ? [index] : [],
  ), [state.activities])
  const promptIds = useMemo(() => promptIndices.flatMap((index) => (
    state.activities[index]?.id ?? []
  )), [promptIndices, state.activities])
  const promptIdsRef = useRef(promptIds)
  promptIdsRef.current = promptIds

  useEffect(() => {
    if (!visible || promptIdsRef.current.length < 2) return
    const scope = paneId
      ? [...document.querySelectorAll<HTMLElement>('[data-workspace-pane-id]')]
          .find((candidate) => candidate.dataset.workspacePaneId === paneId)
      : document.querySelector<HTMLElement>('main')
    const feed = scope?.querySelector<HTMLElement>('.conversation-feed')
    const parent = paneId
      ? feed?.closest<HTMLElement>('.workspace-pane-conversation') ?? scope
      : feed?.closest<HTMLElement>('main')
    if (!parent || !feed) return
    feedRef.current = feed
    let frame: number | undefined

    const measure = (): void => {
      frame = undefined
      const parentRect = parent.getBoundingClientRect()
      const feedRect = feed.getBoundingClientRect()
      const tops = activityTops(feed, promptIdsRef.current)
      promptTopsRef.current = tops
      const focus = feed.scrollTop + Math.min(120, feed.clientHeight * 0.25)
      const next: ScrollMetrics = {
        top: Math.round(feedRect.top - parentRect.top),
        height: Math.round(feedRect.height),
        scrollHeight: feed.scrollHeight,
        clientHeight: feed.clientHeight,
        scrollTop: Math.round(feed.scrollTop),
        currentPrompt: currentPromptAt(
          promptPositions(promptIdsRef.current, tops),
          focus,
        ),
      }
      setMetrics((current) => metricsEqual(current, next) ? current : next)
    }
    const schedule = (): void => {
      if (frame === undefined) frame = window.requestAnimationFrame(measure)
    }
    const resize = new ResizeObserver(schedule)
    const mutation = new MutationObserver(schedule)
    const content = feed.querySelector<HTMLElement>('.conversation-feed-content')
    resize.observe(feed)
    resize.observe(parent)
    if (content) resize.observe(content)
    mutation.observe(feed, { childList: true, subtree: true })
    feed.addEventListener('scroll', schedule, { passive: true })
    schedule()

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      resize.disconnect()
      mutation.disconnect()
      feed.removeEventListener('scroll', schedule)
      feedRef.current = null
    }
  }, [paneId, promptIds.length, state.harness?.program.revision, state.threadId, visible])

  useEffect(() => setHovered(undefined), [state.activities.length, state.threadId])

  const promptCount = scrollbackTickCount(
    metrics.scrollHeight,
    metrics.clientHeight,
    promptIndices.length,
  )
  const markerIndices = promptCount
    ? scrollbackMarkerIndices(promptCount, metrics.clientHeight, metrics.currentPrompt)
    : []
  const current = markerIndices.indexOf(metrics.currentPrompt)

  if (!markerIndices.length) return null

  const showPreview = (index: number, marker: HTMLElement): void => {
    const activityIndex = promptIndices[markerIndices[index]!]
    if (activityIndex === undefined) return
    const preview = scrollbackPreview(state.activities, activityIndex)
    setHovered({
      index,
      markerTop: marker.offsetTop + marker.offsetHeight / 2,
      ...(preview ? { preview } : {}),
    })
  }

  const jumpTo = (index: number): void => {
    const feed = feedRef.current
    const activityIndex = promptIndices[markerIndices[index]!]
    const activityId = activityIndex === undefined
      ? undefined
      : state.activities[activityIndex]?.id
    if (!feed || !activityId) return
    const scroll = (): boolean => {
      let top = promptTopsRef.current.get(activityId)
      if (top === undefined) {
        const tops = activityTops(feed, promptIdsRef.current)
        promptTopsRef.current = tops
        top = tops.get(activityId)
      }
      if (top === undefined) return false
      feed.scrollTo({
        top: scrollTopForPrompt(top, feed.scrollHeight, feed.clientHeight),
        behavior: 'smooth',
      })
      return true
    }
    if (scroll()) return
    document.dispatchEvent(new CustomEvent(ACTIVITY_REVEAL_EVENT, {
      detail: { activityId },
    }))
    let attempts = 0
    const scrollWhenReady = (): void => {
      if (scroll() || attempts >= 12 || !feed.isConnected) return
      attempts += 1
      window.requestAnimationFrame(scrollWhenReady)
    }
    window.requestAnimationFrame(scrollWhenReady)
  }

  const previewTop = hovered
    ? clamp(
        hovered.markerTop - 44,
        6,
        Math.max(6, metrics.height - 92),
      )
    : 0

  return (
    <aside
      className="scrollback-minimap is-visible"
      aria-label={surface.label ?? 'Conversation scrollback'}
      style={{
        top: `${metrics.top}px`,
        height: `${metrics.height}px`,
      }}
    >
      <nav className="scrollback-track" aria-label={surface.label ?? 'Conversation scrollback'} onMouseLeave={() => setHovered(undefined)}>
        {markerIndices.map((promptIndex, index) => (
          <button
            className="scrollback-tick"
            type="button"
            style={{
              '--scrollback-tick-width': `${scrollbackTickWidth(index, hovered?.index)}px`,
            } as CSSProperties}
            aria-label={`Jump to prompt ${promptIndex + 1}`}
            aria-current={index === current ? 'location' : undefined}
            onFocus={(event) => showPreview(index, event.currentTarget)}
            onMouseEnter={(event) => showPreview(index, event.currentTarget)}
            onClick={() => jumpTo(index)}
            key={promptIndex}
          />
        ))}
      </nav>
      {hovered?.preview && (
        <div
          className="scrollback-preview"
          style={{ top: `${previewTop}px` } as CSSProperties}
          role="status"
        >
          <strong>{hovered.preview.title}</strong>
          {hovered.preview.detail && <p>{hovered.preview.detail}</p>}
        </div>
      )}
    </aside>
  )
}

const scrollbackClient: BrowserPlugin = (ctx) => {
  const session = ctx.clientConversation
  const BoundScrollbackSurface = (props: ClientSurfaceProps) => (
    <ScrollbackSurface {...props} session={session} />
  )
  ctx.clientUi.registerSurface(ctx, 'default-scrollback', BoundScrollbackSurface)
  ctx.clientUi.registerStyle(ctx, 'scrollback', String(styles))
}

scrollbackClient.inject = ['clientUi', 'clientConversation']
scrollbackClient.resources = { provides: { surfaces: ['default-scrollback'] } }

export default scrollbackClient
