import { History, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { clientStyles, type BrowserPlugin } from '../../src/client/plugin-api.js'
import { errorMessage, threadRecencyAt, type LocalProject, type ThreadSummary } from '../../src/shared/protocol.js'
import { CHAT_HISTORY_LIST, type ChatHistoryPage } from './chat-history-api.js'
import { ChatHistoryStore, groupChatHistory } from './chat-history-model.js'
import type { ClientSessionService } from './session-api.js'
import { OptionalThreadStatusService, threadWorkStatus, type ClientThreadStatusService } from './thread-status-api.js'
import type { ClientWorkspaceLayoutService, WorkspacePaneKindProps } from './workspace-layout-api.js'
import { threadHistoryTitle } from './ui/history.js'
import { ThreadStatusIndicator } from './ui/thread-status.js'
import { useStoreSelector } from './ui/store-selector.js'
import styles from './chat-history.css'

interface HistoryServices {
  store: ChatHistoryStore
  session: ClientSessionService
  layout: ClientWorkspaceLayoutService
  status: ClientThreadStatusService
}

export function historyWorkspace(thread: ThreadSummary, projects: readonly LocalProject[]): string {
  if (!thread.projectId) return 'No workspace'
  return projects.find((project) => project.id === thread.projectId)?.name
    ?? thread.cwd.replaceAll('\\', '/').replace(/\/+$/u, '').split('/').pop()
    ?? 'Workspace'
}

export function openHistoryChat(layout: ClientWorkspaceLayoutService, thread: ThreadSummary): void {
  if (layout.focusThread(thread.id)) return
  layout.openPane({
    kind: 'chat', direction: 'horizontal', thread,
    workspace: thread.cwd,
    ...(thread.projectId ? { projectId: thread.projectId } : {}),
  })
}

export function ChatHistoryPane({ visible, services }: WorkspacePaneKindProps & { services: HistoryServices }): ReactNode {
  const { store, session, layout, status } = services
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const projects = useStoreSelector(session, (snapshot) => snapshot.projects)
  const providers = useStoreSelector(session, (snapshot) => snapshot.providers)
  const statuses = useSyncExternalStore(status.subscribe, status.snapshot, status.snapshot)
  const [openError, setOpenError] = useState('')
  const scroll = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => groupChatHistory(state.threads), [state.threads, visible])

  useEffect(() => {
    if (visible && !store.snapshot().loaded && !store.snapshot().error) void store.load()
  }, [store, visible])
  useEffect(() => {
    if (!visible || !state.loaded || state.loading || state.error || !state.nextCursor || !more.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void store.load()
    }, { root: scroll.current, rootMargin: '400px' })
    observer.observe(more.current)
    return () => observer.disconnect()
  }, [store, visible, state.loaded, state.loading, state.error, state.nextCursor])

  const open = (thread: ThreadSummary): void => {
    try { openHistoryChat(layout, thread); status.acknowledge(thread.id); setOpenError('') }
    catch (failure) { setOpenError(errorMessage(failure)) }
  }
  return <section className={clientStyles.pane + ' chat-history'} aria-label="Chat history">
    <header className={clientStyles.paneHeader + ' ' + clientStyles.paneToolbar + ' chat-history-toolbar'}>
      <h1 className={clientStyles.toolbarTitle}>History</h1>
      <button type="button" className={clientStyles.iconButton} title="Refresh history" aria-label="Refresh history"
        disabled={state.loading} onClick={() => { void store.load(true) }}><RefreshCw size={16} /></button>
    </header>
    <div ref={scroll} className="chat-history-scroll" tabIndex={0} aria-label="Chat history, most recent first">
      <div className="chat-history-content">
        <div className="chat-history-scope"><span>All workspaces</span><span>Most recent first</span></div>
        {state.warnings.map((warning) => <p key={warning} className="chat-history-notice" role="status">{warning.split('\n')[0]?.slice(0, 200)}. Try Refresh.</p>)}
        {openError && <p className="chat-history-notice" role="alert">{openError}</p>}
        {groups.map((group) => <section className="chat-history-day" key={group.key} aria-label={group.label}>
          <h2>{group.label}</h2>
          <ul>
            {group.threads.map((thread) => {
              const title = threadHistoryTitle(thread)
              const timestamp = threadRecencyAt(thread)
              const date = new Date(timestamp * 1000)
              const validDate = timestamp > 0 && Number.isFinite(date.getTime())
              const workspace = historyWorkspace(thread, projects)
              const provider = providers?.find((provider) => provider.id === thread.providerId)?.label ?? thread.providerId
              return <li key={thread.id}>
                <button type="button" className={clientStyles.button + ' chat-history-row'} onClick={() => open(thread)} title={title} aria-label={'Open chat: ' + title}>
                  <span className="chat-history-row-content">
                    <span className="chat-history-row-title">{title}</span>
                    <span className="chat-history-row-detail" title={[workspace, provider, thread.gitInfo?.branch].filter(Boolean).join(' · ')}>
                      <span>{workspace}</span>{provider && <><span aria-hidden="true">·</span><span>{provider}</span></>}{thread.gitInfo?.branch && <><span aria-hidden="true">·</span><span>{thread.gitInfo.branch}</span></>}
                    </span>
                  </span>
                  <span className="chat-history-row-end">
                    <ThreadStatusIndicator status={threadWorkStatus(statuses, thread.id) ?? (thread.status?.type === 'active' ? 'running' : undefined)} />
                    {validDate && <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>}
                  </span>
                </button>
              </li>
            })}
          </ul>
        </section>)}
        <div ref={more} className="chat-history-more" aria-live="polite">
          {state.error
            ? <><p role="alert">{state.error}</p><button className={clientStyles.button} type="button" onClick={() => { void store.retry() }}>Retry</button></>
            : state.loading ? <span>Loading history…</span>
            : !state.loaded ? null
            : !state.threads.length ? <span>No chats yet.</span>
            : state.nextCursor ? <button className={clientStyles.button} type="button" onClick={() => { void store.load() }}>Load older chats</button>
            : <span>Beginning of your history</span>}
        </div>
      </div>
    </div>
  </section>
}

const chatHistory: BrowserPlugin = (ctx) => {
  const store = new ChatHistoryStore(async (cursor) => (
    await ctx.clientHost.call(CHAT_HISTORY_LIST, cursor ? { cursor } : {}) as unknown as ChatHistoryPage
  ))
  const status = new OptionalThreadStatusService(ctx)
  ctx.effect(() => () => { store.dispose(); status.dispose() }, 'chat-history.store')
  const services: HistoryServices = { store, status, session: ctx.clientSession, layout: ctx.clientWorkspaceLayout }
  ctx.clientWorkspaceLayout.registerPaneKind(ctx, {
    id: 'history', label: 'History', description: 'Browse all chats by date',
    shortcut: 'h', icon: History,
    renderer: (props) => <ChatHistoryPane {...props} services={services} />,
  })
  ctx.clientUi.registerStyle(ctx, 'chat-history', String(styles))
}
chatHistory.inject = ['clientHost', 'clientSession', 'clientUi', 'clientWorkspaceLayout']
export default chatHistory
