import type {
  HarnessEvent,
  HarnessSnapshot,
  JsonValue,
} from '../shared/protocol.js'

const CONTROL_SECRET_FRAGMENT = 'alto-control'

export function controlSecretFromHash(hash: string): string | undefined {
  const value = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
    .get(CONTROL_SECRET_FRAGMENT)
    ?.trim()
  return value || undefined
}
import type {
  Command,
  CommandArgs,
  CommandResult,
  CommandType,
} from './commands.js'
import type {
  ClientHostService,
  ClientHostSnapshot,
} from './plugin-api.js'

interface PendingCommand {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: number
}

interface SocketSession {
  protocol: string
}

const COMMAND_TIMEOUT_MS = 120_000
const SOCKET_SESSION_TIMEOUT_MS = 10_000
const EVENT_JOURNAL_LIMIT = 4_096
const EVENT_JOURNAL_BYTES_LIMIT = 4 * 1024 * 1024

const NON_REPLAYED_NOTIFICATIONS = new Set([
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
])

function replayable(event: HarnessEvent): boolean {
  return event.type !== 'codex.notification'
    || !NON_REPLAYED_NOTIFICATIONS.has(event.payload.method)
}

function updateHarnessSnapshot(
  current: HarnessSnapshot | undefined,
  event: HarnessEvent,
): HarnessSnapshot | undefined {
  switch (event.type) {
    case 'snapshot':
      return event.payload
    case 'codex.status':
      return current ? { ...current, codex: event.payload } : current
    case 'program.updated':
      return current ? { ...current, ...event.payload } : current
    case 'program.candidate':
      return current
    case 'projects.updated':
      return current ? { ...current, projects: event.payload } : current
    case 'ui.updated':
      return current ? { ...current, ui: event.payload } : current
    case 'extensions.updated':
      return current ? { ...current, extensions: event.payload } : current
    case 'codex.serverRequest':
      return current ? {
        ...current,
        pendingRequests: [
          ...current.pendingRequests.filter((request) => request.id !== event.payload.id),
          event.payload,
        ],
      } : current
    case 'codex.serverRequest.resolved':
      return current ? {
        ...current,
        pendingRequests: current.pendingRequests.filter((request) => request.id !== event.payload.id),
      } : current
    case 'codex.notification':
    case 'codex.stderr':
    case 'program.error':
    case 'command.result':
      return current
  }
}

