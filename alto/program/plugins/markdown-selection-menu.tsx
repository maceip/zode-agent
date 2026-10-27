import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { clientStyles } from '../../src/client/plugin-api.js'
import { selectedMarkdown, type MarkdownSelection } from './markdown-selection.js'

export function MarkdownSelectionMenu({ rootRef, paneRef, scrollRef, enabled, onAdd, onEdit }: {
  rootRef: RefObject<HTMLDivElement | null>
  paneRef: RefObject<HTMLElement | null>
  scrollRef: RefObject<HTMLDivElement | null>
  enabled: boolean
  onAdd(selection: MarkdownSelection): void
  onEdit(selection: MarkdownSelection): void
}): ReactNode {
  const [selection, setSelection] = useState<MarkdownSelection>()
  const selectionRef = useRef<MarkdownSelection | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement>(null)
  const update = (next: MarkdownSelection | undefined): void => { selectionRef.current = next; setSelection(next) }

  useEffect(() => {
    update(undefined)
    if (!enabled) return
    let dragging = false
    let frame = 0
    const sync = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (dragging || menuRef.current?.contains(document.activeElement)) return
        update(rootRef.current ? selectedMarkdown(rootRef.current) : undefined)
      })
    }
    const down = (event: PointerEvent): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      dragging = event.target instanceof Node && !!rootRef.current?.contains(event.target)
      update(undefined)
    }
    const up = (event: PointerEvent): void => {
      const inside = event.target instanceof Node && !!rootRef.current?.contains(event.target)
      const selectedHere = dragging
      dragging = false
      if (inside || selectedHere) sync()
    }
    const key = (event: KeyboardEvent): void => {
      if (!selectionRef.current) return
      if (event.key === 'Escape') {
        event.preventDefault()
        update(undefined)
        window.getSelection()?.removeAllRanges()
        rootRef.current?.focus({ preventScroll: true })
      } else if (event.key === 'Tab' && !event.shiftKey && !menuRef.current?.contains(document.activeElement)
        && rootRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
      }
    }
    document.addEventListener('selectionchange', sync)
    document.addEventListener('pointerdown', down)
    document.addEventListener('pointerup', up)
    document.addEventListener('keydown', key)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', sync)
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('keydown', key)
    }
  }, [enabled, rootRef])

  useLayoutEffect(() => {
    const menu = menuRef.current
    const pane = paneRef.current
    const scroll = scrollRef.current
    if (!menu || !pane || !scroll || !selection || !enabled) return
    const position = (): void => {
      const bounds = pane.getBoundingClientRect()
      const viewport = scroll.getBoundingClientRect()
      const rect = [...selection.range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0
        && rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right)
      if (!rect) { menu.style.visibility = 'hidden'; return }
      const gap = parseFloat(getComputedStyle(pane).getPropertyValue('--space-2')) || 8
      const width = menu.offsetWidth
      const height = menu.offsetHeight
      const left = Math.max(viewport.left + gap, Math.min(rect.left + rect.width / 2 - width / 2, viewport.right - width - gap))
      const top = rect.top - height - gap >= viewport.top
        ? rect.top - height - gap
        : Math.min(rect.bottom + gap, viewport.bottom - height - gap)
      menu.style.left = `${left - bounds.left}px`
      menu.style.top = `${Math.max(viewport.top, top) - bounds.top}px`
      menu.style.visibility = 'visible'
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(pane)
    observer.observe(scroll)
    window.addEventListener('scroll', position, true)
    window.addEventListener('resize', position)
    return () => { observer.disconnect(); window.removeEventListener('scroll', position, true); window.removeEventListener('resize', position) }
  }, [selection, enabled, paneRef, scrollRef])

  const act = (action: (selection: MarkdownSelection) => void): void => {
    const current = selectionRef.current
    if (!current) return
    update(undefined)
    action(current)
  }
  if (!enabled || !selection) return null
  return <div ref={menuRef} role="toolbar" aria-label="Selected text" className={`${clientStyles.floatingPanel} markdown-selection-menu`}
    onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()}>
    <button type="button" className={clientStyles.button} onClick={() => act(onAdd)}>Add to chat</button>
    <button type="button" className={clientStyles.button} onClick={() => act(onEdit)}>Edit</button>
  </div>
}
