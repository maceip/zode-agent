import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { errorMessage, isRecord, type JsonValue } from '../../src/shared/protocol.js'
import { SEAL_CLAIM, SEAL_MAX_BYTES, SEAL_PRESENCE, SEAL_RESULT, SEAL_STATE, type SealRequest, type SealResult, type SealTarget } from './seal-api.js'

interface Pending {
  request: SealRequest
  claimed: boolean
  resolve(result: SealResult): void
  timer: ReturnType<typeof setTimeout>
}

export class SealInbox {
  private readonly clients = new Map<string, { target: SealTarget | undefined; focusedAt: number; seenAt: number }>()
  private readonly pending = new Map<string, Pending>()
  private active = true

  constructor(private readonly publish: (requests: SealRequest[]) => void, private readonly timeoutMs = 15_000) {}

  presence(value: unknown): void {
    if (!isRecord(value) || typeof value.clientId !== 'string' || typeof value.focusedAt !== 'number') {
      throw new Error('Invalid Seal browser presence')
    }
    const candidate = value.target
    let target: SealTarget | undefined
    if (isRecord(candidate)
      && typeof candidate.workspaceId === 'string' && typeof candidate.paneId === 'string'
      && typeof candidate.workspace === 'string' && typeof candidate.title === 'string'
      && (candidate.threadId === undefined || typeof candidate.threadId === 'string')) {
      target = { clientId: value.clientId, workspaceId: candidate.workspaceId, paneId: candidate.paneId,
        workspace: candidate.workspace, title: candidate.title,
        ...(typeof candidate.threadId === 'string' ? { threadId: candidate.threadId } : {}) }
    }
    this.clients.set(value.clientId, { target, focusedAt: value.focusedAt, seenAt: Date.now() })
    for (const [id, client] of this.clients) {
      if (Date.now() - client.seenAt > 15_000) this.clients.delete(id)
    }
  }

  target(): SealTarget | undefined {
    const client = [...this.clients.values()]
      .filter((entry) => Date.now() - entry.seenAt <= 15_000)
      .sort((left, right) => right.focusedAt - left.focusedAt)[0]
    return client?.target
  }

  send(value: unknown): Promise<SealResult> {
    if (!this.active) return Promise.resolve({ ok: false, error: 'The Seal plugin is stopped' })
    if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim()
      || typeof value.context !== 'string' || (value.mode !== 'queue' && value.mode !== 'steer')) {
      return Promise.resolve({ ok: false, error: 'Seal needs text, editor context, and queue or steer mode' })
    }
    const target = this.target()
    if (!target) return Promise.resolve({ ok: false, error: 'No Alto chat is selected or open to the left of the active pane' })
    if (this.pending.size >= 32) return Promise.resolve({ ok: false, error: 'Too many pending Seal handoffs' })
    const request: SealRequest = { id: randomUUID(), text: value.text, context: value.context, mode: value.mode, target: { ...target } }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.id)
        if (!pending) return
        this.finish(request.id, { ok: false, error: pending.claimed
          ? 'Alto did not confirm delivery; check the chat and queue before retrying'
          : 'Alto did not receive the handoff; check the connection and try again' })
      }, this.timeoutMs)
      this.pending.set(request.id, { request, claimed: false, resolve, timer })
      this.update()
    })
  }

  claim(value: unknown): boolean {
    if (!isRecord(value) || typeof value.id !== 'string') return false
    const pending = this.pending.get(value.id)
    if (!pending || pending.request.target.clientId !== value.clientId || pending.claimed) return false
    pending.claimed = true
    return true
  }

  result(value: unknown): boolean {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.ok !== 'boolean') return false
    const pending = this.pending.get(value.id)
    if (!pending?.claimed || pending.request.target.clientId !== value.clientId) return false
    this.finish(value.id, value.ok ? { ok: true, target: pending.request.target }
      : { ok: false, error: typeof value.error === 'string' ? value.error : 'Alto could not send the prompt' })
    return true
  }

  dispose(): void {
    this.active = false
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error: 'The Seal plugin was unloaded; check Alto before retrying' })
    }
    this.pending.clear()
    this.clients.clear()
  }

  private finish(id: string, result: SealResult): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    this.update()
    pending.resolve(result)
  }

  private update(): void {
    if (this.active) this.publish([...this.pending.values()].map(({ request }) => request))
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  const existing = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!existing) return
  if (!existing.isSocket()) throw new Error(`Seal socket path is occupied by a file: ${socketPath}`)
  const live = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(socketPath)
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.destroy()
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false)
      else reject(error)
    })
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Another Seal socket is unresponsive')) })
  })
  if (live) throw new Error('Another Alto instance already owns the Seal socket')
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
}

