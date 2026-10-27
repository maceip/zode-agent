import { agentChatStateKey, isAgentChatId, type AgentChat } from './agent-chats-api.js'
import {
  Check,
  CornerDownRight,
  CornerUpRight,
  GripVertical,
  Image as ImageIcon,
  Paperclip,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type ReactNode,
} from 'react'
import type { ComposerDraft } from './ui/composer.js'
import type {
  BrowserPlugin,
  ClientHostService,
  ClientSubmitMiddleware,
  ClientSurfaceProps,
} from '../../src/client/plugin-api.js'
import { isRecord, type JsonValue, type TurnInput } from '../../src/shared/protocol.js'
import styles from './steer.css'
import {
  STEER_QUEUE_ADD,
  STEER_QUEUE_DELETE,
  STEER_QUEUE_LIST,
  STEER_QUEUE_REORDER,
  STEER_QUEUE_START,
  STEER_QUEUE_UPDATE,
  type ClientSteerService,
} from './steer-api.js'
import type { ClientConversationService, ClientSessionSnapshot } from './session-api.js'
import { useStoreSelector } from './ui/store-selector.js'
import { acceptsImmediateReply } from './ui/turn-intervention.js'

export interface QueuedSteerMessage {
  id: string
  threadId: string
  draft: ComposerDraft
  state: 'queued' | 'steering'
  error?: string
}

export function moveQueuedSteer<T extends { id: string }>(
  messages: readonly T[],
  draggedId: string,
  targetId: string,
): readonly T[] {
  if (draggedId === targetId) return messages
  const from = messages.findIndex((message) => message.id === draggedId)
  const to = messages.findIndex((message) => message.id === targetId)
  if (from < 0 || to < 0) return messages
  const reordered = [...messages]
  const [dragged] = reordered.splice(from, 1)
  if (!dragged) return messages
  reordered.splice(to, 0, dragged)
  return reordered
}

export function replaceQueuedSteer<T extends { id: string }>(
  messages: readonly T[],
  previousId: string,
  updated: T,
): readonly T[] {
  const index = messages.findIndex((message) => (
    message.id === previousId || message.id === updated.id
  ))
  if (index < 0) return [...messages, updated]
  return messages.flatMap((message, messageIndex) => {
    if (message.id !== previousId && message.id !== updated.id) return [message]
    return messageIndex === index ? [updated] : []
  })
}

export class SteerQueue {
  private messages: readonly QueuedSteerMessage[] = []
  private serial = 0
  private readonly listeners = new Set<() => void>()
  private readonly disposeEvents: (() => void) | undefined
  private disposeState: (() => void) | undefined
  private lastQueue: unknown
  private scopedThreadId: string | undefined
  private generation = 0
  private readonly hiddenIds = new Map<string, string>()

  constructor(private readonly host?: ClientHostService) {
    this.disposeState = host?.subscribe(() => {
      if (!this.scopedThreadId || !isAgentChatId(this.scopedThreadId)) return
      const chat = host.snapshot().snapshot?.extensions[agentChatStateKey(this.scopedThreadId)] as unknown as AgentChat | undefined
      if (!chat || chat.queue === this.lastQueue) return
      this.lastQueue = chat.queue
      const threadId = this.scopedThreadId
      this.messages = [...this.messages.filter((message) => message.threadId !== threadId),
        ...(chat.queue ?? []).map((entry) => ({ ...entry, threadId, state: 'queued' as const }))]
      this.emit()
    })
    this.disposeEvents = host?.onEvent((event) => {
      if (event.type === 'snapshot' && this.scopedThreadId) {
        void this.refresh(this.scopedThreadId)
        return
      }
      if (
        event.type === 'codex.notification'
        && event.payload.method === 'thread/queue/changed'
        && event.payload.params?.threadId === this.scopedThreadId
      ) void this.refresh(this.scopedThreadId)
    })
  }

