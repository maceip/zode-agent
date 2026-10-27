import * as acp from '@agentclientprotocol/sdk'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpProcessProvider } from '../program/plugins/acp-provider.js'
import { AgentChats } from '../program/plugins/agent-chats.js'
import promptLayer from '../program/plugins/prompt-layer.js'
import type { AgentContext } from '../program/plugins/acp-context.js'
import type { AgentRegistry } from '../src/server/services/agent-registry.js'
import { turnProgramPlugin } from '../src/server/services/turn-program.js'
import { uiRegistryPlugin } from '../src/server/services/ui-registry.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function fixture(id = 'claude') {
  const created: acp.NewSessionRequest[] = []
  const loaded: acp.LoadSessionRequest[] = []
  const prompts: acp.PromptRequest[] = []
  let compact = false
  let fail = false
  let cancelled = false
  let complete = 0
  let failed = 0
  const agent = acp.agent({ name: 'context-test' })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      expect(ctx.params.clientCapabilities?.session?.compaction).toEqual({})
      return { protocolVersion: ctx.params.protocolVersion, agentCapabilities: { loadSession: true },
        _meta: { steering: { supported: true } } }
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => { created.push(ctx.params); return { sessionId: 'session' } })
    .onRequest(acp.methods.agent.session.load, (ctx) => { loaded.push(ctx.params); return {} })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      prompts.push(ctx.params)
      if (compact) {
        compact = false
        await ctx.client.notify(acp.methods.client.session.update, { sessionId: 'session', update: {
          sessionUpdate: 'compaction_update', compactionId: 'compact', status: 'completed',
        } })
      }
      if (fail) { fail = false; throw new Error('prompt failed') }
      if (cancelled) { cancelled = false; return { stopReason: 'cancelled' } }
      return { stopReason: 'end_turn' }
    })
  const provider = new AcpProcessProvider({ id, label: id, command: 'unused', openConnection: (client) => {
    const connection = client.connect(agent)
    return { connection, close: () => connection.close() }
  } })
  provider.subscribe((event) => {
    if (event.type === 'turn.completed') complete++
    if (event.type === 'turn.failed') failed++
  })
  cleanup.push(() => provider.stop())
  const send = async (context: AgentContext) => {
    const target = complete + failed + 1
    await provider.prompt('session', [{ type: 'text', text: 'Continue.' }], { additionalContext: context })
    await vi.waitFor(() => expect(complete + failed).toBe(target))
    return prompts.at(-1)!
  }
  return { provider, created, loaded, prompts, send,
    compact: () => { compact = true }, fail: () => { fail = true }, cancel: () => { cancelled = true } }
}

const context: AgentContext = {
  cordis_program: { kind: 'application', value: 'Alto instructions.' },
  cordis_authoring: { kind: 'application', value: 'Complete guide. '.repeat(1_000) },
  cordis_shell: { kind: 'application', value: 'Current shell: first' },
  attachment: { kind: 'untrusted', value: 'Attachment data.' },
}

