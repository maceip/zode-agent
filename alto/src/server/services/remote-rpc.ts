import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { isRecord, errorMessage } from '../../shared/protocol.js'
import type { RemoteAgentBackend, RemoteAgentProcess, RemoteAgentRecord } from './remote-agent-api.js'

export interface RemoteRpcMessage {
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

export interface RemoteRpcObserver {
  message(direction: 'input' | 'output', message: RemoteRpcMessage, timestamp: string): void
  connection(state: 'connecting' | 'connected' | 'disconnected' | 'ended', message?: string): void
}

/** Detaching only stops journal reads. Only terminate() kills the remote process. */
export class RemoteRpc {
  private readonly abort = new AbortController()
  private readonly buffers = { input: '', output: '' }
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  private cursor?: string
  private reader?: Promise<void>
  private stderr = ''
  private ended = false
  private connected = false

  constructor(
    private readonly backend: RemoteAgentBackend,
    readonly process: RemoteAgentProcess,
    private readonly observer: RemoteRpcObserver,
  ) {}

  get isEnded(): boolean { return this.ended }
  get isConnected(): boolean { return this.connected && !this.abort.signal.aborted && !this.ended }

  async attach(replay = true): Promise<void> {
    this.observer.connection('connecting')
    try {
      if (replay) for await (const record of this.read(false)) this.accept(record)
      if (!this.ended && !this.abort.signal.aborted) {
        this.connected = true
        this.observer.connection('connected')
        this.reader = this.follow()
      }
    } catch (error) {
      this.observer.connection('disconnected', errorMessage(error))
      throw error
    }
  }

  private read(follow: boolean): AsyncIterable<RemoteAgentRecord> {
    return this.backend.read(this.process, {
      ...(this.cursor ? { after: this.cursor } : {}), follow, signal: this.abort.signal,
    })
  }

  private async follow(): Promise<void> {
    let failures = 0
    while (!this.abort.signal.aborted && !this.ended) {
      try {
        if (!this.connected) {
          for await (const record of this.read(false)) this.accept(record)
          if (this.ended || this.abort.signal.aborted) return
          this.connected = true
          this.observer.connection('connected')
        }
        for await (const record of this.read(true)) {
          if (this.abort.signal.aborted) return
          this.accept(record)
          if (!this.ended && !this.connected) {
            this.connected = true
            failures = 0
            this.observer.connection('connected')
          }
        }
        if (this.ended || this.abort.signal.aborted) return
        throw new Error('Remote progress stream disconnected')
      } catch (error) {
        if (this.abort.signal.aborted) return
        this.connected = false
        this.observer.connection('disconnected', errorMessage(error))
        await delay(Math.min(1000 * 2 ** failures++, 15_000), undefined, { signal: this.abort.signal }).catch(() => {})
      }
    }
  }

  private accept(record: RemoteAgentRecord): void {
    if (record.cursor && record.cursor === this.cursor) return
    if (record.stream === 'exit') {
      this.ended = true
      this.connected = false
      this.observer.connection('ended', this.stderr.trim() || `Remote agent exited (${record.code})`)
      for (const request of this.pending.values()) request.reject(new Error('Remote agent exited'))
      this.pending.clear()
    } else if (record.stream === 'error') this.stderr = (this.stderr + record.text).slice(-4000)
    else {
      const direction = record.stream
      this.buffers[direction] += record.text
      if (this.buffers[direction].length > 16 * 1024 * 1024) throw new Error('Remote agent sent an oversized protocol frame')
      let newline: number
      while ((newline = this.buffers[direction].indexOf('\n')) >= 0) {
        const line = this.buffers[direction].slice(0, newline)
        this.buffers[direction] = this.buffers[direction].slice(newline + 1)
        if (!line.trim()) continue
        let value: unknown
        try { value = JSON.parse(line) } catch { throw new Error('Remote agent sent invalid JSON-RPC') }
        if (!isRecord(value)) throw new Error('Remote agent sent an invalid protocol frame')
        const message = value as RemoteRpcMessage
        this.observer.message(direction, message, record.timestamp)
        if (direction === 'output' && message.id !== undefined && !message.method) {
          const pending = this.pending.get(String(message.id))
          this.pending.delete(String(message.id))
          if (message.error) pending?.reject(new Error(message.error.message ?? 'Remote agent request failed'))
          else pending?.resolve(message.result)
        }
      }
    }
    if (record.cursor) this.cursor = record.cursor
  }

  async send(message: RemoteRpcMessage): Promise<void> {
    if (this.abort.signal.aborted || this.ended) throw new Error('Remote session is not connected')
    // An ambiguous delivery failure must never trigger an automatic resend.
    // The recorded input establishes whether it reached the agent on reconnect.
    await this.backend.send(this.process, `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`, this.abort.signal)
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Remote ${method} timed out; reconnect before retrying`)) }, 45_000)
    })
    void response.catch(() => {})
    try {
      await this.send({ id, method, params })
      return await response
    } catch (error) {
      this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)))
      await response.catch(() => {})
      throw error
    } finally { clearTimeout(timer); this.pending.delete(id) }
  }

  async detach(): Promise<void> {
    this.abort.abort()
    this.connected = false
    for (const request of this.pending.values()) request.reject(new Error('Detached from remote agent'))
    this.pending.clear()
    await this.reader
  }
}
