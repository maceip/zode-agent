import { ChevronRight, Check, Plus, X } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clientStyles, type BrowserPlugin, type ClientUiService } from '../../src/client/plugin-api.js'
import type { WorkspaceLayoutState } from './workspace-layout-state.js'
import type { WorkspaceTabStripProps } from './workspace-layout-api.js'
import { assignTabToGroup, createTabGroup, dropWorkspaceTabs, TAB_GROUP_COLORS, ungroupTabs, updateTabGroup, type WorkspaceTabDestination, type WorkspaceTabDrag } from './workspace-tab-groups.js'
import styles from './workspace-tab-groups.css'

type GroupMenu = { kind: 'tab' | 'group'; id: string; x: number; y: number }

function tabDragImage(tab: HTMLElement): HTMLCanvasElement {
  const bounds = tab.getBoundingClientRect()
  const style = getComputedStyle(tab)
  const canvas = document.createElement('canvas')
  canvas.className = 'workspace-tab-drag-image'
  canvas.width = Math.ceil(bounds.width)
  canvas.height = Math.ceil(bounds.height)
  document.body.append(canvas)
  const context = canvas.getContext('2d')!
  context.beginPath()
  context.roundRect(0, 0, canvas.width, canvas.height, canvas.height / 2)
  context.fillStyle = style.backgroundColor === 'rgba(0, 0, 0, 0)'
    ? getComputedStyle(canvas).color : style.backgroundColor
  context.fill()
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  context.fillStyle = style.color
  context.textBaseline = 'middle'
  const title = tab.querySelector('span')?.textContent ?? tab.getAttribute('aria-label') ?? ''
  let text = title
  while (text && context.measureText(text + (text === title ? '' : '…')).width > canvas.width - 24) text = text.slice(0, -1)
  context.fillText(text + (text === title ? '' : '…'), 12, canvas.height / 2)
  return canvas
}

export interface TabGroupHandlers {
  onContextMenu(event: MouseEvent<HTMLElement>): void
  onKeyDown(event: KeyboardEvent<HTMLElement>): void
}

interface DropPreview extends WorkspaceTabDestination {
  targetId?: string
  targetKind: 'tab' | 'group' | 'end'
  edge: 'before' | 'after' | 'inside'
}

function dropPreview(layout: WorkspaceLayoutState, source: WorkspaceTabDrag, strip: HTMLElement, target: EventTarget, x: number): DropPreview {
  const elements = [...strip.querySelectorAll<HTMLElement>('[data-workspace-tab]:not([inert]), [data-workspace-group]')]
  const hit = (target as Element).closest<HTMLElement>('[data-workspace-tab]:not([inert]), [data-workspace-group]')
    ?? elements.find((element) => element.getBoundingClientRect().left > x)
  if (!hit) return { targetKind: 'end', edge: 'after' }
  const groupId = hit.dataset.workspaceGroup
  const tab = layout.views.find((view) => view.id === hit.dataset.workspaceTab)
  const members = groupId ? layout.views.filter((view) => view.groupId === groupId) : tab ? [tab] : []
  if (!members.length) return { targetKind: 'end', edge: 'after' }
  const bounds = hit.getBoundingClientRect()
  const fraction = (x - bounds.left) / bounds.width
  if (source.kind === 'tab' && groupId && fraction >= 0.2) {
    const next = layout.views[layout.views.indexOf(members.at(-1)!) + 1]
    return { targetKind: 'group', targetId: groupId, edge: 'inside', groupId, ...(next ? { beforeId: next.id } : {}) }
  }
  const after = groupId ? source.kind === 'group' && fraction >= 0.5 : fraction >= 0.5
  const targetGroup = groupId ?? tab?.groupId
  const block = source.kind === 'group' && targetGroup
    ? layout.views.filter((view) => view.groupId === targetGroup)
    : members
  const next = after ? layout.views[layout.views.indexOf(block.at(-1)!) + 1] : block[0]
  // The outer edge of a group is an ungrouped destination. The label and
  // gaps between its member tabs are destinations inside that group.
  const insideGroup = source.kind === 'tab' && !groupId && tab?.groupId
    && (!after || next?.groupId === tab.groupId) ? tab.groupId : undefined
  return {
    targetKind: groupId ? 'group' : 'tab', targetId: groupId ?? tab!.id,
    edge: after ? 'after' : 'before',
    ...(next ? { beforeId: next.id } : {}),
    ...(insideGroup ? { groupId: insideGroup } : {}),
  }
}