  private call(method: string, payload: JsonValue): Promise<JsonValue> {
    const threadId = isRecord(payload) ? payload.threadId : undefined
    const routed = typeof threadId === 'string' && isAgentChatId(threadId) ? method.replace('steer.queue.', 'agent-chats.queue.') : method
    return this.host!.call(routed, payload)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): readonly QueuedSteerMessage[] => this.messages

  scopeTo(threadId: string | undefined): void {
    if (threadId === this.scopedThreadId) return
    this.scopedThreadId = threadId
    this.lastQueue = undefined
    if (threadId) void this.refresh(threadId)
  }

  async enqueue(threadId: string, draft: ComposerDraft): Promise<void> {
    if (this.host) {
      const value = await this.call(STEER_QUEUE_ADD, {
        threadId,
        clientUserMessageId: `alto-${Date.now()}-${++this.serial}`,
        draft,
      } as unknown as JsonValue)
      const message = queuedMessage(value, threadId)
      if (!message) throw new Error('Codex returned an invalid queued submission')
      this.hiddenIds.delete(message.id)
      this.messages = [
        ...this.messages.filter((candidate) => candidate.id !== message.id),
        message,
      ]
      this.emit()
      return
    }
    this.messages = [...this.messages, {
      id: `steer-${Date.now()}-${++this.serial}`,
      threadId,
      draft: {
        text: draft.text,
        images: [...draft.images],
        attachments: [...draft.attachments],
        skills: [...draft.skills],
      },
      state: 'queued',
    }]
    this.emit()
  }

  async update(id: string, draft: ComposerDraft): Promise<void> {
    const previous = this.messages.find((message) => message.id === id)
    if (!previous || previous.state !== 'queued') return
    const { error: _previousError, ...unchanged } = previous
    const optimistic: QueuedSteerMessage = {
      ...unchanged,
      draft: {
        text: draft.text,
        images: [...draft.images],
        attachments: [...draft.attachments],
        skills: [...draft.skills],
      },
    }
    this.messages = this.messages.map((message) => message.id === id ? optimistic : message)
    this.emit()
    if (!this.host) return
    try {
      const value = await this.call(STEER_QUEUE_UPDATE, {
        threadId: previous.threadId,
        queuedSubmissionId: id,
        draft: optimistic.draft,
      } as unknown as JsonValue)
      const updated = queuedMessage(value, previous.threadId)
      if (!updated) throw new Error('Codex returned an invalid updated submission')
      this.hiddenIds.delete(id)
      this.hiddenIds.delete(updated.id)
      this.messages = replaceQueuedSteer(this.messages, id, updated)
      this.emit()
    } catch (error) {
      const remote = await this.refresh(previous.threadId)
      const remoteMessage = remote?.find((message) => message.id === id)
      if (
        (remote !== undefined && !remoteMessage)
        || (remote === undefined && queuedSubmissionMissing(error))
      ) {
        const remaining = this.messages.filter((message) => message.id !== id)
        if (remaining.length !== this.messages.length) {
          this.messages = remaining
          this.emit()
        }
        return
      }
      const current = this.messages.find((message) => message.id === id)
      if (!current) return
      const restored: QueuedSteerMessage = {
        ...(remote === undefined ? previous : current),
        error: error instanceof Error ? error.message : String(error),
      }
      this.messages = this.messages.map((message) => message.id === id ? restored : message)
      this.emit()
      throw error
    }
  }

  async remove(id: string): Promise<void> {
    const hidden = this.hide(id)
    if (!hidden) return
    if (!this.host) {
      this.hiddenIds.delete(id)
      return
    }
    try {
      await this.call(STEER_QUEUE_DELETE, {
        threadId: hidden.message.threadId,
        queuedSubmissionId: id,
      })
    } catch (error) {
      if (!await this.restoreAfterFailedMutation(hidden, error)) return
      throw error
    }
  }

