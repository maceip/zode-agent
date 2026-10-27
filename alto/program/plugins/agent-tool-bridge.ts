import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import express from 'express'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type ContentBlock, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { DynamicToolCall } from '../../src/server/plugin-api.js'
import type { DynamicToolRegistry } from '../../src/server/services/tool-registry.js'
import type { AgentMcpServer } from '../../src/server/services/agent-registry.js'

export type AgentToolContext = Pick<DynamicToolCall, 'threadId' | 'turnId' | 'permissionMode'>

export class AgentToolBridge {
  private readonly tokens = new Map<string, string>()
  private readonly requests = new Set<Server>()
  private server?: HttpServer
  private opening?: Promise<string>
  private active = true

  constructor(private readonly tools: DynamicToolRegistry, private readonly context: (chatId: string) => AgentToolContext | undefined) {}

  async attach(chatId: string): Promise<AgentMcpServer[]> {
    if (!this.active) throw new Error('Cordis bridge is closed')
    const url = await (this.opening ??= this.listen())
    if (!this.active) throw new Error('Cordis bridge is closed')
    let token = [...this.tokens].find(([, id]) => id === chatId)?.[0]
    if (!token) { token = randomBytes(32).toString('base64url'); this.tokens.set(token, chatId) }
    return [{ type: 'http', name: 'alto', url, headers: { Authorization: `Bearer ${token}` } }]
  }

  revoke(chatId: string): void {
    for (const [token, id] of this.tokens) if (id === chatId) this.tokens.delete(token)
  }

  private async listen(): Promise<string> {
    const app = express()
    app.use((req, res, next) => {
      if (!this.active || req.headers.origin || req.headers.host !== this.address()) { res.sendStatus(403); return }
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
      const chatId = this.tokens.get(token)
      if (!chatId) { res.sendStatus(401); return }
      res.locals.chatId = chatId
      res.locals.token = token
      next()
    })
    app.post('/mcp', express.json({ limit: '4mb' }), async (req, res) => {
      const chatId = res.locals.chatId as string
      const server = new Server({ name: 'Alto Cordis', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'You are running inside Alto. The cordis tool discovers and invokes the live Alto capabilities. Use its list and describe operations before invoking tools. Inspect cordis_runtime_status before changing UI. Program files must be replaced through cordis_reprogram, never written directly. Prefer its sourcePath input for files already staged; describe the tool to find the staging directory. Alto reads their complete contents without requiring another generated copy. Full-access turns apply changes immediately; other turns stage them for user approval.' })
      this.requests.add(server)
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
      res.once('close', () => { this.requests.delete(server); void server.close() })
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools.toAppServerSpecs().map((spec) => ({
        name: spec.name, description: spec.description, inputSchema: spec.inputSchema,
      })) as Tool[] }))
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        // Identity and access come from the running Alto turn, never MCP arguments.
        const context = this.active && this.tokens.get(res.locals.token as string) === chatId && this.context(chatId)
        if (!context) throw new Error('This Alto chat has no active turn')
        if (request.params.name !== 'cordis') throw new Error('Unknown tool')
        const result = await this.tools.execute({ ...context, callId: randomUUID(), tool: 'cordis', arguments: request.params.arguments ?? {} })
        const content: ContentBlock[] = result.contentItems.map((item) => {
          if (item.type === 'inputText') return { type: 'text', text: item.text ?? '' }
          const data = /^data:([^;,]+);base64,(.+)$/s.exec(item.imageUrl ?? item.audioUrl ?? '')
          if (data?.[1] && data[2]) return { type: item.type === 'inputImage' ? 'image' : 'audio', mimeType: data[1], data: data[2] }
          return { type: 'text', text: item.imageUrl ?? item.audioUrl ?? '' }
        })
        return { content, isError: !result.success }
      })
      try {
        await server.connect(transport as Transport)
        await transport.handleRequest(req, res, req.body)
      } catch {
        if (!res.headersSent) res.sendStatus(500)
      }
    })
    app.all('/mcp', (_req, res) => { res.sendStatus(405) })
    const server = createServer(app)
    this.server = server
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    if (!this.active) { server.close(); throw new Error('Cordis bridge is closed') }
    return `http://${this.address()}/mcp`
  }

  private address(): string {
    const address = this.server?.address()
    return address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : ''
  }

  async dispose(): Promise<void> {
    this.active = false
    this.tokens.clear()
    await Promise.allSettled([...this.requests].map((server) => server.close()))
    this.requests.clear()
    this.server?.closeAllConnections()
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }
}
