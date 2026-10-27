import { ArrowLeft } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { clientStyles, type ClientHostService } from '../../src/client/plugin-api.js'
import { errorMessage, type ThreadHistoryPage, type ThreadMessage, type ThreadTrace } from '../../src/shared/protocol.js'
import { resolveMarkdownCodeBlock, type ClientMarkdownService, type MarkdownCodeBlockProps } from './markdown-api.js'
import { MarkdownContent, MarkdownMathProvider } from './ui/markdown.js'
import { ORCHESTRATOR_OPEN, taskActive, type AgentTask } from './orchestrator-api.js'

export function mergeAgentHistory(older: ThreadMessage[], newer: ThreadMessage[]): ThreadMessage[] {
  const messages = new Map(older.filter((message) => !message.id.endsWith(':pending-agent-output') || !newer.some((next) => next.id.startsWith(message.id.slice(0, -'pending-agent-output'.length)))).map((message) => [message.id, message]))
  for (const message of newer) messages.set(message.id, message)
  return [...messages.values()]
}
function Traces({ traces }: { traces: ThreadTrace[] | undefined }): ReactNode {
  if (!traces?.length) return null
  return <div className="agent-history-traces">{traces.map((trace) => <details key={trace.id}>
    <summary>{trace.title}</summary>
    {trace.kind === 'reasoning' ? <p>{trace.text}</p> : <pre>{trace.text}</pre>}
  </details>)}</div>
}
export const AgentHistoryMessage = memo(function AgentHistoryMessage({ message, markdown }: { message: ThreadMessage; markdown: ClientMarkdownService }): ReactNode {
  const state = useSyncExternalStore(markdown.subscribe, markdown.snapshot, markdown.snapshot)
  const CodeBlock = useMemo(() => function CodeBlock(props: MarkdownCodeBlockProps): ReactNode {
    const renderer = resolveMarkdownCodeBlock(state.codeBlocks, props.language)
    if (renderer) { const Component = renderer.component; return <Component {...props} /> }
    return <pre><code>{props.code}</code></pre>
  }, [state.codeBlocks])
  return <article className={'agent-history-message is-' + message.role}>
    <span className="agent-history-role">{message.role === 'user' ? 'Instructions' : 'Agent'}</span>
    <Traces traces={message.tracesBefore} />
    {message.text && <MarkdownMathProvider renderer={state.math} fileLinks={state.fileLinks}>
      <MarkdownContent source={message.text} className="activity-markdown" codeBlock={CodeBlock} />
    </MarkdownMathProvider>}
    {message.images?.map((image, index) => <img key={index} src={image.url} alt={image.name} />)}
    {message.attachments?.map((attachment, index) => <span className="agent-history-attachment" key={index}>{attachment.name}</span>)}
    <Traces traces={message.tracesAfter} />
  </article>
})
export function AgentConversation({ task, host, markdown, onBack }: {
  task: AgentTask; host: ClientHostService; markdown: ClientMarkdownService; onBack: () => void
}): ReactNode {
  const [page, setPage] = useState<ThreadHistoryPage>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const request = useRef(false)
  const live = useRef(true)
  const back = useRef<HTMLButtonElement>(null)
  const latestTask = useRef(task)
  latestTask.current = task
  useEffect(() => { live.current = true; back.current?.focus(); return () => { live.current = false } }, [])
  useEffect(() => {
    let current = true
    const read = async (): Promise<void> => {
      if (request.current) return
      request.current = true
      try {
        const next = await host.call(ORCHESTRATOR_OPEN, { parentThreadId: task.parentThreadId, id: task.id }) as unknown as ThreadHistoryPage
        if (current && live.current) { setPage((previous) => previous ? { ...previous, messages: mergeAgentHistory(previous.messages, next.messages) } : next); setError('') }
      } catch (failure) { if (current && live.current) setError(errorMessage(failure)) }
      finally { request.current = false; if (current && live.current) setLoading(false) }
    }
    void read()
    let lastUpdated = task.updatedAt
    const timer = setInterval(() => {
      if (request.current) return
      if (taskActive(latestTask.current) || latestTask.current.updatedAt !== lastUpdated) {
        lastUpdated = latestTask.current.updatedAt
        void read()
      }
    }, 3000)
    return () => { current = false; if (timer) clearInterval(timer) }
  }, [host, task.id, task.parentThreadId, retry])
  const older = async (): Promise<void> => {
    if (!page?.olderCursor || request.current) return
    request.current = true; setLoading(true)
    try {
      const next = await host.call(ORCHESTRATOR_OPEN, { parentThreadId: task.parentThreadId, id: task.id, cursor: page.olderCursor }) as unknown as ThreadHistoryPage
      if (live.current) { setPage((previous) => ({ ...next, messages: mergeAgentHistory(next.messages, previous?.messages ?? []) })); setError('') }
    } catch (failure) { if (live.current) setError(errorMessage(failure)) }
    finally { request.current = false; if (live.current) setLoading(false) }
  }
  return <section className="agent-conversation" aria-label={'History: ' + task.title}>
    <div className="agent-conversation-heading">
      <button ref={back} className={clientStyles.iconButton} type="button" aria-label="Back to agents" title="Back to agents" onClick={onBack}><ArrowLeft size={16} /></button>
      <div><h3 title={task.title}>{task.title}</h3><p title={task.parentTitle}>{task.parentTitle}</p></div>
    </div>
    <div className="agent-conversation-messages">
      {page?.olderCursor && <button className={clientStyles.button} type="button" disabled={loading} onClick={() => { void older() }}>Load earlier messages</button>}
      {error && <p className="agents-notice" role="status">{error} <button className={clientStyles.button} onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
      {loading && !page && <p className="agents-notice" role="status">Loading history…</p>}
      {page?.messages.map((message) => <AgentHistoryMessage key={message.id} message={message} markdown={markdown} />)}
      {page && !page.messages.length && <p className="agents-notice">No messages yet.</p>}
    </div>
  </section>
}