  async move(draggedId: string, targetId: string): Promise<void> {
    const next = moveQueuedSteer(this.messages, draggedId, targetId)
    if (next === this.messages) return
    this.messages = next
    this.emit()
    const threadId = next.find((message) => message.id === draggedId)?.threadId
    if (threadId && this.host) {
      await this.call(STEER_QUEUE_REORDER, {
        threadId,
        queuedSubmissionIds: next
          .filter((message) => message.threadId === threadId)
          .map((message) => message.id),
      })
    }
  }

  startSteering(id: string): QueuedSteerMessage | undefined {
    const message = this.messages.find((candidate) => candidate.id === id)
    if (!message || message.state !== 'queued') return undefined
    this.messages = this.messages.map((candidate) => candidate.id === id
      ? { ...candidate, state: 'steering' }
      : candidate)
    this.emit()
    return message
  }

  async steer(id: string, session: ClientConversationService): Promise<void> {
    const message = this.startSteering(id)
    if (!message) return
    try {
      if (this.host && isAgentChatId(message.threadId)) {
        await this.host.call('agent-chats.queue.steer', { threadId: message.threadId, queuedSubmissionId: id })
        this.hide(id)
      } else {
        await session.steer(message.draft)
        await this.remove(id)
      }
    } catch (error) { this.failSteering(id, error) }
  }

  failSteering(id: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    this.messages = this.messages.map((message) => message.id === id
      ? { ...message, state: 'queued', error: detail }
      : message)
    this.emit()
  }

  takeNext(threadId: string): QueuedSteerMessage | undefined {
    const message = this.messages.find((candidate) => (
      candidate.threadId === threadId && candidate.state === 'queued'
    ))
    if (!message || message.state !== 'queued') return undefined
    this.messages = this.messages.filter((candidate) => candidate.id !== message.id)
    this.emit()
    return message
  }

  async startNext(threadId: string): Promise<QueuedSteerMessage | undefined> {
    if (!this.host) return this.takeNext(threadId)
    const message = this.messages.find((candidate) => (
      candidate.threadId === threadId && candidate.state === 'queued'
    ))
    if (!message) return undefined
    const hidden = this.hide(message.id)
    if (!hidden) return undefined
    try {
      await this.call(STEER_QUEUE_START, {
        threadId,
        queuedSubmissionId: message.id,
      })
      return hidden.message
    } catch (error) {
      if (!await this.restoreAfterFailedMutation(hidden, error)) return undefined
      throw error
    }
  }

  dispose(): void {
    this.generation += 1
    this.hiddenIds.clear()
    this.disposeEvents?.()
    this.disposeState?.()
    this.listeners.clear()
  }

  private async refresh(
    threadId: string | undefined,
  ): Promise<readonly QueuedSteerMessage[] | undefined> {
    if (!this.host || !threadId) return undefined
    const generation = ++this.generation
    try {
      const value = await this.call(STEER_QUEUE_LIST, { threadId })
      const remote = Array.isArray(value)
        ? value.flatMap((entry) => {
            const message = queuedMessage(entry, threadId)
            return message ? [message] : []
          })
        : []
      if (generation !== this.generation) return remote
      const remoteIds = new Set(remote.map((message) => message.id))
      for (const [id, hiddenThreadId] of this.hiddenIds) {
        if (hiddenThreadId === threadId && !remoteIds.has(id)) this.hiddenIds.delete(id)
      }
      this.messages = [
        ...this.messages.filter((message) => message.threadId !== threadId),
        ...remote.filter((message) => !this.hiddenIds.has(message.id)),
      ]
      this.emit()
      return remote
    } catch (error) {
      console.error('Unable to refresh the Codex submission queue', error)
      return undefined
    }
  }

  private async restoreAfterFailedMutation(
    hidden: { message: QueuedSteerMessage; index: number },
    error: unknown,
  ): Promise<boolean> {
    const remote = await this.refresh(hidden.message.threadId)
    const id = hidden.message.id
    if (
      !this.hiddenIds.has(id)
      || (remote !== undefined && !remote.some((message) => message.id === id))
      || (remote === undefined && queuedSubmissionMissing(error))
    ) {
      this.hiddenIds.delete(id)
      return false
    }
    this.restore(hidden, error)
    return true
  }

