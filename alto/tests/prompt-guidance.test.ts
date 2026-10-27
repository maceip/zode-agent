import { Context } from 'cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import promptLayer from '../program/plugins/prompt-layer.js'
import { turnProgramPlugin } from '../src/server/services/turn-program.js'
import { uiRegistryPlugin } from '../src/server/services/ui-registry.js'

describe('Cordis prompt guidance', () => {
  it.each(['thread-1', 'acp-test'])('keeps authoring details and shell state out of ordinary turns (%s)', async (threadId) => {
    const ctx = new Context()
    const turnFiber = await ctx.plugin(turnProgramPlugin)
    const promptFiber = await ctx.plugin(promptLayer, { context: 'Load alto-authoring through cordis_authoring_skill before changing Alto.' })
    onTestFinished(async () => {
      await promptFiber.dispose()
      await turnFiber.dispose()
    })

    const prepared = await ctx.turnProgram.prepare({
      threadId, input: [{ type: 'text', text: 'Hey' }],
    })
    expect(prepared.additionalContext?.cordis_program?.value).toContain('cordis_authoring_skill')
    expect(Object.keys(prepared.additionalContext ?? {}).some((key) => key.startsWith('cordis_authoring') || key.startsWith('cordis_shell'))).toBe(false)
    for (const entry of Object.values(prepared.additionalContext ?? {})) {
      expect(Buffer.byteLength(entry.value, 'utf8')).toBeLessThanOrEqual(4_000)
    }
  })

  it('adds response formatting defaults to ACP chats while preserving user input and existing context', async () => {
    const ctx = new Context()
    const uiFiber = await ctx.plugin(uiRegistryPlugin)
    const turnFiber = await ctx.plugin(turnProgramPlugin)
    const promptFiber = await ctx.plugin(promptLayer, { context: 'Base Cordis context.' })
    onTestFinished(async () => {
      await promptFiber.dispose()
      await turnFiber.dispose()
      await uiFiber.dispose()
    })

    const input = [{ type: 'text' as const, text: 'Use my requested format: one paragraph with no headings.' }]
    const prepared = await ctx.turnProgram.prepare({
      threadId: 'acp-be3fd630-f4dd-4d70-81ea-23cfd94e30b8', input,
      additionalContext: { attachment: { kind: 'untrusted', value: 'Existing attachment.' } },
    })
    const style = prepared.additionalContext?.cordis_response_style
    expect(style?.kind).toBe('application')
    expect(style?.value).toContain('Follow explicit user style instructions')
    expect(style?.value).toContain('Prefer ## for main sections and ### for subsections')
    expect(style?.value).toContain('opening and closing $$ delimiters on separate lines')
    expect(Buffer.byteLength(style?.value ?? '', 'utf8')).toBeLessThanOrEqual(4_000)
    expect(prepared.input).toEqual(input)
    expect(prepared.additionalContext?.attachment).toEqual({ kind: 'untrusted', value: 'Existing attachment.' })
    expect(prepared.additionalContext?.cordis_program?.value).toBe('Base Cordis context.')
    expect(prepared.additionalContext?.cordis_shell).toBeUndefined()
    expect(prepared.additionalContext?.cordis_authoring).toBeUndefined()
  })

  it('does not add ACP response defaults to a Codex UUID thread', async () => {
    const ctx = new Context()
    const uiFiber = await ctx.plugin(uiRegistryPlugin)
    const turnFiber = await ctx.plugin(turnProgramPlugin)
    const promptFiber = await ctx.plugin(promptLayer, { context: 'Base Cordis context.' })
    onTestFinished(async () => {
      await promptFiber.dispose()
      await turnFiber.dispose()
      await uiFiber.dispose()
    })

    const prepared = await ctx.turnProgram.prepare({
      threadId: 'be3fd630-f4dd-4d70-81ea-23cfd94e30b8',
      input: [{ type: 'text', text: 'Explain the design.' }],
    })
    expect(prepared.additionalContext?.cordis_response_style).toBeUndefined()
    expect(prepared.additionalContext?.cordis_program?.value).toBe('Base Cordis context.')
  })

  it.each([
    'x'.repeat(4_000),
    'x'.repeat(4_001),
    '😀'.repeat(1_001) + '\n' + '界'.repeat(1_500) + '\nfinal instruction',
  ])('preserves long configured context without splitting UTF-8 characters (%#)', async (context) => {
    const ctx = new Context()
    const uiFiber = await ctx.plugin(uiRegistryPlugin)
    const turnFiber = await ctx.plugin(turnProgramPlugin)
    const promptFiber = await ctx.plugin(promptLayer, { context })
    onTestFinished(async () => {
      await promptFiber.dispose()
      await turnFiber.dispose()
      await uiFiber.dispose()
    })

    const prepared = await ctx.turnProgram.prepare({
      threadId: 'thread-1', input: [{ type: 'text', text: 'Follow the instructions.' }],
      additionalContext: { attachment: { kind: 'untrusted', value: 'Existing attachment.' } },
    })
    const entries = Object.entries(prepared.additionalContext ?? {})
      .filter(([key]) => key.startsWith('cordis_program'))
      .sort(([a], [b]) => a.localeCompare(b))
    expect(entries.map(([, entry]) => entry.value).join('')).toBe(context)
    for (const [, entry] of entries) {
      expect(entry.kind).toBe('application')
      expect(Buffer.byteLength(entry.value, 'utf8')).toBeLessThanOrEqual(4_000)
      expect(Buffer.from(entry.value).toString('utf8')).toBe(entry.value)
    }
    expect(prepared.additionalContext?.attachment).toEqual({ kind: 'untrusted', value: 'Existing attachment.' })
  })

})
