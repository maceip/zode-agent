import { createServer, type IncomingMessage, type Server } from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context, Plugin } from 'cordis'
import express from 'express'
import { WebSocket, WebSocketServer } from 'ws'
import type {
  BrowserCommand,
  HarnessEvent,
  HarnessSnapshot,
  PendingServerRequest,
  ProjectSnapshot,
  RpcId,
  RpcNotification,
} from '../../shared/protocol.js'
import { errorMessage, isRecord } from '../../shared/protocol.js'
import type { CodexSnapshot } from './codex-service.js'
import { turnInputsFor } from './turn-input.js'

interface ViteDevServer {
  middlewares: express.RequestHandler
  close(): Promise<void>
}

export interface WebGatewayOptions {
  projectRoot: string
  controlSecret: string
  host?: string
  port?: number
  development?: boolean
  onListening?(address: WebGatewayAddress): void
}

export interface WebGatewayAddress {
  host: string
  port: number
}

export const CONTROL_SECRET_FRAGMENT = 'alto-control'

export function controlSessionUrl(origin: string, controlSecret: string): string {
  const url = new URL(origin)
  url.hash = new URLSearchParams({ [CONTROL_SECRET_FRAGMENT]: controlSecret }).toString()
  return url.toString()
}

export function controlSessionAllowed(
  authorization: string | undefined,
  controlSecret: string,
): boolean {
  const prefix = 'Bearer '
  if (!authorization?.startsWith(prefix)) return false
  const candidate = Buffer.from(authorization.slice(prefix.length), 'utf8')
  const expected = Buffer.from(controlSecret, 'utf8')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

function contentSecurityPolicy(scriptSource: string): string {
  return `default-src 'self'; script-src ${scriptSource}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src http: https:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`
}

export const WEB_SECURITY_HEADERS = {
  'Content-Security-Policy': contentSecurityPolicy("'self'"),
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
} as const

export function webSecurityHeaders(developmentNonce?: string): Record<string, string> {
  if (!developmentNonce) return { ...WEB_SECURITY_HEADERS }
  return {
    ...WEB_SECURITY_HEADERS,
    'Content-Security-Policy': contentSecurityPolicy(`'self' 'nonce-${developmentNonce}'`),
  }
}

const SOCKET_MAX_PAYLOAD = 16 * 1024 * 1024
const SOCKET_MAX_BUFFERED = 8 * 1024 * 1024
const SOCKET_MAX_IN_FLIGHT = 32
const SOCKET_HEARTBEAT_MS = 30_000
const CLIENT_ACTIVATION_TIMEOUT_MS = 30_000

interface PendingClientActivation {
  revision: number
  socket: WebSocket
  timeout: NodeJS.Timeout
  resolve(): void
  reject(error: Error): void
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
}

export function loopbackBindHost(host: string): boolean {
  const normalized = normalizedHostname(host)
  if (normalized === 'localhost' || normalized === '::1') return true
  const ipv4 = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized
  return isIP(ipv4) === 4 && ipv4.split('.')[0] === '127'
}

function allowedHostnames(bindHost: string): Set<string> {
  const normalized = normalizedHostname(bindHost)
  const allowed = new Set<string>([normalized])
  const loopback = normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
  if (loopback) {
    allowed.add('localhost')
    allowed.add('127.0.0.1')
    allowed.add('::1')
  }
  return allowed
}

export function requestAuthorityAllowed(
  authority: string | undefined,
  bindHost: string,
  port: number,
): boolean {
  if (!authority) return false
  try {
    const url = new URL(`http://${authority}`)
    if (
      url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) return false
    const requestPort = url.port ? Number.parseInt(url.port, 10) : 80
    return requestPort === port
      && allowedHostnames(bindHost).has(normalizedHostname(url.hostname))
  } catch {
    return false
  }
}

export function websocketAdmissionAllowed(
  origin: string | undefined,
  authority: string | undefined,
  protocolHeader: string | undefined,
  expectedProtocol: string,
  bindHost: string,
  port: number,
): boolean {
  if (!origin || !authority || !requestAuthorityAllowed(authority, bindHost, port)) return false
  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false
  if (
    originUrl.username
    || originUrl.password
    || originUrl.pathname !== '/'
    || originUrl.search
    || originUrl.hash
  ) return false
  if (originUrl.host.toLowerCase() !== authority.toLowerCase()) return false
  return (protocolHeader ?? '').split(',').map((value) => value.trim()).includes(expectedProtocol)
}

export function reserveCommand(
  commands: Set<string>,
  requestId: string,
  limit = SOCKET_MAX_IN_FLIGHT,
): () => void {
  if (commands.has(requestId)) throw new Error(`duplicate requestId: ${requestId}`)
  if (commands.size >= limit) throw new Error('too many in-flight browser commands')
  commands.add(requestId)
  let active = true
  return () => {
    if (!active) return
    active = false
    commands.delete(requestId)
  }
}

function parseCommand(data: Buffer | ArrayBuffer | Buffer[]): BrowserCommand {
  const parsed: unknown = JSON.parse(Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data).toString('utf8'))
  if (!isRecord(parsed) || typeof parsed.type !== 'string' || typeof parsed.requestId !== 'string') {
    throw new Error('browser commands need a type and requestId')
  }
  return parsed as BrowserCommand
}

