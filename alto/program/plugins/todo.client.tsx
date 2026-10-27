import { ArrowRight, Check, CheckSquare, ChevronDown, ChevronRight, MessageSquare, MoreHorizontal, Pencil, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { clientStyles, type BrowserPlugin, type ClientHostService, type ClientUiService } from '../../src/client/plugin-api.js'
import { errorMessage, type JsonValue, type ThreadSummary } from '../../src/shared/protocol.js'
import { emptyTodo, findTodoChat, findTodoItem, todoItemForThreads, TODO_APPLY, TODO_STATE, TODO_UNSORTED_ID, type TodoChat, type TodoDestination, type TodoDocument, type TodoItem, type TodoOperation, type TodoProject } from './todo-api.js'
import type { ClientWorkspaceLayoutService } from './workspace-layout-api.js'
import { workspaceViewPaneKinds, workspaceViewThreads } from './workspace-tab-data.js'
import type { WorkspaceView } from './workspace-layout-state.js'
import { flushSync } from 'react-dom'
import styles from './todo.css'

const empty = emptyTodo()
type MoveRequest = { threads: ThreadSummary[]; view?: WorkspaceView; item?: TodoItem; projectId?: string }
interface Services { host: ClientHostService; layout: ClientWorkspaceLayoutService; ui: ClientUiService; move(request: MoveRequest): void }

function useDocument(host: ClientHostService): TodoDocument {
  return useSyncExternalStore(host.subscribe, () => host.snapshot().snapshot?.extensions[TODO_STATE] as unknown as TodoDocument ?? empty)
}
function useApply(host: ClientHostService) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const apply = async (operation: TodoOperation, saved?: (document: TodoDocument) => void): Promise<boolean> => {
    setPending(true); setError('')
    try {
      const result = await host.call(TODO_APPLY, operation as unknown as JsonValue)
      if (live.current) saved?.(result as unknown as TodoDocument)
      return live.current
    }
    catch (failure) { if (live.current) setError(errorMessage(failure)); return false }
    finally { if (live.current) setPending(false) }
  }
  return { apply, pending, error }
}

function InlineName({ value, label, save, className = '' }: { value: string; label: string; save(value: string): Promise<boolean>; className?: string }): ReactNode {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const commit = async (): Promise<void> => {
    if (busy) return
    if (!draft.trim() || draft.trim() === value) { setEditing(false); return }
    setBusy(true)
    if (await save(draft)) setEditing(false)
    setBusy(false)
  }
  return editing ? <input className={'todo-inline-input ' + className} aria-label={label} value={draft} disabled={busy} maxLength={2000} autoFocus
    onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)} onBlur={() => void commit()}
    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void commit() }; if (event.key === 'Escape') { event.preventDefault(); setEditing(false) } }} />
    : <button type="button" className={'todo-edit-name ' + className} title={label} onClick={() => { setDraft(value); setEditing(true) }}>{value}</button>
}

