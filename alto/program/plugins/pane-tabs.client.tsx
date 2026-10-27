import { Plus, X } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import {
  PANE_TABS_HOTKEY_ACTIONS,
  type ClientPaneTabsService,
  type PaneTab,
  type PaneTabsHost,
  type PaneTabDropPosition,
  type PaneTabsProps,
} from './pane-tabs-api.js'
import styles from './pane-tabs.css'

interface DropTarget {
  id: string
  position: PaneTabDropPosition
}

interface PointerDrag {
  tab: PaneTab
  pointerId: number
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  width: number
  height: number
  moved: boolean
}

interface DragPreview {
  tab: PaneTab
  x: number
  y: number
  width: number
  height: number
}

function tabDropTarget(
  clientX: number,
  clientY: number,
  owner: HTMLElement | null,
): DropTarget | undefined {
  const tab = document.elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>('[data-pane-tab-id]')
  const id = tab?.dataset.paneTabId
  if (!owner || !tab || !id || !owner.contains(tab)) return undefined
  const bounds = tab.getBoundingClientRect()
  return {
    id,
    position: clientX < bounds.left + bounds.width / 2 ? 'before' : 'after',
  }
}

function PaneTabs({
  tabs,
  activeId,
  label,
  createLabel,
  minimumTabs = 1,
  activate,
  create,
  close,
  closeLast,
  closeLastLabel = 'Close pane',
  move,
  registry,
}: PaneTabsProps & { registry: PaneTabsRegistry }) {
  const root = useRef<HTMLDivElement>(null)
  const createRef = useRef(create)
  const pointerDrag = useRef<PointerDrag | undefined>(undefined)
  const pendingDrop = useRef<DropTarget | undefined>(undefined)
  const suppressClick = useRef(false)
  const [draggingId, setDraggingId] = useState<string>()
  const [dropTarget, setDropTarget] = useState<DropTarget>()
  const [dragPreview, setDragPreview] = useState<DragPreview>()

  createRef.current = create

  useEffect(() => registry.registerHost({
    active: () => {
      const element = root.current
      const pane = element?.closest<HTMLElement>('[data-workspace-pane-id]')
      return Boolean(
        element?.isConnected
        && pane?.classList.contains('is-focused')
        && !pane.closest('[hidden]'),
      )
    },
    create: () => createRef.current(),
  }).dispose, [registry])

  const clearDrag = (): void => {
    pointerDrag.current = undefined
    pendingDrop.current = undefined
    setDraggingId(undefined)
    setDropTarget(undefined)
    setDragPreview(undefined)
  }

  const startDrag = (event: PointerEvent<HTMLDivElement>, tab: PaneTab): void => {
    if (
      !move
      || event.button !== 0
      || (event.target as HTMLElement).closest('.pane-tab-close')
    ) return
    suppressClick.current = false
    const bounds = event.currentTarget.getBoundingClientRect()
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerDrag.current = {
      tab,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
      moved: false,
    }
  }

  const updateDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = pointerDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return
      drag.moved = true
      setDraggingId(drag.tab.id)
    }
    event.preventDefault()
    setDragPreview({
      tab: drag.tab,
      x: event.clientX - drag.offsetX,
      y: event.clientY - drag.offsetY,
      width: drag.width,
      height: drag.height,
    })
    const target = tabDropTarget(event.clientX, event.clientY, root.current)
    const next = target?.id === drag.tab.id ? undefined : target
    pendingDrop.current = next
    setDropTarget(next)
  }

  const finishDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = pointerDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.moved && pendingDrop.current) {
      move?.(drag.tab.id, pendingDrop.current.id, pendingDrop.current.position)
    } else if (!drag.moved) {
      activate(drag.tab.id)
    }
    suppressClick.current = drag.moved
    clearDrag()
  }

  const closeTab = (id: string): void => {
    if (tabs.length > minimumTabs) close(id)
    else closeLast?.()
  }

  const closeWithMiddleClick = (event: MouseEvent<HTMLElement>, id: string): void => {
    if (event.button !== 1 || (tabs.length <= minimumTabs && !closeLast)) return
    event.preventDefault()
    closeTab(id)
  }

  return (
    <>
      <div className="pane-tabs" role="tablist" aria-label={label} ref={root}>
        {tabs.map((tab) => {
          const active = tab.id === activeId
          const target = dropTarget?.id === tab.id ? dropTarget.position : undefined
          const Icon = tab.icon
          return (
            <div
              className={[
                'pane-tab',
                active ? 'active' : '',
                draggingId === tab.id ? 'dragging' : '',
                target ? `drop-${target}` : '',
              ].filter(Boolean).join(' ')}
              data-pane-tab-id={tab.id}
              onPointerDown={(event) => startDrag(event, tab)}
              onPointerMove={updateDrag}
              onPointerUp={finishDrag}
              onPointerCancel={clearDrag}
              onClickCapture={(event) => {
                if (!suppressClick.current) return
                suppressClick.current = false
                event.preventDefault()
                event.stopPropagation()
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault()
              }}
              onAuxClick={(event) => closeWithMiddleClick(event, tab.id)}
              key={tab.id}
            >
              <button
                className="pane-tab-select"
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.title}
                onClick={() => activate(tab.id)}
              >
                {Icon ? <Icon className="pane-tab-icon" size={13} /> : null}
                <span>{tab.title}</span>
              </button>
              {(tabs.length > minimumTabs || closeLast) && (
                <button
                  className="pane-tab-close"
                  type="button"
                  aria-label={tabs.length > minimumTabs ? `Close ${tab.title}` : closeLastLabel}
                  title={tabs.length > minimumTabs ? `Close ${tab.title}` : closeLastLabel}
                  onClick={() => closeTab(tab.id)}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}
        <button
          className="pane-tab-new"
          type="button"
          data-hotkey-action={PANE_TABS_HOTKEY_ACTIONS.create}
          aria-label={createLabel}
          title={createLabel}
          onClick={create}
        >
          <Plus size={14} />
        </button>
      </div>
      {dragPreview && createPortal(
        <div
          className="pane-tab-drag-preview"
          style={{
            left: `${dragPreview.x}px`,
            top: `${dragPreview.y}px`,
            width: `${dragPreview.width}px`,
            height: `${dragPreview.height}px`,
          }}
          aria-hidden="true"
        >
          {dragPreview.tab.icon
            ? <dragPreview.tab.icon className="pane-tab-icon" size={13} />
            : null}
          <span>{dragPreview.tab.title}</span>
          <X size={12} />
        </div>,
        document.body,
      )}
    </>
  )
}

export class PaneTabsRegistry implements ClientPaneTabsService {
  readonly renderer: ComponentType<PaneTabsProps>
  private readonly hosts = new Set<PaneTabsHost>()

  constructor() {
    this.renderer = (props) => <PaneTabs {...props} registry={this} />
  }

  canCreateInActivePane(): boolean {
    return this.activeHost() !== undefined
  }

  createInActivePane(): boolean {
    const host = this.activeHost()
    if (!host) return false
    host.create()
    return true
  }

  registerHost(host: PaneTabsHost) {
    this.hosts.add(host)
    return {
      dispose: () => {
        this.hosts.delete(host)
      },
    }
  }

  private activeHost(): PaneTabsHost | undefined {
    return [...this.hosts].find((host) => host.active())
  }
}

const paneTabs: BrowserPlugin = (ctx) => {
  const service = new PaneTabsRegistry()
  ctx.provide('clientPaneTabs', service)
  ctx.clientUi.registerStyle(ctx, 'pane-tabs', String(styles))
}

paneTabs.inject = ['clientUi', 'clientWorkspaceLayout']
paneTabs.provide = 'clientPaneTabs'

export default paneTabs
