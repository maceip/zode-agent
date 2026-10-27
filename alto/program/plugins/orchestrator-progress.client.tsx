import { ChevronRight, ChevronUp, X } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { clientStyles, type ClientHostService, type ClientUiService } from '../../src/client/plugin-api.js'
import type { ClientSessionService } from './session-api.js'
import type { TurnProgressAccessoryProps } from './turn-progress-api.js'
import { taskActive, taskStatusLabel, type AgentTask } from './orchestrator-api.js'
import { agentViewStore } from './orchestrator-store.client.js'
import type { AgentsPanelController } from './orchestrator-panel.js'

export function focusAfterSubagentDismiss(trigger: HTMLElement | null, hasActiveAgents: boolean): void {
  const target = hasActiveAgents ? trigger
    : trigger?.closest('.workspace-chat-pane, main')?.querySelector<HTMLElement>('[data-cordis-composer-editor]')
  target?.focus({ preventScroll: true })
}

export const SUBAGENT_DOT_LIMIT = 4

export function activeChatSubagents(tasks: readonly AgentTask[], threadId?: string): AgentTask[] {
  if (!threadId) return []
  const descendants = new Set([threadId])
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks) {
      if (!task.threadId || descendants.has(task.threadId)) continue
      if (descendants.has(task.parentThreadId) || task.ancestorThreadIds?.includes(threadId)) {
        descendants.add(task.threadId)
        changed = true
      }
    }
  }
  return tasks.filter((task) => task.threadId !== threadId && task.threadId && descendants.has(task.threadId) && taskActive(task))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export function SubagentDots({ tasks }: { tasks: readonly AgentTask[] }): ReactNode {
  return <span className="turn-subagents-dots" aria-hidden="true">
    {tasks.slice(0, SUBAGENT_DOT_LIMIT).map((task) => <span key={task.id} className={'turn-subagent-dot is-' + task.status} />)}
    {tasks.length > SUBAGENT_DOT_LIMIT && <span className="turn-subagents-overflow">+{tasks.length - SUBAGENT_DOT_LIMIT}</span>}
  </span>
}

interface SubagentProgressProps extends TurnProgressAccessoryProps {
  host: ClientHostService
  ui: ClientUiService
  controller: AgentsPanelController
}
export function SubagentProgress({ session, ...props }: SubagentProgressProps): ReactNode {
  const threadId = useSyncExternalStore(session.subscribe, () => session.snapshot().threadId)
  // Each split owns its selection. Navigating that split dismisses its popover.
  return <ChatSubagentProgress key={threadId ?? 'new'} {...props} {...(threadId ? { threadId } : {})} />
}

function ChatSubagentProgress({ host, ui, controller, render, threadId }: Omit<SubagentProgressProps, 'session'> & { threadId?: string }): ReactNode {
  const store = useMemo(() => agentViewStore(host), [host])
  const { snapshot, connected } = useSyncExternalStore(store.subscribe, store.snapshot)
  const active = useMemo(() => connected && !snapshot.error ? activeChatSubagents(snapshot.tasks, threadId) : [], [snapshot.tasks, snapshot.error, connected, threadId])
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState<AgentTask[]>([])
  const button = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const id = useId()
  const activeCount = useRef(active.length)
  activeCount.current = active.length
  const dismiss = useCallback(() => {
    setOpen(false)
    focusAfterSubagentDismiss(button.current, activeCount.current > 0)
  }, [])

  useEffect(() => {
    if (!open) return
    setSeen((previous) => {
      const added = active.filter((task) => !previous.some((item) => item.id === task.id))
      return added.length ? [...previous, ...added] : previous
    })
  }, [open, active])

  useEffect(() => {
    if (!open) return
    ui.overlays.open(id)
    const unsubscribe = ui.overlays.subscribe(() => { if (ui.overlays.snapshot() !== id) setOpen(false) })
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !popover.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      dismiss()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      unsubscribe()
      ui.overlays.close(id)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
    }
  }, [open, ui, id, dismiss])

  useLayoutEffect(() => {
    const element = popover.current
    const anchor = button.current?.closest('.turn-progress-control')
    if (!open || !element || !anchor) return
    const place = (): void => {
      const bounds = anchor.getBoundingClientRect()
      const width = element.getBoundingClientRect().width
      const gutter = 12
      const left = (bounds.left + bounds.right - width) / 2
      const shift = Math.max(gutter - left, Math.min(0, window.innerWidth - gutter - left - width))
      element.style.setProperty('--subagents-shift', shift + 'px')
      element.style.setProperty('--subagents-max-height', Math.max(0, bounds.top - gutter * 2) + 'px')
    }
    place()
    element.querySelector<HTMLButtonElement>('.turn-subagent-row')?.focus({ preventScroll: true })
    const observer = new ResizeObserver(place)
    observer.observe(anchor)
    observer.observe(element)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
  }, [open])

  // Keep rows under the pointer when an agent finishes. Closing the popover
  // drops these transient rows; its conversation is still available through explicit inspection.
  const displayed = open
    ? [...seen, ...active.filter((task) => !seen.some((item) => item.id === task.id))].map((task) => snapshot.tasks.find((latest) => latest.id === task.id) ?? task)
    : active
  if (!active.length && !open) return render()
  const label = active.length ? active.length + (active.length === 1 ? ' active subagent' : ' active subagents') : 'Subagent results'
  const inspect = (task: AgentTask): void => { setOpen(false); controller.inspect(task) }

  return render({
    label,
    content: <button ref={button} type="button" className={clientStyles.button + ' turn-subagents-trigger'} aria-label={label + '. Show subagents'} title={label} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} onClick={() => {
      if (open) dismiss()
      else { setSeen(active); setOpen(true) }
    }}>
      <SubagentDots tasks={active} />
      <ChevronUp className="turn-subagents-chevron" size={12} aria-hidden="true" />
    </button>,
    details: open ? <div ref={popover} id={id} className={clientStyles.floatingPanel + ' turn-subagents-popover'} role="dialog" aria-modal={false} aria-label="Subagents in this chat">
      <header><span>Subagents{active.length > 0 && <span className="turn-subagents-count">{active.length}</span>}</span>
        <button className={clientStyles.iconButton} aria-label="Close subagents" type="button" onClick={dismiss}><X size={14} /></button>
      </header>
      {!connected && <p className="turn-subagents-notice" role="status">Reconnecting…</p>}
      <div className="turn-subagents-list">
        {displayed.map((task) => <button key={task.id} type="button" className={clientStyles.button + ' turn-subagent-row'} title={'View ' + task.title + ' history'} aria-label={task.title + ', ' + taskStatusLabel[task.status] + '. View history'} disabled={!connected} onClick={() => inspect(task)}>
          <span className={'turn-subagent-dot is-' + task.status} aria-hidden="true" />
          <span className="turn-subagent-name">{task.title}</span>
          <span className="turn-subagent-status">{taskStatusLabel[task.status]}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>)}
      </div>
    </div> : null,
  })
}
