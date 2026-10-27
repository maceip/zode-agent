export const CONVERSATION_FOLLOW_LATEST_EVENT = 'alto:conversation-follow-latest'

export function requestConversationFollowLatest(origin: HTMLElement): void {
  const feed = origin
    .closest<HTMLElement>('.workspace-chat-pane, main')
    ?.querySelector<HTMLElement>('.conversation-feed')
  feed?.dispatchEvent(new Event(CONVERSATION_FOLLOW_LATEST_EVENT))
}

export interface ConversationScrollPlan {
  target: 'top' | 'bottom'
  behavior: ScrollBehavior
}

export function conversationScrollPlan(
  hasContent: boolean,
  animate: boolean,
): ConversationScrollPlan {
  if (!hasContent) return { target: 'top', behavior: 'auto' }
  return {
    target: 'bottom',
    behavior: animate ? 'smooth' : 'auto',
  }
}

export function conversationAtBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 2,
): boolean {
  return scrollHeight <= clientHeight
    || scrollHeight - scrollTop - clientHeight <= threshold
}

export function conversationAwayFromBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 80,
): boolean {
  return scrollHeight > clientHeight
    && scrollHeight - scrollTop - clientHeight > threshold
}

export function conversationShouldReleaseFollow(
  awayFromBottom: boolean,
  userInitiated: boolean,
): boolean {
  return awayFromBottom && userInitiated
}

export function conversationFollowingAfterScroll(
  following: boolean,
  awayFromBottom: boolean,
  atBottom: boolean,
  userInitiated: boolean,
): boolean {
  if (conversationShouldReleaseFollow(awayFromBottom, userInitiated)) return false
  if (atBottom) return true
  return following
}

export function conversationShouldScrollUpdate(
  threadChanged: boolean,
  turnStarted: boolean,
  turnCompleted: boolean,
  hasContent: boolean,
  followLatest: boolean,
): boolean {
  // The reveal controller drains the last buffered characters. Completing a
  // turn does not create a second, immediate scroll operation.
  return !turnCompleted && (threadChanged || turnStarted || !hasContent || followLatest)
}

interface PendingScroll {
  target: 'top' | 'bottom'
  behavior: ScrollBehavior
  force: boolean
}

/**
 * Sole owner of conversation scroll writes. Transport events, Markdown
 * playback, and ResizeObserver callbacks may request a follow, but only this
 * controller decides whether to write and coalesces requests to one frame.
 */
export class ConversationScrollController {
  private following = true
  private userIntentUntil = 0
  private frame: number | undefined
  private pending: PendingScroll | undefined
  private resizeObserver: ResizeObserver | undefined

  constructor(
    private readonly feed: HTMLElement,
    private readonly content: HTMLElement,
    private readonly setJumpVisible: (visible: boolean) => void,
  ) {}

  start(): void {
    this.feed.addEventListener('scroll', this.onScroll, { passive: true })
    this.feed.addEventListener('wheel', this.onWheel, { passive: true })
    this.feed.addEventListener('touchstart', this.onUserIntent, { passive: true })
    this.feed.addEventListener('pointerdown', this.onUserIntent, { passive: true })
    this.feed.addEventListener('keydown', this.onKeyDown)
    this.feed.addEventListener(CONVERSATION_FOLLOW_LATEST_EVENT, this.onFollowLatest)
    this.resizeObserver = new ResizeObserver(this.onResize)
    this.resizeObserver.observe(this.content)
    this.refresh()
  }

  dispose(): void {
    this.feed.removeEventListener('scroll', this.onScroll)
    this.feed.removeEventListener('wheel', this.onWheel)
    this.feed.removeEventListener('touchstart', this.onUserIntent)
    this.feed.removeEventListener('pointerdown', this.onUserIntent)
    this.feed.removeEventListener('keydown', this.onKeyDown)
    this.feed.removeEventListener(CONVERSATION_FOLLOW_LATEST_EVENT, this.onFollowLatest)
    this.resizeObserver?.disconnect()
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame)
  }

  isFollowing(): boolean {
    return this.following
  }

  refresh(): void {
    const away = this.awayFromBottom()
    this.setJumpVisible(away && !this.following)
  }

  follow(
    target: PendingScroll['target'] = 'bottom',
    behavior: ScrollBehavior = 'auto',
    force = false,
  ): void {
    if (force) {
      this.following = true
      this.setJumpVisible(false)
    } else if (!this.following) {
      this.refresh()
      return
    }
    this.pending = { target, behavior, force: force || Boolean(this.pending?.force) }
    if (this.frame !== undefined) return
    this.frame = window.requestAnimationFrame(() => {
      this.frame = undefined
      const pending = this.pending
      this.pending = undefined
      if (!pending || (!pending.force && !this.following)) return
      const top = pending.target === 'top' ? 0 : this.feed.scrollHeight
      this.feed.scrollTo({ top, behavior: pending.behavior })
      if (pending.behavior === 'auto') this.refresh()
    })
  }

  jumpToLatest(): void {
    this.follow('bottom', 'smooth', true)
  }

  private atBottom(): boolean {
    return conversationAtBottom(
      this.feed.scrollHeight,
      this.feed.scrollTop,
      this.feed.clientHeight,
    )
  }

  private awayFromBottom(): boolean {
    return conversationAwayFromBottom(
      this.feed.scrollHeight,
      this.feed.scrollTop,
      this.feed.clientHeight,
    )
  }

  private readonly onFollowLatest = (): void => {
    this.jumpToLatest()
  }

  private readonly onUserIntent = (): void => {
    this.userIntentUntil = window.performance.now() + 1_000
  }

  private readonly onWheel = (event: WheelEvent): void => {
    this.onUserIntent()
    if (event.deltaY < 0) this.following = false
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      this.onUserIntent()
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home' || (event.key === ' ' && event.shiftKey)) {
        this.following = false
      }
    }
  }

  private readonly onScroll = (): void => {
    const away = this.awayFromBottom()
    const userInitiated = window.performance.now() <= this.userIntentUntil
    this.following = conversationFollowingAfterScroll(
      this.following,
      away,
      this.atBottom(),
      userInitiated,
    )
    this.setJumpVisible(away && !this.following)
  }

  private readonly onResize = (): void => {
    if (this.following) this.follow()
    else this.refresh()
  }
}
