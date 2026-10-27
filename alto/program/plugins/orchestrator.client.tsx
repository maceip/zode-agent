import { Check, ChevronDown, CircleAlert, CircleDot, History, Network, RefreshCw, Square, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clientStyles, type BrowserPlugin, type ClientHostService, type ClientUiService } from '../../src/client/plugin-api.js'
import { errorMessage } from '../../src/shared/protocol.js'
import type { ClientSessionService } from './session-api.js'
import type { ClientMarkdownService } from './markdown-api.js'
import { AgentConversation } from './orchestrator-history.client.js'
import { ORCHESTRATOR_OPEN, ORCHESTRATOR_PANEL, ORCHESTRATOR_REFRESH, ORCHESTRATOR_STOP, taskActive, taskStatusLabel, tasksForChat, type AgentTask } from './orchestrator-api.js'
import { AgentsPanelController, AGENTS_TOGGLE_ACTION } from './orchestrator-panel.js'
import { useAgentsPanelLayout } from './orchestrator-panel-layout.js'
import { agentViewStore } from './orchestrator-store.client.js'
import { SubagentProgress } from './orchestrator-progress.client.js'
import { TURN_PROGRESS_ACCESSORY, type TurnProgressAccessoryProps } from './turn-progress-api.js'
import progressStyles from './orchestrator-progress.css'
import styles from './orchestrator.css'

export const AgentTaskRow = memo(function AgentTaskRow({ task, onOpen, onStop, disabled = false }: {
  task: AgentTask; onOpen: (task: AgentTask) => void; onStop: (task: AgentTask) => void; disabled?: boolean
}): ReactNode {
  const Icon = task.status === 'done' ? Check : task.status === 'failed' || task.status === 'waiting' || task.status === 'unknown' ? CircleAlert : task.status === 'stopped' ? Square : CircleDot
  return <details className="agent-task">
    <summary className="agent-task-summary">
      <Icon className={'agent-task-status is-' + task.status} size={16} aria-hidden="true" />
      <span className="agent-task-title" title={task.title}>{task.title}</span>
      <span className="agent-task-state">{taskStatusLabel[task.status]}</span>
      <ChevronDown className="agent-task-chevron" size={14} aria-hidden="true" />
    </summary>
    <div className="agent-task-details">
      {task.activity && <p className="agent-task-activity">{task.activity}</p>}
      {task.error && <p className="agent-task-error">{task.error}</p>}
      {task.result && <div className="agent-task-result" aria-label="Agent result">{task.result}</div>}
      <div className="agent-task-actions">
        <button className={clientStyles.button} type="button" disabled={disabled || !task.threadId} onClick={() => onOpen(task)}><History size={14} />View history</button>
        {taskActive(task) && <button className={clientStyles.button} type="button" title={task.canStop === false ? 'Stop the parent turn to stop this agent' : undefined} disabled={disabled || task.status === 'stopping' || task.canStop === false} onClick={() => onStop(task)}><Square size={12} />Stop agent</button>}
      </div>
    </div>
  </details>
})

type AgentTaskListProps = {
  tasks: readonly AgentTask[]
  onOpen: (task: AgentTask) => void
  onStop: (task: AgentTask) => void
  disabled?: boolean
}

function AgentTaskGroups({ tasks, ...actions }: AgentTaskListProps): ReactNode {
  const groups = new Map<string, AgentTask[]>()
  for (const task of tasks) {
    const group = groups.get(task.parentThreadId) ?? []
    group.push(task)
    groups.set(task.parentThreadId, group)
  }
  return [...groups].map(([parentId, items]) => <section key={parentId} className="agents-group" aria-label={items[0]?.parentTitle}>
    <h3 title={items[0]?.parentTitle}>{items[0]?.parentTitle}</h3>
    {items.map((task) => <AgentTaskRow key={task.id} task={task} {...actions} />)}
  </section>)
}

export function AgentTaskList({ tasks, ...actions }: AgentTaskListProps): ReactNode {
  return <AgentTaskGroups tasks={tasks.filter(taskActive)} {...actions} />
}