export function WorkspaceTabGroups({ layout, change, rootRef, ui, beginDrag, renderTab, children, tabActions = [] }: WorkspaceTabStripProps & { ui: ClientUiService }): ReactNode {
  const [menu, setMenu] = useState<GroupMenu>()
  const [name, setName] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const dragImage = useRef<{ canvas: HTMLCanvasElement; frame: number } | undefined>(undefined)
  const clearDragImage = (): void => {
    if (!dragImage.current) return
    cancelAnimationFrame(dragImage.current.frame)
    dragImage.current.canvas.remove()
    dragImage.current = undefined
  }
  const drag = useRef<WorkspaceTabDrag | undefined>(undefined)
  const [dragging, setDragging] = useState<WorkspaceTabDrag>()
  const [preview, setPreview] = useState<DropPreview>()
  const clearDrag = (): void => {
    clearDragImage()
    drag.current = undefined
    setDragging(undefined)
    setPreview(undefined)
    beginDrag(undefined)
  }
  useEffect(() => {
    window.addEventListener('dragend', clearDrag)
    window.addEventListener('drop', clearDrag)
    return () => {
      window.removeEventListener('dragend', clearDrag)
      window.removeEventListener('drop', clearDrag)
    }
  }, [beginDrag])
  useEffect(() => clearDragImage, [])
  const dragOver = (event: DragEvent<HTMLDivElement>): void => {
    const source = drag.current
    if (!source) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const next = dropPreview(layout, source, event.currentTarget, event.target, event.clientX)
    setPreview((current) => current?.targetKind === next.targetKind && current?.targetId === next.targetId
      && current?.edge === next.edge && current?.beforeId === next.beforeId && current?.groupId === next.groupId ? current : next)
    const bounds = event.currentTarget.getBoundingClientRect()
    if (event.clientX < bounds.left + 24) event.currentTarget.scrollLeft -= 20
    else if (event.clientX > bounds.right - 24) event.currentTarget.scrollLeft += 20
  }
  const menuTab = menu?.kind === 'tab' ? layout.views.find((view) => view.id === menu.id) : undefined
  const menuGroup = menu?.kind === 'group' ? layout.groups?.find((group) => group.id === menu.id) : undefined
  const dismiss = (restoreFocus = false): void => {
    setMenu(undefined)
    if (restoreFocus && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true })
  }
  const open = (kind: GroupMenu['kind'], id: string, target: HTMLElement, x: number, y: number): void => {
    trigger.current = target
    setName(layout.groups?.find((group) => group.id === id)?.name ?? '')
    setMenu({ kind, id, x, y })
  }
  const handlers = (kind: GroupMenu['kind'], id: string): TabGroupHandlers => ({
    onContextMenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      open(kind, id, event.currentTarget, event.clientX, event.clientY)
    },
    onKeyDown: (event) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault()
      event.stopPropagation()
      const bounds = event.currentTarget.getBoundingClientRect()
      open(kind, id, event.currentTarget, bounds.left, bounds.bottom)
    },
  })

  useEffect(() => {
    if (!menu) return
    ui.overlays.open('workspace-tab-groups')
    const outside = (event: PointerEvent): void => {
      if (!panel.current?.contains(event.target as Node)) setMenu(undefined)
    }
    window.addEventListener('pointerdown', outside)
    return () => {
      window.removeEventListener('pointerdown', outside)
      ui.overlays.close('workspace-tab-groups')
    }
  }, [Boolean(menu), ui])

  useLayoutEffect(() => {
    if (!menu) return
    const position = (): void => {
      const root = rootRef.current?.getBoundingClientRect()
      const popup = panel.current
      if (!root || !popup) return
      const bounds = popup.getBoundingClientRect()
      popup.style.left = Math.max(8, Math.min(menu.x - root.left, root.width - bounds.width - 8)) + 'px'
      popup.style.top = Math.max(8, Math.min(menu.y - root.top + 6, root.height - bounds.height - 8)) + 'px'
    }
    position()
    panel.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true })
    window.addEventListener('resize', position)
    const observer = new ResizeObserver(position)
    if (rootRef.current) observer.observe(rootRef.current)
    if (panel.current) observer.observe(panel.current)
    return () => { window.removeEventListener('resize', position); observer.disconnect() }
  }, [menu, rootRef])

  useEffect(() => {
    if (menu && !menuTab && !menuGroup) setMenu(undefined)
  }, [menu, menuTab, menuGroup])

  const popupKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      dismiss(true)
      return
    }
    if (event.target instanceof HTMLInputElement && event.key !== 'Tab') return
    const controls = [...(panel.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])]
    if (!controls.length) return
    const index = controls.indexOf(document.activeElement as HTMLElement)
    const direction = event.key === 'Tab' ? event.shiftKey ? -1 : 1
      : event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!direction) return
    event.preventDefault()
    controls[(index + direction + controls.length) % controls.length]?.focus()
  }

  const seen = new Set<string>()
  return <div className="workspace-tabs workspace-tabs-with-groups" role="tablist" aria-label="Workspaces"
    onDragStartCapture={(event) => {
      const source = (event.target as Element).closest<HTMLElement>('[data-workspace-tab]:not([inert]), [data-workspace-group]')
      if (!source) return
      const id = source.dataset.workspaceGroup ?? source.dataset.workspaceTab
      if (!id) return
      clearDragImage()
      const canvas = tabDragImage(source)
      event.dataTransfer.setDragImage(canvas, canvas.width / 2, canvas.height / 2)
      dragImage.current = { canvas, frame: requestAnimationFrame(clearDragImage) }
      const next: WorkspaceTabDrag = { kind: source.dataset.workspaceGroup ? 'group' : 'tab', id }
      drag.current = next
      setDragging(next)
      beginDrag(next.kind === 'tab' ? next.id : undefined)
      setMenu(undefined)
    }}
    onDragOver={dragOver}
    onDragLeave={(event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPreview(undefined)
    }}
    onDrop={(event) => {
      const source = drag.current
      if (!source) return
      event.preventDefault()
      const destination = dropPreview(layout, source, event.currentTarget, event.target, event.clientX)
      change((current) => dropWorkspaceTabs(current, source, destination))
      clearDrag()
    }}>
    {layout.views.map((view, index) => {
      const group = layout.groups?.find((candidate) => candidate.id === view.groupId)
      const first = group && !seen.has(group.id)
      if (group) seen.add(group.id)
      const members = group ? layout.views.filter((candidate) => candidate.groupId === group.id) : []
      const active = members.some((member) => member.id === layout.activeViewId)
      return <Fragment key={view.id}>
        {first && group && <button
          type="button"
          className={'workspace-tab workspace-tab-group-label' + (active && group.collapsed ? ' is-active' : '')}
          data-group-color={group.color}
          data-workspace-group={group.id}
          data-tab-drop={preview?.targetKind === 'group' && preview.targetId === group.id ? preview.edge : undefined}
          aria-label={group.name + ' tab group, ' + members.length + (members.length === 1 ? ' tab' : ' tabs')}
          aria-expanded={!group.collapsed}
          title={group.name + ' · click to ' + (group.collapsed ? 'expand' : 'collapse') + ' · right-click to edit'}
          {...handlers('group', group.id)}
          onClick={() => change((current) => updateTabGroup(current, group.id, { collapsed: !group.collapsed }))}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('application/x-alto-workspace-group', group.id)
          }}
        >
          <span>{group.name}</span>
          <span className="workspace-tab-group-count" aria-hidden="true">{members.length}</span>
          <span className="workspace-tab-group-toggle" aria-hidden="true">
            <ChevronRight size={12} className={group.collapsed ? '' : 'is-expanded'} />
          </span>
        </button>}
        {renderTab(view, index, {
          ...handlers('tab', view.id),
          ...(group ? {
            color: group.color,
            inert: group.collapsed,
            className: 'workspace-tab-group-member' + (view.id === members.at(-1)?.id ? ' is-group-end' : '')
              + (group.collapsed ? ' is-group-collapsed' : ''),
          } : {}),
          ...(preview?.targetKind === 'tab' && preview.targetId === view.id ? { dropIndicator: preview.edge } : {}),
        })}
      </Fragment>
    })}
    {dragging?.kind === 'tab' && layout.views.find((view) => view.id === dragging.id)?.groupId && <span
      className={'workspace-tab workspace-tab-ungroup-target' + (preview?.targetKind === 'end' ? ' is-drop-target' : '')}
      aria-hidden="true">Move out of group</span>}
    {children}
    {menu && rootRef.current && createPortal(
      <div ref={panel} className={clientStyles.floatingPanel + ' workspace-tab-group-menu'}
        role={menu.kind === 'group' ? 'dialog' : 'menu'} aria-label={menu.kind === 'group' ? 'Edit tab group' : 'Tab group options'}
        onKeyDown={popupKeyDown} onContextMenu={(event) => event.preventDefault()}>
        {menuTab && <>
          <div className="workspace-tab-group-menu-title">{menuTab.name}</div>
          {tabActions.filter((action) => action.available(menuTab)).map((action) => <button type="button" role="menuitem" key={action.id}
            onClick={() => { dismiss(); action.run(menuTab) }}><span>{action.label}</span></button>)}
          <button type="button" role="menuitem" onClick={() => {
            const id = crypto.randomUUID()
            change((current) => createTabGroup(current, menuTab.id, id))
            setName('Group')
            setMenu({ ...menu, kind: 'group', id })
          }}><Plus size={14} /><span>Add to new group</span></button>
          {(layout.groups ?? []).map((group) => <button type="button" role="menuitem" key={group.id}
            onClick={() => { change((current) => assignTabToGroup(current, menuTab.id, group.id)); dismiss() }}>
            <i className="workspace-tab-group-dot" data-group-color={group.color} />
            <span>{group.name}</span>{menuTab.groupId === group.id && <Check size={14} />}
          </button>)}
          {menuTab.groupId && <button type="button" role="menuitem" onClick={() => {
            change((current) => assignTabToGroup(current, menuTab.id)); dismiss()
          }}><X size={14} /><span>Remove from group</span></button>}
        </>}
        {menuGroup && <>
          <label className="workspace-tab-group-name">Group name
            <input value={name} maxLength={60} autoFocus onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                const value = event.target.value
                setName(value)
                change((current) => updateTabGroup(current, menuGroup.id, { name: value }))
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                change((current) => updateTabGroup(current, menuGroup.id, { name }))
                dismiss(true)
              }} />
          </label>
          <div className="workspace-tab-group-colors" role="group" aria-label="Group color">
            {TAB_GROUP_COLORS.map((color) => <button type="button" key={color} data-group-color={color}
              aria-label={color[0]!.toUpperCase() + color.slice(1)} aria-pressed={menuGroup.color === color}
              onClick={() => change((current) => updateTabGroup(current, menuGroup.id, { color }))}>
              {menuGroup.color === color && <Check size={12} />}
            </button>)}
          </div>
          <button type="button" onClick={() => {
            change((current) => updateTabGroup(current, menuGroup.id, { collapsed: !menuGroup.collapsed })); dismiss()
          }}><ChevronRight size={14} /><span>{menuGroup.collapsed ? 'Expand group' : 'Collapse group'}</span></button>
          <button type="button" onClick={() => { change((current) => ungroupTabs(current, menuGroup.id)); dismiss() }}>
            <X size={14} /><span>Ungroup tabs</span>
          </button>
        </>}
      </div>, rootRef.current,
    )}
  </div>
}

const tabGroups: BrowserPlugin = (ctx) => {
  const Strip = (props: WorkspaceTabStripProps): ReactNode => <WorkspaceTabGroups {...props} ui={ctx.clientUi} />
  ctx.clientWorkspaceLayout.registerTabStrip(ctx, { id: 'tab-groups', renderer: Strip })
  ctx.clientUi.registerStyle(ctx, 'workspace-tab-groups', String(styles))
}

tabGroups.inject = ['clientWorkspaceLayout', 'clientUi']
export default tabGroups