function ChatLink({ chat, services, apply, itemId }: { chat: TodoChat; services: Services; apply(operation: TodoOperation): Promise<boolean>; itemId?: string }): ReactNode {
  const [open, setOpen] = useState(false), [error, setError] = useState('')
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(chat.thread.title)
  const { apply: rename, pending, error: renameError } = useApply(services.host)
  const saving = useRef(false)
  const title = chat.thread.title || chat.thread.preview || 'Untitled chat'
  const saveName = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || saving.current) return
    if (text === chat.thread.title) { setEditing(false); return }
    saving.current = true
    try {
      if (await rename({ type: 'renameChat', threadId: chat.thread.id, text })) setEditing(false)
    } finally { saving.current = false }
  }
  return <li className="todo-chat">
    {editing ? <form className="todo-chat-rename" onSubmit={(event) => void saveName(event)} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!pending) setEditing(false) }
    }}>
      <MessageSquare size={13} />
      <input className="todo-inline-input" aria-label="Conversation name" value={draft} maxLength={200} disabled={pending} autoFocus
        onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)} />
      <button type="submit" className={clientStyles.iconButton} aria-label="Save conversation name" disabled={pending || !draft.trim()}><Check size={15} /></button>
      <button type="button" className={clientStyles.iconButton} aria-label="Cancel rename" disabled={pending} onClick={() => setEditing(false)}><X size={15} /></button>
    </form> : <>
      <button type="button" className="todo-chat-link" title={chat.thread.cwd} onClick={() => {
        try {
          const tab = services.layout.tabs().find((tab) => tab.threadIds.includes(chat.thread.id))
          if (tab && itemId) services.layout.linkTabName(tab.id, { source: 'todo', id: itemId })
          if (!services.layout.focusThread(chat.thread.id)) services.layout.newTab(undefined, chat.thread)
          setError('')
        }
        catch (failure) { setError(errorMessage(failure)) }
      }}><MessageSquare size={13} /><span>{title}</span><ArrowRight size={13} /></button>
      <button type="button" className={clientStyles.iconButton + ' todo-row-action'} aria-label={'Rename ' + title} title="Rename conversation" onClick={() => { setOpen(false); setDraft(chat.thread.title); setEditing(true) }}><Pencil size={14} /></button>
      <button type="button" className={clientStyles.iconButton + ' todo-row-action'} aria-label={'Options for ' + title} aria-expanded={open} onClick={() => setOpen(!open)}><MoreHorizontal size={15} /></button>
    </>}
    {open && <div className="todo-row-options">
      <button type="button" onClick={() => { setOpen(false); services.move({ threads: [chat.thread] }) }}>Move to…</button>
      <button type="button" onClick={() => void apply({ type: 'removeChat', threadId: chat.thread.id })}>Unlink chat</button>
    </div>}
    {(error || (editing && renameError)) && <p className="todo-error" role="alert">{editing && renameError || error}</p>}
  </li>
}
function ChatLinks({ chats, services, apply, itemId }: { chats: TodoChat[]; services: Services; apply(operation: TodoOperation): Promise<boolean>; itemId?: string }): ReactNode {
  return chats.length ? <ul className="todo-chats">{chats.map((chat) => <ChatLink key={chat.thread.id} chat={chat} services={services} apply={apply} {...(itemId ? { itemId } : {})} />)}</ul> : null
}

function Project({ project, services }: { project: TodoProject; services: Services }): ReactNode {
  const [draft, setDraft] = useState(''), [collapsed, setCollapsed] = useState(!project.items.length && project.id !== TODO_UNSORTED_ID)
  const [focusRequest, setFocusRequest] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (focusRequest) input.current?.focus() }, [focusRequest])
  const { apply, pending, error } = useApply(services.host)
  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!draft.trim() || pending) return
    if (await apply({ type: 'addItem', projectId: project.id, text: draft })) setDraft('')
  }
  const completed = project.items.filter((item) => item.done).length
  return <section className={'todo-project' + (project.id === TODO_UNSORTED_ID ? ' todo-unsorted' : '')} aria-label={project.name}>
    <div className="todo-project-heading">
      <h2><button type="button" className="todo-project-toggle" aria-label={(collapsed ? 'Expand ' : 'Collapse ') + project.name} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span className="todo-project-name" title={project.name}>{project.name}</span>
        {project.items.length > 0 && <span className="todo-count" aria-label={completed + ' of ' + project.items.length + ' tasks complete'}>{completed ? completed + '/' : ''}{project.items.length}</span>}
      </button></h2>
      <button type="button" className={clientStyles.iconButton + ' todo-project-add'} aria-label={'New task in ' + project.name} title="Add task" onClick={() => { setCollapsed(false); setFocusRequest((value) => value + 1) }}><Plus size={16} /></button>
    </div>
    {!collapsed && <div className="todo-project-body">
      <ul className="todo-items">{project.items.map((item) => <li key={item.id} className={'todo-item' + (item.done ? ' is-done' : '')}>
        <div className="todo-item-line">
          <label className="todo-checkbox"><input type="checkbox" checked={item.done} disabled={pending} aria-label={'Complete ' + item.text} onChange={(event) => void apply({ type: 'completeItem', itemId: item.id, done: event.target.checked })} /><Check size={12} /></label>
          <InlineName value={item.text} label={'Edit ' + item.text} className="todo-item-text" save={(text) => apply({ type: 'editItem', itemId: item.id, text })} />
          <button type="button" className={clientStyles.iconButton + ' todo-row-action'} aria-label={'Move ' + item.text} title="Move to project" onClick={() => services.move({ threads: [], item, projectId: project.id })}><ArrowRight size={14} /></button>
          <button type="button" className={clientStyles.iconButton + ' todo-row-action'} disabled={pending} aria-label={'Delete ' + item.text} title="Delete task; keep conversations in history" onClick={() => void apply({ type: 'deleteItem', itemId: item.id })}><X size={14} /></button>
        </div>
        <ChatLinks chats={item.chats} services={services} apply={apply} itemId={item.id} />
      </li>)}</ul>
      <ChatLinks chats={project.chats} services={services} apply={apply} />
      <form className="todo-add-item" onSubmit={(event) => void add(event)}>
        <Plus size={15} /><input ref={input} value={draft} aria-label={'Add a task to ' + project.name} placeholder="Add task…" maxLength={2000} onChange={(event) => setDraft(event.target.value)} />
        {draft.trim() && <button type="submit" className={clientStyles.iconButton} disabled={pending} aria-label={'Save task in ' + project.name}><Check size={15} /></button>}
      </form>
    </div>}
    {error && <p className="todo-error" role="alert">{error}</p>}
  </section>
}