const seal: HarnessPlugin<{ socketPath?: string }> = (ctx, config) => {
  const socketPath = config.socketPath ?? path.join(homedir(), '.cache', 'alto', 'seal.sock')
  let active = true
  let listening = false
  let problem: string | undefined
  const state = ctx.clientExtensions.registerState(ctx, SEAL_STATE, { version: 1, requests: [] })
  const inbox = new SealInbox((requests) => {
    if (active) state.update({ version: 1, requests } as unknown as JsonValue)
  })
  ctx.clientExtensions.registerMethod(ctx, SEAL_PRESENCE, (value) => { inbox.presence(value); return { ok: true } })
  ctx.clientExtensions.registerMethod(ctx, SEAL_CLAIM, (value) => ({ claimed: inbox.claim(value) }))
  ctx.clientExtensions.registerMethod(ctx, SEAL_RESULT, (value) => ({ accepted: inbox.result(value) }))
  const status = (): JsonValue => ({ listening, socketPath, target: inbox.target() ?? null, error: problem ?? null }) as JsonValue
  ctx.tools.register(ctx, {
    namespace: 'seal', name: 'status', description: 'Shows the local Neovim socket and the Alto chat selected for Seal handoffs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }, () => status() as Record<string, unknown>)

  ctx.effect(() => {
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', () => undefined)
      socket.setEncoding('utf8')
      socket.setTimeout(20_000, () => socket.destroy())
      let buffer = ''
      let received = false
      socket.on('data', (chunk: string) => {
        if (received) return
        buffer += chunk
        if (Buffer.byteLength(buffer) > SEAL_MAX_BYTES) { received = true; socket.end(JSON.stringify({ ok: false, error: 'Seal handoff is too large' }) + '\n'); return }
        const end = buffer.indexOf('\n')
        if (end < 0) return
        received = true
        let value: unknown
        try { value = JSON.parse(buffer.slice(0, end)) } catch { socket.end(JSON.stringify({ ok: false, error: 'Invalid Seal JSON' }) + '\n'); return }
        if (!isRecord(value) || value.version !== 1) { socket.end(JSON.stringify({ ok: false, error: 'Unsupported Seal protocol version' }) + '\n'); return }
        if (value.action === 'status') { socket.end(JSON.stringify({ ok: true, ...status() as object }) + '\n'); return }
        if (value.action !== 'send') { socket.end(JSON.stringify({ ok: false, error: 'Unknown Seal action' }) + '\n'); return }
        void inbox.send(value).then((result) => { if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n') })
      })
    })
    server.on('error', (error) => { problem = errorMessage(error); listening = false })
    const opening = (async () => {
      const directory = path.dirname(socketPath)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error('Seal needs a private socket directory owned by the current user')
      await chmod(directory, 0o700)
      await removeStaleSocket(socketPath)
      if (!active) return
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => { server.off('error', reject); resolve() })
      })
      await chmod(socketPath, 0o600)
      listening = true
    })().catch((error) => { problem = errorMessage(error) })
    return async () => {
      active = false
      inbox.dispose()
      await opening
      for (const socket of sockets) socket.destroy()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      if (listening) await unlink(socketPath).catch(() => undefined)
      listening = false
    }
  }, 'seal.localSocket')
}

seal.inject = ['clientExtensions', 'tools']
export default seal
