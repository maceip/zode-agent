import { Context } from 'cordis'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import controlPlane from '../program/plugins/control-plane.js'
import type { ProgramRuntime } from '../src/server/services/program-runtime.js'
import { toolRegistryPlugin } from '../src/server/services/tool-registry.js'

describe('Alto authoring skill', () => {
  it('is discoverable and loads the full shipped instructions on demand, with fiber-owned teardown', async () => {
    const ctx = new Context()
    const tools = await ctx.plugin(toolRegistryPlugin)
    const projectRoot = fileURLToPath(new URL('../', import.meta.url))
    ctx.provide('program', { projectRoot } as ProgramRuntime)
    ctx.provide('codex', {} as Context['codex'])
    const control = await ctx.plugin(controlPlane)
    onTestFinished(async () => {
      await control.dispose()
      await tools.dispose()
    })
    const call = (operation: string, tool?: string) => ctx.tools.execute({
      callId: 'skill-call', threadId: 'acp-test', turnId: 'turn',
      tool: 'cordis', arguments: { operation, ...(tool ? { tool } : {}) },
    })
    const catalog = await call('list')
    expect(catalog.success).toBe(true)
    expect(catalog.contentItems[0]?.text).toContain('cordis_authoring_skill')
    expect(catalog.contentItems[0]?.text).not.toContain('ctx.clientUi.registerSurface')

    const loaded = await call('invoke', 'cordis_authoring_skill')
    expect(loaded.success).toBe(true)
    const skill = await readFile(new URL('../program/skills/alto-authoring/SKILL.md', import.meta.url), 'utf8')
    expect(loaded.contentItems[0]?.text).toBe(skill)
    expect(skill).toContain('name: alto-authoring')
    expect(skill).toContain('ctx.clientUi.registerSurface')
    expect(skill).toContain('Guard async work')

    await control.dispose()
    expect((await call('invoke', 'cordis_authoring_skill')).success).toBe(false)
  })

  it('ships a compact discovery pointer instead of the detailed authoring contract', async () => {
    const profile = JSON.parse(await readFile(new URL('../program/cordis.json', import.meta.url), 'utf8'))
    const prompt = profile.plugins[0].children.find((entry: { id: string }) => entry.id === 'prompt-layer')
    expect(prompt.config.context).toContain('cordis_authoring_skill')
    expect(Buffer.byteLength(prompt.config.context, 'utf8')).toBeLessThan(1_000)
    expect(prompt.config.context).not.toContain('ctx.clientUi')
  })
})