  private hide(id: string): { message: QueuedSteerMessage; index: number } | undefined {
    const index = this.messages.findIndex((message) => message.id === id)
    const message = this.messages[index]
    if (!message) return undefined
    this.hiddenIds.set(id, message.threadId)
    this.messages = this.messages.filter((candidate) => candidate.id !== id)
    this.emit()
    return { message, index }
  }

  private restore(
    hidden: { message: QueuedSteerMessage; index: number },
    error: unknown,
  ): void {
    this.hiddenIds.delete(hidden.message.id)
    const restored: QueuedSteerMessage = {
      ...hidden.message,
      state: 'queued',
      error: error instanceof Error ? error.message : String(error),
    }
    const existing = this.messages.findIndex((message) => message.id === restored.id)
    if (existing >= 0) {
      this.messages = this.messages.map((message, index) => index === existing ? restored : message)
    } else {
      const next = [...this.messages]
      next.splice(Math.min(hidden.index, next.length), 0, restored)
      this.messages = next
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function queuedSubmissionMissing(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error)
  return /queued submission not found(?::|$)/i.test(detail)
}

function draftFromInput(input: TurnInput[]): ComposerDraft {
  return {
    text: input.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n'),
    images: input.flatMap((part) => part.type === 'image'
      ? [{ name: 'Image', mediaType: /^data:([^;,]+)/.exec(part.url)?.[1] ?? 'image/*', url: part.url }]
      : []),
    attachments: input.flatMap((part) => {
      if (part.type === 'mention') return [{ name: part.name, path: part.path }]
      if (part.type === 'localImage') {
        return [{ name: part.path.split('/').at(-1) ?? 'Image', path: part.path, mediaType: 'image/*' }]
      }
      if (part.type === 'localAudio') {
        return [{ name: part.path.split('/').at(-1) ?? 'Audio', path: part.path, mediaType: 'audio/*' }]
      }
      if (part.type === 'audio') {
        return [{ name: 'Audio', path: part.url, mediaType: 'audio/*' }]
      }
      return []
    }),
    skills: input.flatMap((part) => part.type === 'skill'
      ? [{ name: part.name, path: part.path, description: '', scope: 'repo' as const }]
      : []),
  }
}

function queuedMessage(value: unknown, threadId: string): QueuedSteerMessage | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.input)) return undefined
  return {
    id: value.id,
    threadId,
    draft: draftFromInput(value.input as TurnInput[]),
    state: 'queued',
  }
}

export function createSteerSubmitMiddleware(
  queue: SteerQueue,
  session: ClientConversationService,
): ClientSubmitMiddleware {
  return async (draft, next, request) => {
    const state = session.snapshot()
    const target = request.target ?? {
      id: state.threadId ?? `new:${state.session.workspace}`,
      ...(state.threadId ? { threadId: state.threadId } : {}),
      activeTurn: state.turn.tag === 'running',
      send: (forwarded) => session.send(forwarded),
      steer: (forwarded) => session.steer(forwarded),
    }
    if (!target.activeTurn) {
      await next(draft)
      return
    }
    if (!target.threadId) throw new Error('the active turn has no thread id')
    if (request.mode === 'steer' || acceptsImmediateReply(state.harness, target.threadId)) {
      await target.steer(draft)
      return
    }
    await queue.enqueue(target.threadId, draft)
  }
}

function messageLabel(message: QueuedSteerMessage): string {
  const text = message.draft.text.trim()
  if (text) return text
  const attachments = message.draft.attachments.length
  if (attachments) return attachments === 1 ? '1 attached file' : `${attachments} attached files`
  return message.draft.images.length === 1 ? '1 attached image' : `${message.draft.images.length} attached images`
}

interface SteerSessionSnapshot {
  threadId?: string
  turn: ClientSessionSnapshot['turn']['tag']
  connected: boolean
  canSteer: boolean
  codexStatus: string | undefined
}