export function TasksPage({ services, visible }: { services: Services; visible: boolean }): ReactNode {
  const heading = useRef<HTMLHeadingElement>(null)
  const [showOtherProjects, setShowOtherProjects] = useState(false)
  useEffect(() => { if (visible) heading.current?.focus() }, [visible])
  const document = useDocument(services.host)
  const total = document.projects.reduce((sum, project) => sum + project.items.filter((item) => !item.done).length, 0)
  const activeProjects = document.projects.filter((project) => project.id !== TODO_UNSORTED_ID && (project.items.length || project.chats.length))
  const otherProjects = document.projects.filter((project) => project.id !== TODO_UNSORTED_ID && !project.items.length && !project.chats.length)
  const unsorted = document.projects.find((project) => project.id === TODO_UNSORTED_ID)
  return <section className={clientStyles.pane + ' todo-pane'} aria-label="Tasks list" onKeyDown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); services.layout.showPage() }
  }}>
    <div className="todo-scroll">
      <div className="todo-content">
        <header className="todo-heading"><div className="todo-title"><CheckSquare size={22} /><h1 ref={heading} tabIndex={-1}>Tasks <span>{total} open</span></h1></div><button type="button" className={clientStyles.iconButton} aria-label="Close Tasks" onClick={() => services.layout.showPage()}><X size={17} /></button></header>
        <div className="todo-active-projects">
          {activeProjects.map((project) => <Project key={project.id} project={project} services={services} />)}
          {unsorted && <Project key={unsorted.id} project={unsorted} services={services} />}
        </div>
        {otherProjects.length > 0 && <div className="todo-other-projects">
          <button type="button" className="todo-other-toggle" aria-expanded={showOtherProjects} onClick={() => setShowOtherProjects(!showOtherProjects)}>{showOtherProjects ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>Other projects</span><span className="todo-count">{otherProjects.length}</span></button>
          {showOtherProjects && otherProjects.map((project) => <Project key={project.id} project={project} services={services} />)}
        </div>}
      </div>
    </div>
  </section>
}