export class WebGateway {
  readonly host: string
  port: number

  private readonly app = express()
  private readonly server: Server
  private readonly sockets: WebSocketServer
  private readonly socketProtocol = `alto.${randomBytes(32).toString('base64url')}`
  private readonly socketAlive = new WeakSet<WebSocket>()
  private readonly socketCommands = new WeakMap<WebSocket, Set<string>>()
  private heartbeat?: NodeJS.Timeout
  private developmentNonce?: string
  private vite?: ViteDevServer
  private primarySocket?: WebSocket
  private pendingActivation?: PendingClientActivation

  constructor(
    private readonly ctx: Context,
    private readonly options: WebGatewayOptions,
  ) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 4317
    if (!loopbackBindHost(this.host)) {
      throw new Error(
        `refusing to bind Alto to ${this.host}: remote serving has no authentication; use a loopback host`,
      )
    }
    this.server = createServer(this.app)
    this.sockets = new WebSocketServer({
      server: this.server,
      path: '/ws',
      maxPayload: SOCKET_MAX_PAYLOAD,
      perMessageDeflate: false,
      verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) => websocketAdmissionAllowed(
        origin,
        req.headers.host,
        req.headers['sec-websocket-protocol'],
        this.socketProtocol,
        this.host,
        this.port,
      ),
      handleProtocols: (protocols) => (
        protocols.has(this.socketProtocol) ? this.socketProtocol : false
      ),
    })
  }

  private development(): boolean {
    return this.options.development ?? process.env.NODE_ENV !== 'production'
  }

  async start(): Promise<() => Promise<void>> {
    // Vite injects the React refresh preamble as an inline script in development,
    // so the dev policy carries a nonce that Vite stamps onto those tags.
    if (this.development()) this.developmentNonce = randomBytes(16).toString('base64')
    const securityHeaders = webSecurityHeaders(this.developmentNonce)
    this.app.use((_request, response, next) => {
      for (const [name, value] of Object.entries(securityHeaders)) {
        response.setHeader(name, value)
      }
      next()
    })
    this.app.use((request, response, next) => {
      if (requestAuthorityAllowed(request.headers.host, this.host, this.port)) {
        next()
        return
      }
      response.status(403).type('text/plain').send('Invalid host')
    })
    this.app.get('/__cordis/session', (request, response) => {
      if (!controlSessionAllowed(request.headers.authorization, this.options.controlSecret)) {
        response
          .status(401)
          .set('Cache-Control', 'no-store')
          .set('WWW-Authenticate', 'Bearer realm="Alto control session"')
          .type('text/plain')
          .send('Authentication required')
        return
      }
      response
        .set('Cache-Control', 'no-store')
        .set('Cross-Origin-Resource-Policy', 'same-origin')
        .json({ protocol: this.socketProtocol })
    })
    this.app.get('/__cordis/health', (_request, response) => {
      response.json({ name: 'alto' })
    })
    this.configureClientPlugins()
    await this.configureFrontend()
    this.attachEvents()
    const releaseClientActivator = this.ctx.program.setClientActivator((snapshot) => (
      this.activateClientProgram(snapshot)
    ))
    this.sockets.on('connection', (socket) => {
      if (!this.primarySocket || this.primarySocket.readyState !== WebSocket.OPEN) {
        this.primarySocket = socket
      }
      this.socketAlive.add(socket)
      this.socketCommands.set(socket, new Set())
      socket.on('pong', () => this.socketAlive.add(socket))
      socket.on('error', () => socket.terminate())
      socket.on('close', () => this.socketClosed(socket))
      this.send(socket, { type: 'snapshot', payload: this.snapshot() })
      socket.on('message', (data) => {
        void this.handleSocketMessage(socket, data)
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject)
        try {
          const address = this.server.address()
          if (!address || typeof address === 'string') {
            throw new Error('Alto web gateway did not bind a TCP port')
          }
          this.port = address.port
          this.options.onListening?.({ host: this.host, port: this.port })
          resolve()
        } catch (error) {
          this.server.close(() => reject(error))
        }
      })
    })
    this.heartbeat = setInterval(() => this.heartbeatSockets(), SOCKET_HEARTBEAT_MS)
    this.heartbeat.unref()

    return async () => {
      releaseClientActivator()
      this.rejectPendingActivation(new Error('server stopping'))
      if (this.heartbeat) clearInterval(this.heartbeat)
      delete this.heartbeat
      for (const socket of this.sockets.clients) socket.close(1001, 'server stopping')
      await new Promise<void>((resolve) => this.sockets.close(() => resolve()))
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => error ? reject(error) : resolve())
      })
      await this.vite?.close()
    }
  }

  private configureClientPlugins(): void {
    this.app.get('/__cordis/client/:id/:hash.mjs', async (request, response) => {
      const id = String(request.params.id)
      const hash = String(request.params.hash)
      const bundle = await this.ctx.program.clientBundle(id, hash)
      if (!bundle) {
        response.status(404).type('text/plain').send('Unknown Cordis browser plugin bundle')
        return
      }
      response
        .status(200)
        .set('Content-Type', 'text/javascript; charset=utf-8')
        .set('Cache-Control', 'public, max-age=31536000, immutable')
        .send(bundle)
    })
  }

  private async configureFrontend(): Promise<void> {
    if (this.development()) {
      const { createServer: createViteServer } = await import('vite')
      this.vite = await createViteServer({
        root: this.options.projectRoot,
        appType: 'spa',
        ...(this.developmentNonce ? { html: { cspNonce: this.developmentNonce } } : {}),
        server: { middlewareMode: true },
      }) as ViteDevServer
      this.app.use(this.vite.middlewares)
      return
    }

    const clientRoot = path.join(this.options.projectRoot, 'dist', 'client')
    this.app.use(express.static(clientRoot))
    this.app.get('*path', (_request, response) => {
      response.sendFile(path.join(clientRoot, 'index.html'))
    })
  }

  private attachEvents(): void {
    this.ctx.on('codex/notification', (notification: RpcNotification) => {
      this.broadcast({ type: 'codex.notification', payload: notification })
    })
    this.ctx.on('program/changed', (snapshot) => {
      this.broadcast({
        type: 'program.updated',
        payload: {
          program: snapshot,
          projects: this.ctx.projects.snapshot(),
          ui: this.ctx.ui.snapshot(),
          extensions: this.ctx.clientExtensions.snapshot(),
        },
      })
    })
    this.ctx.on('program/error', (error) => {
      this.broadcast({ type: 'program.error', payload: { message: error.message } })
    })
    this.ctx.on('projects/changed', (snapshot: ProjectSnapshot) => {
      if (this.ctx.program.isActivating()) return
      this.broadcast({ type: 'projects.updated', payload: snapshot })
    })
    this.ctx.on('ui/changed', (snapshot) => {
      if (this.ctx.program.isActivating()) return
      this.broadcast({ type: 'ui.updated', payload: snapshot })
    })
    this.ctx.on('clientExtensions/changed', (snapshot) => {
      if (this.ctx.program.isActivating()) return
      this.broadcast({ type: 'extensions.updated', payload: snapshot })
    })
    this.ctx.codex.on('status', (snapshot: CodexSnapshot) => {
      this.broadcast({ type: 'codex.status', payload: snapshot })
    })
    this.ctx.codex.on('stderr', (text: string) => {
      this.broadcast({ type: 'codex.stderr', payload: { text } })
    })
    this.ctx.codex.on('serverRequest', (request: PendingServerRequest) => {
      this.broadcast({ type: 'codex.serverRequest', payload: request })
    })
    this.ctx.codex.on('serverRequestResolved', (id: RpcId) => {
      this.broadcast({ type: 'codex.serverRequest.resolved', payload: { id } })
    })
  }

  private snapshot(): HarnessSnapshot {
    return {
      codex: this.ctx.codex.snapshot(),
      program: this.ctx.program.snapshot(),
      projects: this.ctx.projects.snapshot(),
      ui: this.ctx.ui.snapshot(),
      extensions: this.ctx.clientExtensions.snapshot(),
      pendingRequests: this.ctx.codex.pendingRequests(),
      server: {
        host: this.host,
        port: this.port,
        projectRoot: this.options.projectRoot,
      },
    }
  }

  private async handleSocketMessage(
    socket: WebSocket,
    data: Buffer | ArrayBuffer | Buffer[],
  ): Promise<void> {
    let command: BrowserCommand | undefined
    let releaseCommand: (() => void) | undefined
    try {
      command = parseCommand(data)
      const commands = this.socketCommands.get(socket)
      if (!commands) throw new Error('socket is no longer active')
      releaseCommand = reserveCommand(commands, command.requestId)
      const payload = await this.handleCommand(socket, command)
      this.send(socket, {
        type: 'command.result',
        requestId: command.requestId,
        ...(payload === undefined ? {} : { payload }),
      })
    } catch (error) {
      this.send(socket, {
        type: 'command.result',
        requestId: command?.requestId ?? 'unknown',
        error: errorMessage(error),
      })
    } finally {
      releaseCommand?.()
    }
  }

  private async handleCommand(socket: WebSocket, command: BrowserCommand): Promise<unknown> {
    switch (command.type) {
      case 'program.client.ready':
        this.resolveClientActivation(socket, command.payload)
        return undefined
      case 'extension.call':
        this.assertProgramRevision(command)
        return this.ctx.clientExtensions.call(
          command.payload.method,
          command.payload.payload,
        )
      case 'chat.send': {
        let { threadId } = command.payload
        let thread: unknown
        if (!threadId) {
          const response = await this.ctx.codex.startThread(command.payload)
          thread = response.thread
          threadId = response.thread?.id
        }
        if (!threadId) throw new Error('unable to create a Codex thread')
        const turn = await this.ctx.codex.startTurn(
          threadId,
          turnInputsFor(command.payload),
          command.payload,
        )
        return { threadId, thread, turn: turn.turn }
      }
      case 'skill.list':
        return this.ctx.codex.listSkills(command.payload.workspace)
      case 'thread.new':
        return this.ctx.codex.startThread(command.payload)
      case 'thread.list':
        return this.ctx.codex.listThreads(command.payload.limit)
      case 'thread.open':
        return this.ctx.codex.openThread(
          command.payload.threadId,
          command.payload,
        )
      case 'thread.page':
        return this.ctx.codex.listThreadTurns(
          command.payload.threadId,
          command.payload.cursor,
          command.payload.limit,
        )
      case 'project.save':
        return this.ctx.projects.save(command.payload)
      case 'project.remove':
        return this.ctx.projects.remove(command.payload.id)
      case 'turn.interrupt':
        return this.ctx.codex.interrupt(command.payload.threadId)
      case 'turn.steer':
        return this.ctx.codex.steer(
          command.payload.threadId,
          turnInputsFor(command.payload),
        )
      case 'serverRequest.resolve':
        return this.ctx.codex.resolveServerRequest(
          command.payload.id,
          command.payload.result,
        )
      case 'program.apply':
        this.assertProgramRevision(command)
        await this.ctx.program.applyProgram(
          command.payload.profileText,
          command.payload.files,
        )
        return this.ctx.program.snapshot()
      case 'program.reload':
        this.assertProgramRevision(command)
        await this.ctx.program.reconcile(true)
        return this.ctx.program.snapshot()
      case 'program.plugin.setEnabled':
        this.assertProgramRevision(command)
        return this.ctx.program.setPluginEnabled(
          command.payload.id,
          command.payload.enabled,
        )
      case 'program.proposal.resolve':
        this.assertProgramRevision(command)
        await this.ctx.program.resolveProposal(
          command.payload.id,
          command.payload.decision,
        )
        return this.ctx.program.snapshot()
      case 'ui.action':
        this.assertProgramRevision(command)
        return this.ctx.ui.execute(command.payload)
    }
  }

  private assertProgramRevision(command: BrowserCommand): void {
    const expected = this.ctx.program.commandRevision()
    if (command.programRevision === expected) return
    throw new Error(
      `browser program revision ${command.programRevision ?? 'unknown'} is incompatible with server revision ${expected}`,
    )
  }

  private activateClientProgram(snapshot: HarnessSnapshot['program']): Promise<void> {
    const socket = this.primarySocket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve()
    if (this.pendingActivation) {
      return Promise.reject(new Error('another browser program activation is already pending'))
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingActivation?.revision !== snapshot.revision) return
        delete this.pendingActivation
        reject(new Error(`browser did not activate program revision ${snapshot.revision} in time`))
      }, CLIENT_ACTIVATION_TIMEOUT_MS)
      this.pendingActivation = { revision: snapshot.revision, socket, timeout, resolve, reject }
      this.send(socket, {
        type: 'program.candidate',
        payload: {
          program: snapshot,
          ui: this.ctx.ui.snapshot(),
          extensions: this.ctx.clientExtensions.snapshot(),
        },
      })
    })
  }

  private resolveClientActivation(
    socket: WebSocket,
    result: Extract<BrowserCommand, { type: 'program.client.ready' }>['payload'],
  ): void {
    const pending = this.pendingActivation
    if (!pending || pending.socket !== socket || pending.revision !== result.revision) {
      throw new Error(`unexpected browser activation acknowledgement for revision ${result.revision}`)
    }
    clearTimeout(pending.timeout)
    delete this.pendingActivation
    if (result.success) pending.resolve()
    else pending.reject(new Error(result.error || `browser rejected program revision ${result.revision}`))
  }

  private rejectPendingActivation(error: Error): void {
    const pending = this.pendingActivation
    if (!pending) return
    clearTimeout(pending.timeout)
    delete this.pendingActivation
    pending.reject(error)
  }

  private socketClosed(socket: WebSocket): void {
    if (this.pendingActivation?.socket === socket) {
      this.rejectPendingActivation(new Error('primary browser disconnected during program activation'))
    }
    if (this.primarySocket !== socket) return
    const replacement = [...this.sockets.clients].find((candidate) => (
      candidate !== socket && candidate.readyState === WebSocket.OPEN
    ))
    if (replacement) this.primarySocket = replacement
    else delete this.primarySocket
  }

  private broadcast(event: HarnessEvent): void {
    const payload = JSON.stringify(event)
    for (const socket of this.sockets.clients) this.sendPayload(socket, payload)
  }

  private send(socket: WebSocket, event: HarnessEvent): void {
    this.sendPayload(socket, JSON.stringify(event))
  }

  private sendPayload(socket: WebSocket, payload: string): void {
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > SOCKET_MAX_BUFFERED) {
      socket.terminate()
      return
    }
    socket.send(payload, (error) => {
      if (error) socket.terminate()
    })
  }

  private heartbeatSockets(): void {
    for (const socket of this.sockets.clients) {
      if (!this.socketAlive.has(socket)) {
        socket.terminate()
        continue
      }
      this.socketAlive.delete(socket)
      if (socket.readyState !== WebSocket.OPEN) continue
      try {
        socket.ping()
      } catch {
        socket.terminate()
      }
    }
  }
}

export const webGatewayPlugin: Plugin<WebGatewayOptions> = async (
  ctx: Context,
  options: WebGatewayOptions,
) => {
  const gateway = new WebGateway(ctx, options)
  return gateway.start()
}

webGatewayPlugin.inject = ['clientExtensions', 'codex', 'program', 'projects', 'ui']
