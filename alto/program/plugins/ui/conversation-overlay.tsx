import {
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

const CONVERSATION_PANE = '[data-shell-node="workspace"] > main'
const OVERLAY_HOST = '.shell-kernel'

export function conversationPaneBounds(
  left: number,
  width: number,
  viewportWidth: number,
): { left: number; width: number } {
  const viewport = Math.max(0, viewportWidth)
  const visibleLeft = Math.max(0, Math.min(viewport, left))
  const visibleRight = Math.max(
    visibleLeft,
    Math.min(viewport, left + Math.max(0, width)),
  )
  return { left: visibleLeft, width: visibleRight - visibleLeft }
}

/**
 * Keeps a fixed overlay inside the workspace without inheriting a pane or
 * header's stacking context. Native pane surfaces are hidden separately while
 * an app overlay is open.
 */
export function ConversationPaneOverlay({
  children,
  ...props
}: ComponentPropsWithoutRef<'div'>): ReactNode {
  const overlayRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const overlay = overlayRef.current
    const conversation = document.querySelector<HTMLElement>(CONVERSATION_PANE)
    if (!overlay || !conversation) return

    let frame: number | undefined
    const sync = (): void => {
      const rect = conversation.getBoundingClientRect()
      const pane = conversationPaneBounds(rect.left, rect.width, window.innerWidth)
      overlay.style.left = `${pane.left}px`
      overlay.style.width = `${pane.width}px`
    }
    const schedule = (): void => {
      if (frame !== undefined) return
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        sync()
      })
    }

    sync()
    const observer = new ResizeObserver(schedule)
    observer.observe(conversation)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [])

  const overlay = <div {...props} ref={overlayRef}>{children}</div>
  return createPortal(
    overlay,
    document.querySelector<HTMLElement>(OVERLAY_HOST) ?? document.body,
  )
}