function MoveDialog({ request, services, close }: { request: MoveRequest; services: Services; close(): void }): ReactNode {
  const document = useDocument(services.host)
  const { apply, error, pending } = useApply(services.host)
  const [query, setQuery] = useState('')
  const [destination, setDestination] = useState<TodoDestination>(() => {
    if (request.projectId) return { projectId: request.projectId }
    if (request.view?.nameBinding?.source === 'todo') {
      const project = document.projects.find((project) => project.items.some((item) => item.id === request.view!.nameBinding!.id))
      if (project) return { projectId: project.id, itemId: request.view.nameBinding.id }
    }
    if (request.threads.length === 1) {
      const saved = findTodoChat(document, request.threads[0]!.id)
      if (saved) return saved.destination
    }
    const projectId = request.threads[0]?.projectId
    return { projectId: projectId && request.threads.every((thread) => thread.projectId === projectId)
      && document.projects.some((project) => project.id === projectId) ? projectId : TODO_UNSORTED_ID }
  })
  const panel = useRef<HTMLDivElement>(null)
  const canCloseTab = Boolean(request.view && workspaceViewPaneKinds(request.view).every((kind) => kind === 'chat')
    && workspaceViewPaneKinds(request.view).length === request.threads.length)
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null
    services.ui.overlays.open('todo.move')
    panel.current?.querySelector('input')?.focus()
    return () => { services.ui.overlays.close('todo.move'); if (previous?.isConnected) previous.focus() }
  }, [services.ui])
  const move = async (): Promise<void> => {
    let saved: TodoDocument | undefined
    const source = services.layout.tabs().find((tab) => request.view ? tab.id === request.view.id
      : request.threads.length > 0 && tab.threadIds.length === request.threads.length && request.threads.every((thread) => tab.threadIds.includes(thread.id)))
    const success = await apply(request.item
      ? { type: 'moveItem', itemId: request.item.id, projectId: destination.projectId }
      : request.view
        ? { type: 'fileTab', threads: request.threads, name: source?.title ?? request.view.name, destination,
            ...(source?.nameBinding?.source === 'todo' ? { sourceItemId: source.nameBinding.id } : {}) }
        : { type: 'fileChats', threads: request.threads, destination, ...(source ? { name: source.title } : {}) }, (document) => { saved = document })
    if (!success) return
    const currentTab = services.layout.tabs().find((tab) => tab.id === source?.id)
    const sameChats = currentTab && currentTab.threadIds.length === request.threads.length
      && request.threads.every((thread) => currentTab.threadIds.includes(thread.id))
    const itemId = saved && request.threads[0] ? findTodoChat(saved, request.threads[0].id)?.destination.itemId : undefined
    if (sameChats && itemId) flushSync(() => services.layout.linkTabName(currentTab.id, { source: 'todo', id: itemId }))
    if (canCloseTab && request.view && sameChats && currentTab.paneKinds?.every((kind) => kind === 'chat')
      && currentTab.paneKinds.length === request.threads.length) {
      // Keep a normal workspace tab available after filing the final chat.
      if (services.layout.tabs().length === 1) flushSync(() => services.layout.newTab())
      services.layout.closeTab(request.view.id)
      services.layout.showPage('todo')
    }
    close()
  }
  const valid = document.projects.some((project) => project.id === destination.projectId && (!destination.itemId || project.items.some((item) => item.id === destination.itemId)))
  return <div className={clientStyles.overlayLayer + ' todo-modal-layer'} onPointerDown={(event) => { if (event.target === event.currentTarget && !pending) close() }}>
    <div ref={panel} className={clientStyles.floatingPanel + ' todo-move-dialog'} role="dialog" aria-modal="true" aria-labelledby="todo-move-title"
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape' && !pending) { event.preventDefault(); close() }
        if (event.key === 'Tab') {
          const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])]
          const index = controls.indexOf(window.document.activeElement as HTMLElement)
          if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus() }
          else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus() }
        }
      }}>
      <header className="todo-move-heading"><h2 id="todo-move-title">{request.item ? 'Move task' : 'Move to Tasks'}</h2><button type="button" disabled={pending} className={clientStyles.iconButton} aria-label="Cancel move" onClick={close}><X size={16} /></button></header>
      <p className="todo-move-description">{request.item?.text ?? request.view?.name ?? (request.threads.length === 1 ? request.threads[0]?.title : request.threads.length + ' chats')}</p>
      <input className="todo-search" aria-label="Filter destinations" placeholder="Find a project or task…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="todo-destinations" role="group" aria-label="Destination">
        {document.projects.map((project) => {
          const match = project.name.toLowerCase().includes(query.toLowerCase())
          const items = request.item ? [] : project.items.filter((item) => match || item.text.toLowerCase().includes(query.toLowerCase()))
          if (!match && !items.length) return null
          return <div key={project.id} className="todo-destination-project">
            <button type="button" aria-pressed={destination.projectId === project.id && !destination.itemId} onClick={() => setDestination({ projectId: project.id })}><span>{project.name}</span>{destination.projectId === project.id && !destination.itemId && <Check size={14} />}</button>
            {items.map((item) => <button type="button" className="todo-destination-item" key={item.id} aria-pressed={destination.itemId === item.id} onClick={() => setDestination({ projectId: project.id, itemId: item.id })}><CheckSquare size={13} /><span>{item.text}</span>{destination.itemId === item.id && <Check size={14} />}</button>)}
          </div>
        })}
      </div>
      {error && <p className="todo-error" role="alert">{error}</p>}
      <footer><button type="button" className={clientStyles.button} disabled={pending} onClick={close}>Cancel</button><button type="button" className={clientStyles.button + ' todo-primary'} disabled={pending || !valid} onClick={() => void move()}>{pending ? 'Saving…' : request.item ? 'Move task' : 'Move chat' + (request.threads.length > 1 ? 's' : '')}</button></footer>
    </div>
  </div>
}

