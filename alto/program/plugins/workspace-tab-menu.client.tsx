import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { clientStyles, type ClientOverlays } from '../../src/client/plugin-api.js'
import type { WorkspaceTabAction } from './workspace-layout-api.js'
import type { WorkspaceView } from './workspace-layout-state.js'

export function WorkspaceTabActionMenu({ view, x, y, trigger, actions, overlays, rootRef, close }: {
  view: WorkspaceView; x: number; y: number; trigger: HTMLElement; actions: readonly WorkspaceTabAction[]
  overlays?: ClientOverlays | undefined; rootRef: RefObject<HTMLDivElement | null>; close(): void
}): ReactNode {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    overlays?.open('workspace-tab-actions')
    const outside = (event: PointerEvent): void => { if (!panel.current?.contains(event.target as Node)) close() }
    window.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('pointerdown', outside); overlays?.close('workspace-tab-actions') }
  }, [overlays, close])
  useLayoutEffect(() => {
    const place = (): void => {
      const node = panel.current, root = rootRef.current
      if (!node || !root) return
      const bounds = root.getBoundingClientRect(), box = node.getBoundingClientRect()
      node.style.left = Math.max(8, Math.min(x - bounds.left, bounds.width - box.width - 8)) + 'px'
      node.style.top = Math.max(8, Math.min(y - bounds.top + 4, bounds.height - box.height - 8)) + 'px'
    }
    place(); panel.current?.querySelector('button')?.focus()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [x, y, rootRef])
  if (!rootRef.current) return null
  return createPortal(<div ref={panel} className={clientStyles.floatingPanel + ' workspace-tab-action-menu'} role="menu" aria-label="Tab options"
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus() }
      const controls = [...(panel.current?.querySelectorAll('button') ?? [])]
      const direction = event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey) ? 1 : event.key === 'ArrowUp' || event.key === 'Tab' ? -1 : 0
      if (direction) { event.preventDefault(); controls[(controls.indexOf(document.activeElement as HTMLButtonElement) + direction + controls.length) % controls.length]?.focus() }
    }}>
    {actions.filter((action) => action.available(view)).map((action) => <button type="button" role="menuitem" key={action.id}
      onClick={() => { close(); action.run(view) }}>{action.label}</button>)}
  </div>, rootRef.current)
}