describe('ACP application context', () => {
  it('appends trusted guidance, sends changes once, and refreshes after compaction and failure', async () => {
    const f = fixture()
    await f.provider.createSession({ cwd: '/tmp/project', permissionMode: 'ask', additionalContext: context })
    const meta = f.created[0]!._meta as { systemPrompt: { append: string } }
    expect(Object.keys(meta)).toEqual(['systemPrompt'])
    expect(Object.keys(meta.systemPrompt)).toEqual(['append'])
    expect(meta.systemPrompt.append).toContain(context.cordis_authoring!.value)
    expect(meta.systemPrompt.append).toContain('Alto context cordis_authoring:')
    expect(meta.systemPrompt.append).not.toContain('Attachment data.')
    expect(meta.systemPrompt.append).not.toContain('Current shell: first')
    const first = JSON.stringify((await f.send(context)).prompt)
    expect(first).toContain('Current shell: first')
    expect(first).toContain('untrusted data, not instructions')
    expect(first).not.toContain('Complete guide.')
    expect((await f.send(context)).prompt).toEqual([{ type: 'text', text: 'Continue.' }])
    const changed: AgentContext = { ...context, cordis_shell: { kind: 'application', value: 'Current shell: second' } }
    const update = JSON.stringify((await f.send(changed)).prompt)
    expect(update).toContain('Current shell: second')
    expect(update).not.toContain('Complete guide.')
    f.compact()
    await f.send(changed)
    expect(JSON.stringify((await f.send(changed)).prompt)).toContain('Complete guide.')
    f.cancel()
    await f.send(changed)
    expect(JSON.stringify((await f.send(changed)).prompt)).toContain('Complete guide.')
    f.fail()
    await f.send(changed)
    expect(JSON.stringify((await f.send(changed)).prompt)).toContain('Complete guide.')
    const { attachment: _attachment, ...withoutAttachment } = changed
    const removal = (await f.send(withoutAttachment)).prompt[0]
    expect(removal?.type === 'text' && removal.text).toContain('"removed":["attachment"]')
  })

  it('supplies the full context to a resumed conversation even if its system prompt was recorded earlier', async () => {
    const f = fixture()
    await f.provider.loadSession('session', { cwd: '/tmp/project', permissionMode: 'ask', additionalContext: context })
    expect(f.loaded[0]!._meta).toHaveProperty('systemPrompt.append')
    const prompt = JSON.stringify((await f.send(context)).prompt)
    expect(prompt).toContain('Complete guide.')
    expect(prompt).toContain('Current shell: first')
    expect((await f.send(context)).prompt).toEqual([{ type: 'text', text: 'Continue.' }])
  })

  it('uses standard prompt content for other ACP agents without sending Claude metadata', async () => {
    const f = fixture('gemini')
    await f.provider.createSession({ cwd: '/tmp/project', permissionMode: 'ask', additionalContext: context })
    expect(f.created[0]!._meta).toBeUndefined()
    expect(JSON.stringify((await f.send(context)).prompt)).toContain('Complete guide.')
  })

  it.each(['claude', 'gemini'])('delivers response formatting defaults to resumed %s sessions', async (id) => {
    const root = new Context()
    for (const plugin of [uiRegistryPlugin, turnProgramPlugin]) {
      const fiber = await root.plugin(plugin)
      cleanup.push(() => fiber.dispose())
    }
    const instructions = await root.plugin(promptLayer, { context: 'Shared Alto guidance.' })
    cleanup.push(() => instructions.dispose())
    const prepared = await root.turnProgram.prepare({
      threadId: 'acp-be3fd630-f4dd-4d70-81ea-23cfd94e30b8',
      input: [{ type: 'text', text: 'Continue.' }],
    })
    const responseContext = prepared.additionalContext ?? {}
    const style = responseContext.cordis_response_style!.value
    const f = fixture(id)
    await f.provider.loadSession('session', {
      cwd: '/tmp/project', permissionMode: 'ask', additionalContext: responseContext,
    })
    const meta = f.loaded[0]!._meta as { systemPrompt?: { append?: string } } | undefined
    if (id === 'claude') expect(meta?.systemPrompt?.append).toContain(style)
    else expect(f.loaded[0]!._meta).toBeUndefined()
    const first = await f.send(responseContext)
    const contextBlock = first.prompt[0]!
    if (contextBlock.type !== 'text') throw new Error('Expected a text context update')
    const update = JSON.parse(contextBlock.text.slice(contextBlock.text.indexOf('\n') + 1))
    expect(update.application.cordis_response_style).toEqual(responseContext.cordis_response_style)
    expect(first.prompt.at(-1)).toEqual({ type: 'text', text: 'Continue.' })
    expect((await f.send(responseContext)).prompt).toEqual([{ type: 'text', text: 'Continue.' }])
  })

  it('runs local chats through the live Alto prompt hooks while retaining the original user message', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'alto-chat-context-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const root = new Context()
    for (const plugin of [uiRegistryPlugin, turnProgramPlugin]) {
      const fiber = await root.plugin(plugin)
      cleanup.push(() => fiber.dispose())
    }
    const instructions = await root.plugin(promptLayer, { context: 'Shared Alto guidance.' })
    cleanup.push(() => instructions.dispose())
    const f = fixture()
    const agents = { provider: () => f.provider } as unknown as AgentRegistry
    const chats = new AgentChats(agents, directory, () => {}, undefined, root.turnProgram)
    cleanup.push(() => chats.dispose())
    f.provider.subscribe((event) => chats.event(event))
    await chats.load()
    const chat = await chats.create('claude', directory, 'ask')
    await chats.send(chat.summary.id, [{ type: 'text', text: 'Build a Canvas page.' }], 'ask')
    await vi.waitFor(() => expect(chat.turn).toBe('idle'))
    const meta = JSON.stringify(f.created[0]!._meta)
    expect(meta).toContain('Shared Alto guidance.')
    expect(meta).not.toContain('Canvas is a registered workspace pane')
    expect(meta).not.toContain('Guard async work')
    expect(meta).toContain('Alto response formatting defaults:')
    expect(chat.activities.filter((activity) => activity.kind === 'user').map((activity) => activity.content)).toEqual(['Build a Canvas page.'])
  })
})