function steerSessionSnapshot(state: ClientSessionSnapshot): SteerSessionSnapshot {
  return {
    ...(state.threadId ? { threadId: state.threadId } : {}),
    turn: state.turn.tag,
    connected: state.connected,
    canSteer: state.canSteer !== false,
    codexStatus: state.providerId && state.providerId !== 'codex' ? 'ready' : state.harness?.codex.status,
  }
}

function steerSessionSnapshotEqual(
  left: SteerSessionSnapshot,
  right: SteerSessionSnapshot,
): boolean {
  return left.canSteer === right.canSteer && left.threadId === right.threadId
    && left.turn === right.turn
    && left.connected === right.connected
    && left.codexStatus === right.codexStatus
}

export function SteerSurface({
  queue,
  session,
}: ClientSurfaceProps & {
  queue: SteerQueue
  session: ClientConversationService
}): ReactNode {
  const state = useStoreSelector(session, steerSessionSnapshot, steerSessionSnapshotEqual)
  const queued = useSyncExternalStore(queue.subscribe, queue.snapshot)
  const messages = useMemo(
    () => queued.filter((message) => message.threadId === state.threadId),
    [queued, state.threadId],
  )
  const forwarding = useRef(false)
  const [draggingId, setDraggingId] = useState<string>()
  const [editingId, setEditingId] = useState<string>()
  const [editText, setEditText] = useState('')
  const [savingId, setSavingId] = useState<string>()
  const [editError, setEditError] = useState<string>()

  useEffect(() => queue.scopeTo(state.threadId), [state.threadId, queue])

  useEffect(() => {
    if (editingId && !messages.some((message) => message.id === editingId)) {
      setEditingId(undefined)
      setEditText('')
      setEditError(undefined)
    }
  }, [editingId, messages])

  useEffect(() => {
    if (
      forwarding.current
      || editingId
      || (state.threadId && isAgentChatId(state.threadId))
      || state.turn !== 'idle'
      || !state.connected
      || state.codexStatus !== 'ready'
      || !state.threadId
    ) return
    forwarding.current = true
    void queue.startNext(state.threadId)
      .catch(() => undefined)
      .finally(() => {
        forwarding.current = false
      })
  }, [editingId, messages, queue, session, state.connected, state.codexStatus, state.threadId, state.turn])

  if (!messages.length) return null

  const cancelEdit = (): void => {
    if (savingId) return
    setEditingId(undefined)
    setEditText('')
    setEditError(undefined)
  }

  const saveEdit = async (message: QueuedSteerMessage): Promise<void> => {
    if (savingId || message.state !== 'queued') return
    if (editText === message.draft.text) {
      cancelEdit()
      return
    }
    const updated = { ...message.draft, text: editText }
    if (
      !updated.text.trim()
      && !updated.images.length
      && !updated.attachments.length
      && !updated.skills.length
    ) {
      setEditError('A queued message cannot be empty.')
      return
    }
    setSavingId(message.id)
    setEditError(undefined)
    try {
      await queue.update(message.id, updated)
      setEditingId(undefined)
      setEditText('')
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingId(undefined)
    }
  }

  const steer = async (id: string): Promise<void> => {
    if (!state.threadId || state.turn !== 'running') return
    await queue.steer(id, session)
  }

  const dragOver = (event: DragEvent<HTMLDivElement>, targetId: string): void => {
    const sourceId = event.dataTransfer.getData('text/plain') || draggingId
    if (!sourceId || sourceId === targetId) return
    event.preventDefault()
    void queue.move(sourceId, targetId)
  }

  return (
    <section className="steer-queue" aria-label="Queued messages" aria-live="polite">
      {messages.map((message) => (
        <div
          className={`steer-row ${draggingId === message.id ? 'is-dragging' : ''} ${editingId === message.id ? 'is-editing' : ''}`}
          draggable={message.state === 'queued' && editingId !== message.id}
          onDragStart={(event) => {
            setDraggingId(message.id)
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', message.id)
          }}
          onDragOver={(event) => dragOver(event, message.id)}
          onDragEnd={() => setDraggingId(undefined)}
          key={message.id}
        >
          <span className="steer-drag" title="Drag to reorder" aria-hidden="true">
            <GripVertical size={14} />
            <CornerDownRight size={16} />
          </span>
          {editingId === message.id ? (
            <div className="steer-edit">
              <textarea
                className="steer-editor"
                value={editText}
                autoFocus
                aria-label="Edit queued message"
                disabled={savingId === message.id}
                onChange={(event) => setEditText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelEdit()
                  }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void saveEdit(message)
                  }
                }}
              />
              <div className="steer-edit-actions">
                <span>⌘↵ to save</span>
                <button
                  type="button"
                  title="Cancel editing"
                  aria-label="Cancel editing"
                  disabled={savingId === message.id}
                  onClick={cancelEdit}
                >
                  <X size={14} />
                </button>
                <button
                  type="button"
                  title="Save queued message"
                  aria-label="Save queued message"
                  disabled={savingId === message.id}
                  onClick={() => void saveEdit(message)}
                >
                  <Check size={14} />
                  <span>{savingId === message.id ? 'Saving…' : 'Save'}</span>
                </button>
              </div>
              {editError && <span className="steer-edit-error" role="status">{editError}</span>}
            </div>
          ) : (
            <>
              <span className="steer-message" title={messageLabel(message)}>
                {messageLabel(message)}
              </span>
          {message.draft.images.length > 0 && (
            <span className="steer-images" title={`${message.draft.images.length} attached`}>
              <ImageIcon size={13} /> {message.draft.images.length}
            </span>
          )}
          {message.draft.attachments.length > 0 && (
            <span className="steer-images" title={`${message.draft.attachments.length} attached`}>
              <Paperclip size={13} /> {message.draft.attachments.length}
            </span>
          )}
          <button
            className="steer-edit-button"
            type="button"
            disabled={message.state !== 'queued'}
            title="Edit queued message"
            aria-label="Edit queued message"
            onClick={() => {
              setEditingId(message.id)
              setEditText(message.draft.text)
              setEditError(undefined)
            }}
          >
            <Pencil size={14} />
          </button>
          <button
            className="steer-now"
            type="button"
            disabled={!state.canSteer || message.state === 'steering' || state.turn !== 'running'}
            title={state.canSteer ? "Add this message to the active turn" : "This agent supports queued messages; live steering is unavailable"}
            onClick={() => void steer(message.id)}
          >
            <CornerUpRight size={15} />
            <span>{message.state === 'steering' ? 'Steering…' : 'Steer'}</span>
          </button>
          <button
            className="steer-remove"
            type="button"
            title="Remove queued message"
            aria-label="Remove queued message"
            disabled={message.state === 'steering'}
            onClick={() => void queue.remove(message.id)}
          >
            <Trash2 size={15} />
          </button>
              {message.error && <span className="steer-error" role="status">{message.error}</span>}
            </>
          )}
        </div>
      ))}
    </section>
  )
}

const steerClient: BrowserPlugin = (ctx) => {
  const queue = new SteerQueue(ctx.clientHost)
  const session = ctx.clientConversation
  const service: ClientSteerService = { queue }
  ctx.provide('clientSteer', service)
  ctx.clientUi.registerSubmitMiddleware(
    ctx,
    createSteerSubmitMiddleware(queue, session),
    { activeTurn: true },
  )
  ctx.clientUi.registerSurface(
    ctx,
    'default-steer',
    (props) => <SteerSurface {...props} queue={queue} session={session} />,
  )
  ctx.clientUi.registerStyle(ctx, 'steer', String(styles))
  ctx.effect(() => () => queue.dispose(), 'steer.queue')
}

steerClient.inject = ['clientHost', 'clientUi', 'clientConversation']
steerClient.provide = 'clientSteer'
steerClient.resources = { provides: { surfaces: ['default-steer'] } }

export default steerClient