function useAgentMount(ui: ClientUiService): HTMLElement | null {
  const revision = useSyncExternalStore(ui.subscribe, ui.snapshot)
  const [mount, setMount] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const sync = (): void => {
      const target = document.querySelector<HTMLElement>('[data-ui-contribution="orchestrator-toggle"]')
      setMount((current) => current === target ? current : target)
    }
    sync()
    // Keep observing after mounting: a workspace reload can replace the toolbar.
    const observer = new MutationObserver(sync)
    observer.observe(document.querySelector('.shell-kernel') ?? document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [revision])
  return mount
}
export function AgentsChrome({ host, ui, session, markdown, controller }: {
  host: ClientHostService; ui: ClientUiService; session: ClientSessionService; markdown: ClientMarkdownService; controller: AgentsPanelController
}): ReactNode {
  const mount = useAgentMount(ui)
  const panelState = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const { open, pinned } = panelState
  const store = useMemo(() => agentViewStore(host), [host])
  const { snapshot, connected } = useSyncExternalStore(store.subscribe, store.snapshot)
  const currentThreadId = useSyncExternalStore(session.subscribe, () => session.snapshot().threadId)
  const [allChats, setAllChats] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<AgentTask>()
  const selectedTask = snapshot.tasks.find((task) => task.id === selected?.id) ?? selected
  useEffect(() => { setSelected(undefined) }, [currentThreadId, allChats])
  useEffect(() => {
    if (panelState.inspect) setSelected(panelState.inspect)
  }, [panelState.inspectRevision, panelState.inspect])
  useEffect(() => {
    if (!open || !connected) return
    void host.call(ORCHESTRATOR_REFRESH, !allChats && currentThreadId ? { parentThreadId: currentThreadId } : {}).catch(() => {})
  }, [open, connected, allChats, currentThreadId, host])
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  useAgentsPanelLayout(panel)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const run = useCallback(async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError('')
    try { await operation() } catch (failure) { if (alive.current) setError(errorMessage(failure)) }
    finally { if (alive.current) setBusy(false) }
  }, [])
  const close = useCallback(() => { controller.hide(); button.current?.focus() }, [controller])
  useEffect(() => {
    if (!open) { setConfirmStop(false); return }
    // Keyboard opening moves focus into the panel; toolbar clicks retain focus.
    if (!panelState.focusOnOpen) return
    const previous = document.activeElement
    const frame = requestAnimationFrame(() => closeButton.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      if (!controller.snapshot().open && previous instanceof HTMLElement && previous.isConnected && panel.current?.contains(document.activeElement)) previous.focus()
    }
  }, [open, panelState.focusOnOpen, panelState.inspectRevision, controller])
  useEffect(() => {
    const element = panel.current
    if (!element) return
    const outside = (event: PointerEvent): void => {
      if (controller.snapshot().mode !== 'floating') return
      if (event.target instanceof Node && !element.contains(event.target) && !button.current?.contains(event.target)) controller.hide()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented && controller.snapshot().mode === 'floating') { event.preventDefault(); close() }
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
    }
  }, [controller, close])
  useEffect(() => { setConfirmStop(false) }, [currentThreadId, allChats])
  const currentTasks = connected && !snapshot.error ? snapshot.tasks.filter(taskActive) : []
  const tasks = allChats ? currentTasks : tasksForChat(snapshot.tasks, currentThreadId).filter((task) => currentTasks.includes(task))
  const activeCount = currentTasks.length
  const stop = (task: AgentTask): void => { void run(() => host.call(ORCHESTRATOR_STOP, { parentThreadId: task.parentThreadId, id: task.id })) }
  const inspect = (task: AgentTask): void => { setSelected(task) }
  const stopAll = (): void => {
    if (!confirmStop) { setConfirmStop(true); return }
    const parents = [...new Set(tasks.map((task) => task.parentThreadId))]
    setConfirmStop(false)
    void run(() => Promise.all(parents.map((parentThreadId) => host.call(ORCHESTRATOR_STOP, { parentThreadId }))))
  }
  const needsAttention = currentTasks.some((task) => task.status === 'waiting')
  return <>
    {mount && createPortal(<button ref={button} type="button" className={clientStyles.iconButton + ' icon-button shell-control agents-toggle'} title={'Agents' + (activeCount ? ' · ' + activeCount + ' active' : '')} aria-label={'Agents' + (activeCount ? ', ' + activeCount + ' active' : '') + (needsAttention ? ', needs attention' : '')} aria-haspopup="dialog" aria-expanded={open} aria-controls={ORCHESTRATOR_PANEL} data-hotkey-action={AGENTS_TOGGLE_ACTION} onClick={() => controller.toggle()}>
      <Network size={15} />{activeCount > 0 && <span className="agents-toggle-count">{activeCount}</span>}
    </button>, mount)}
    {createPortal(<aside ref={panel} id={ORCHESTRATOR_PANEL} className={clientStyles.floatingPanel + ' agents-panel' + (open ? ' is-open' : '') + (pinned ? ' is-pinned' : '')} role={pinned ? "complementary" : "dialog"} aria-modal={pinned ? undefined : false} aria-label="Agents" aria-hidden={!open} inert={!open}>
      <header className={clientStyles.toolbar + ' agents-header'}>
        <span className="agents-heading">Agents<span>{tasks.length ? tasks.length + ' active' : ''}</span></span>
        <div className={clientStyles.toolbarActions}>
          <button className={clientStyles.iconButton} type="button" aria-label="Refresh agent status" title="Refresh status" disabled={busy || !connected} onClick={() => { void run(() => host.call(ORCHESTRATOR_REFRESH, !allChats && currentThreadId ? { parentThreadId: currentThreadId } : {})) }}><RefreshCw size={15} /></button>
          <button ref={closeButton} className={clientStyles.iconButton} type="button" aria-label="Close agents" title="Close agents" onClick={close}><X size={16} /></button>
        </div>
      </header>
      {!selectedTask && <div className="agents-scope">
        <button type="button" className={clientStyles.button} aria-pressed={!allChats} onClick={() => setAllChats(false)}>This chat</button>
        <button type="button" className={clientStyles.button} aria-pressed={allChats} onClick={() => setAllChats(true)}>All chats</button>
        {tasks.length > 0 && <button type="button" className={clientStyles.button + ' agents-stop-all'} disabled={busy || !connected} onClick={stopAll}>{confirmStop ? 'Confirm stop' : tasks.some((task) => task.canStop === false) ? 'Stop parent turn' : 'Stop agents'}</button>}
        {confirmStop && <button className={clientStyles.iconButton} type="button" aria-label="Cancel stopping agents" onClick={() => setConfirmStop(false)}><X size={14} /></button>}
      </div>}
      {(!connected || error || snapshot.error) && <p className="agents-notice" role="status">{error || snapshot.error || 'Reconnecting… Saved statuses may be out of date.'}</p>}
      <div className="agents-scroll">
        {selectedTask && open ? <AgentConversation key={selectedTask.id} task={selectedTask} host={host} markdown={markdown} onBack={() => setSelected(undefined)} /> : <>
        {!tasks.length && <div className="agents-empty"><Network size={24} /><p>{!connected || snapshot.error ? 'Agent status unavailable' : allChats ? 'No active subagents' : 'No active subagents in this chat'}</p>{!allChats && currentTasks.length > 0 && <button className={clientStyles.button} type="button" onClick={() => setAllChats(true)}>See agents from other chats</button>}</div>}
        <AgentTaskList key={(allChats ? 'all' : currentThreadId) + ':' + open} tasks={tasks} onOpen={inspect} onStop={stop} disabled={busy || !connected} />
        </>}
      </div>
    </aside>, document.querySelector('.shell-kernel') ?? document.body)}
  </>
}
const orchestratorClient: BrowserPlugin = (ctx) => {
  // Published renderers can run while a replacement fiber is activating.
  const host = ctx.clientHost
  const ui = ctx.clientUi
  const session = ctx.clientSession
  const markdown = ctx.clientMarkdown
  let storage: Storage | undefined
  try { storage = window.localStorage } catch {}
  const controller = new AgentsPanelController(ui.overlays, ORCHESTRATOR_PANEL, storage)
  ctx.provide('clientAgentsPanel', controller)
  ctx.effect(() => ui.overlays.subscribe(controller.syncOverlay), 'agents-panel.overlays')
  ui.registerRoot(ctx, 'agents-chrome', () => <AgentsChrome host={host} ui={ui} session={session} markdown={markdown} controller={controller} />)
  ui.registerStyle(ctx, 'orchestrator', String(styles))
  ui.registerStyle(ctx, 'orchestrator-progress', String(progressStyles))
  ui.registerComponent<TurnProgressAccessoryProps>(ctx, TURN_PROGRESS_ACCESSORY, ({ session, render }) => <SubagentProgress host={host} ui={ui} session={session} controller={controller} render={render} />)
  return () => controller.dispose()
}
orchestratorClient.inject = ['clientHost', 'clientUi', 'clientSession', 'clientMarkdown']
orchestratorClient.provide = 'clientAgentsPanel'
orchestratorClient.resources = { requires: { extensions: [ORCHESTRATOR_STOP, ORCHESTRATOR_REFRESH, ORCHESTRATOR_OPEN] }, provides: { roots: ['agents-chrome'], components: [TURN_PROGRESS_ACCESSORY] } }
export default orchestratorClient
