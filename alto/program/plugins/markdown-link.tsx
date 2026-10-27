import { useId, useLayoutEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clientStyles } from '../../src/client/plugin-api.js'

export function MarkdownLink({
  preview,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { preview?: string | undefined }): ReactNode {
  const anchorRef = useRef<HTMLAnchorElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const previewId = useId()
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const tooltip = previewRef.current
    if (!open || !preview || !anchor || !tooltip) return
    const view = anchor.ownerDocument.defaultView
    if (!view) return

    const bounds = anchor.getBoundingClientRect()
    const inset = 18
    const gap = 7
    const width = tooltip.offsetWidth
    const height = tooltip.offsetHeight
    const above = bounds.bottom + gap + height > view.innerHeight - inset
    const left = Math.max(inset, Math.min(bounds.left + (bounds.width - width) / 2, view.innerWidth - width - inset))
    const top = Math.max(inset, Math.min(above ? bounds.top - gap - height : bounds.bottom + gap, view.innerHeight - height - inset))
    tooltip.style.left = `${left}px`
    tooltip.style.top = `${top}px`
    tooltip.style.visibility = 'visible'

    const dismiss = (): void => setOpen(false)
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    // A portal stays on screen when its pane scrolls. Dismiss it before the
    // link moves away, including horizontal scrolling within a table.
    view.addEventListener('scroll', dismiss, true)
    view.addEventListener('resize', dismiss)
    view.addEventListener('blur', dismiss)
    view.addEventListener('pointerdown', dismiss)
    view.addEventListener('keydown', keydown)
    return () => {
      view.removeEventListener('scroll', dismiss, true)
      view.removeEventListener('resize', dismiss)
      view.removeEventListener('blur', dismiss)
      view.removeEventListener('pointerdown', dismiss)
      view.removeEventListener('keydown', keydown)
    }
  }, [open, preview])

  return <>
    <a
      {...props}
      ref={anchorRef}
      data-link-preview={preview}
      aria-describedby={[props['aria-describedby'], open && preview ? previewId : undefined].filter(Boolean).join(' ') || undefined}
      onPointerEnter={(event) => {
        props.onPointerEnter?.(event)
        if (preview && event.pointerType !== 'touch') setOpen(true)
      }}
      onPointerLeave={(event) => {
        props.onPointerLeave?.(event)
        if (!event.currentTarget.matches(':focus-visible')) setOpen(false)
      }}
      onFocus={(event) => {
        props.onFocus?.(event)
        if (preview && event.currentTarget.matches(':focus-visible')) setOpen(true)
      }}
      onBlur={(event) => {
        props.onBlur?.(event)
        setOpen(false)
      }}
    >
      {children}
    </a>
    {open && preview && anchorRef.current && createPortal(
      <div ref={previewRef} id={previewId} role="tooltip" className={`${clientStyles.floatingPanel} markdown-link-preview`}>
        {preview}
      </div>,
      anchorRef.current.ownerDocument.body,
    )}
  </>
}