const todo: BrowserPlugin = (ctx) => {
  let request: MoveRequest | undefined
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener) }
  const setRequest = (value?: MoveRequest): void => { request = value; for (const listener of listeners) listener() }
  const services: Services = { host: ctx.clientHost, layout: ctx.clientWorkspaceLayout, ui: ctx.clientUi, move: setRequest }
  function Button(): ReactNode {
    useSyncExternalStore(services.layout.subscribe, services.layout.snapshot)
    const active = services.layout.activePage()?.id === 'todo'
    return <button type="button" className={clientStyles.button + ' todo-header-button'} title="Tasks" aria-label="Tasks" aria-pressed={active} onClick={() => services.layout.showPage(active ? undefined : 'todo')}><CheckSquare size={16} /><span>Tasks</span></button>
  }
  function Modal(): ReactNode {
    const current = useSyncExternalStore(subscribe, () => request)
    return current ? <MoveDialog key={current.view?.id ?? current.item?.id ?? current.threads[0]?.id} request={current} services={services} close={() => setRequest()} /> : null
  }
  const document = (): TodoDocument => services.host.snapshot().snapshot?.extensions[TODO_STATE] as unknown as TodoDocument ?? empty
  services.layout.registerTabNameSource(ctx, {
    id: 'todo',
    name: (id) => findTodoItem(document(), id)?.text,
    valid: (id, view) => {
      const item = findTodoItem(document(), id)
      return workspaceViewThreads(view).some((thread) => item?.chats.some((chat) => chat.thread.id === thread.id))
    },
    rename: async (itemId, text) => { await services.host.call(TODO_APPLY, { type: 'editItem', itemId, text }) },
    match: (view) => todoItemForThreads(document(), workspaceViewThreads(view).map((thread) => thread.id))?.id,
    subscribe: (listener) => {
      let previous = document()
      return services.host.subscribe(() => {
        const next = document()
        if (next === previous) return
        previous = next
        listener()
      })
    },
  })
  ctx.clientUi.registerSurface(ctx, 'todo-button', Button)
  ctx.clientUi.registerRoot(ctx, 'todo.move', Modal)
  ctx.clientUi.registerStyle(ctx, 'todo', String(styles))
  ctx.clientWorkspaceLayout.registerPage(ctx, { id: 'todo', label: 'Tasks', replacesPaneKind: 'todo', renderer: (props) => <TasksPage {...props} services={services} /> })
  ctx.clientWorkspaceLayout.registerTabAction(ctx, {
    id: 'todo.move-tab', label: 'Move to Tasks…', order: 10,
    available: (view) => workspaceViewThreads(view).length > 0,
    run: (view) => setRequest({ view, threads: workspaceViewThreads(view) }),
  })
}
todo.inject = ['clientHost', 'clientUi', 'clientWorkspaceLayout']
todo.resources = { provides: { surfaces: ['todo-button'], roots: ['todo.move'] }, requires: { extensions: [TODO_STATE] } }
export default todo
