import { Context } from 'cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { expect, it } from 'vitest'
import { DynamicToolRegistry } from '../src/server/services/tool-registry.js'
import { AgentToolBridge, type AgentToolContext } from '../program/plugins/agent-tool-bridge.js'

it('binds authenticated MCP calls to the running chat and resolves the current Cordis fiber', async () => {
  const root = new Context()
  const registry = new DynamicToolRegistry(root)
  let context: AgentToolContext | undefined = { threadId: 'chat-a', turnId: 'turn-a', permissionMode: 'ask' }
  const bridge = new AgentToolBridge(registry, (id) => id === 'chat-a' ? context : undefined)
  const seen: unknown[] = []
  const plugin = await root.plugin((ctx) => { registry.register(ctx, { name: 'probe', description: 'Inspect trusted context', inputSchema: { type: 'object' } }, (call) => { seen.push(call); return 'FIRST' }) })
  const [descriptor] = await bridge.attach('chat-a')
  if (!descriptor || descriptor.type === 'stdio') throw new Error('Expected HTTP bridge')
  const client = new Client({ name: 'bridge-test', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.url), { requestInit: { headers: descriptor.headers ?? {} } }) as Transport)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['cordis'])
    const result = await client.callTool({ name: 'cordis', arguments: { operation: 'invoke', tool: 'probe', arguments: { threadId: 'other-chat', permissionMode: 'full' } } })
    expect(result.content).toEqual([{ type: 'text', text: 'FIRST' }])
    expect(seen[0]).toMatchObject({ threadId: 'chat-a', turnId: 'turn-a', permissionMode: 'ask' })
    await plugin.dispose()
    expect((await client.callTool({ name: 'cordis', arguments: { operation: 'invoke', tool: 'probe' } })).isError).toBe(true)
    const replacement = await root.plugin((ctx) => { registry.register(ctx, { name: 'probe', description: 'Replacement', inputSchema: {} }, () => 'SECOND') })
    expect((await client.callTool({ name: 'cordis', arguments: { operation: 'invoke', tool: 'probe' } })).content).toEqual([{ type: 'text', text: 'SECOND' }])
    await replacement.dispose()
    context = undefined
    await expect(client.callTool({ name: 'cordis', arguments: { operation: 'list' } })).rejects.toThrow('no active turn')
    expect((await fetch(descriptor.url, { method: 'POST' })).status).toBe(401)
    expect((await fetch(descriptor.url, { method: 'POST', headers: { ...descriptor.headers, Origin: 'https://example.com' } })).status).toBe(403)
    bridge.revoke('chat-a')
    expect((await fetch(descriptor.url, { method: 'POST', headers: descriptor.headers ?? {} })).status).toBe(401)
  } finally { await client.close(); await bridge.dispose(); await plugin.dispose() }
  await expect(bridge.attach('chat-a')).rejects.toThrow('closed')
})