export class BrowserHost implements ClientHostService {
  private state: ClientHostSnapshot = {
    revision: 0,
    connectionEpoch: 0,
    connection: 'connecting',
    connected: false,
  }
  private socket?: WebSocket
  private reconnectTimer?: number
  private connectAbort?: AbortController
  private connectGeneration = 0
  private attempt = 0
  private running = false
  private commandId = 0
  private activeProgramRevision?: number
  private readonly pending = new Map<string, PendingCommand>()
  private readonly listeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: HarnessEvent) => void>()
  private readonly events: HarnessEvent[] = []
  private readonly eventSizes: number[] = []
  private eventBytes = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientHostSnapshot => this.state

  journal = (): readonly HarnessEvent[] => this.events

  onEvent = (listener: (event: HarnessEvent) => void, replay = false): (() => void) => {
    if (replay) {
      for (const event of this.events) listener(event)
    }
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  programActivated(revision: number): void {
    this.activeProgramRevision = revision
  }

  command: Command = <Type extends CommandType>(
    type: Type,
    ...args: CommandArgs<Type>
  ): Promise<CommandResult<Type>> => {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('the harness is not connected'))
    }
    const payload: unknown = args.at(0)
    const requestId = `browser-${++this.commandId}`
    return new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (!this.pending.delete(requestId)) return
        reject(new Error(`harness command timed out: ${type}`))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timeout })
      try {
        socket.send(JSON.stringify({
          type,
          requestId,
          ...(this.activeProgramRevision === undefined
            ? {}
            : { programRevision: this.activeProgramRevision }),
          ...(payload === undefined ? {} : { payload }),
        }))
      } catch (error) {
        this.pending.delete(requestId)
        window.clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }) as Promise<CommandResult<Type>>
  }

  async call(method: string, payload?: JsonValue): Promise<JsonValue> {
    const result = await this.command('extension.call', {
      method,
      ...(payload === undefined ? {} : { payload }),
    })
    return result as JsonValue
  }

  start(): () => void {
    if (this.running) return () => this.stop()
    this.running = true
    this.connect()
    return () => this.stop()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.connectGeneration += 1
    this.connectAbort?.abort()
    delete this.connectAbort
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer)
    delete this.reconnectTimer
    this.socket?.close()
    delete this.socket
    this.rejectPending(new Error('connection closed'))
  }

  private connect(): void {
    if (!this.running) return
    const generation = ++this.connectGeneration
    this.connectAbort?.abort()
    const abort = new AbortController()
    this.connectAbort = abort
    void this.connectAuthenticated(generation, abort)
  }

  private async connectAuthenticated(generation: number, abort: AbortController): Promise<void> {
    const timeout = window.setTimeout(
      () => abort.abort(new Error('socket session timed out')),
      SOCKET_SESSION_TIMEOUT_MS,
    )
    try {
      const controlSecret = controlSecretFromHash(window.location.hash)
      if (!controlSecret) throw new Error('Alto control session is missing its launch credential')
      const response = await fetch('/__cordis/session', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Authorization: `Bearer ${controlSecret}` },
        signal: abort.signal,
      })
      if (!response.ok) throw new Error(`socket session failed (${response.status})`)
      const session = await response.json() as Partial<SocketSession>
      if (typeof session.protocol !== 'string' || !session.protocol) {
        throw new Error('socket session did not provide a protocol')
      }
      if (!this.running || generation !== this.connectGeneration) return
      delete this.connectAbort
      this.openSocket(session.protocol)
    } catch (error) {
      if (!this.running || generation !== this.connectGeneration) return
      delete this.connectAbort
      this.setState({
        connection: 'retrying',
        connected: false,
        problem: error instanceof Error ? error.message : String(error),
      })
      this.scheduleReconnect()
    } finally {
      window.clearTimeout(timeout)
    }
  }

  private openSocket(socketProtocol: string): void {
    if (!this.running) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`, socketProtocol)
    this.socket = socket
    socket.addEventListener('open', () => {
      if (!this.running || this.socket !== socket) {
        socket.close()
        return
      }
      delete this.activeProgramRevision
      this.attempt = 0
      this.setState({ connection: 'online', connected: true, problem: undefined })
    })
    socket.addEventListener('message', (message) => {
      if (!this.running || this.socket !== socket) return
      try {
        const serialized = String(message.data)
        this.receive(JSON.parse(serialized) as HarnessEvent, serialized.length * 2)
      } catch (error) {
        this.setState({
          connection: 'online',
          connected: true,
          problem: error instanceof Error ? error.message : String(error),
        })
      }
    })
    socket.addEventListener('error', () => {
      if (!this.running || this.socket !== socket) return
      this.setState({
        connection: 'retrying',
        connected: false,
        problem: 'Unable to reach the local harness server.',
      })
    })
    socket.addEventListener('close', () => {
      // A stopped socket can close after a replacement has already connected.
      // Ignore it so it cannot schedule another connection alongside the live one.
      if (this.socket !== socket) return
      delete this.socket
      this.rejectPending(new Error('connection lost before the harness replied'))
      this.setState({ connection: 'retrying', connected: false })
      if (!this.running) return
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== undefined) return
    const delay = Math.min(5_000, 300 * (2 ** this.attempt++))
    this.reconnectTimer = window.setTimeout(() => {
      delete this.reconnectTimer
      this.connect()
    }, delay)
  }

  private receive(event: HarnessEvent, serializedBytes: number): void {
    if (event.type === 'command.result') {
      const command = this.pending.get(event.requestId)
      if (!command) return
      this.pending.delete(event.requestId)
      window.clearTimeout(command.timeout)
      if (event.error) command.reject(new Error(event.error))
      else command.resolve(event.payload)
      return
    }

    if (replayable(event)) {
      this.events.push(event)
      this.eventSizes.push(serializedBytes)
      this.eventBytes += serializedBytes
      let drop = Math.max(0, this.events.length - EVENT_JOURNAL_LIMIT)
      for (let index = 0; index < drop; index += 1) {
        this.eventBytes -= this.eventSizes[index] ?? 0
      }
      while (this.eventBytes > EVENT_JOURNAL_BYTES_LIMIT && drop < this.events.length) {
        this.eventBytes -= this.eventSizes[drop] ?? 0
        drop += 1
      }
      if (drop > 0) {
        this.events.splice(0, drop)
        this.eventSizes.splice(0, drop)
      }
    }
    const snapshot = updateHarnessSnapshot(this.state.snapshot, event)
    if (snapshot !== this.state.snapshot || event.type === 'snapshot') {
      this.setState({
        snapshot,
        ...(event.type === 'snapshot'
          ? { connectionEpoch: this.state.connectionEpoch + 1 }
          : {}),
      })
    }
    for (const listener of this.eventListeners) listener(event)
  }

  private rejectPending(error: Error): void {
    for (const command of this.pending.values()) {
      window.clearTimeout(command.timeout)
      command.reject(error)
    }
    this.pending.clear()
  }

  private setState(change: Partial<ClientHostSnapshot>): void {
    const next = { ...this.state, ...change, revision: this.state.revision + 1 }
    if (change.problem === undefined && 'problem' in change) delete next.problem
    if (change.snapshot === undefined && 'snapshot' in change) delete next.snapshot
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

export const clientHost = new BrowserHost()
