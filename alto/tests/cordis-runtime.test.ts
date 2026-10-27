import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, type Plugin } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import defaultSidebar from '../program/plugins/sidebar.js'
import shellUi from '../program/plugins/shell-ui.js'
import uiSurfaces from '../program/plugins/ui-surfaces.js'
import type { TurnDraft } from '../src/server/plugin-api.js'
import { ProgramRuntime } from '../src/server/services/program-runtime.js'
import { projectRegistryPlugin } from '../src/server/services/project-registry.js'
import {
  DISPATCHER_NAME,
  toolRegistryPlugin,
} from '../src/server/services/tool-registry.js'
import { turnProgramPlugin } from '../src/server/services/turn-program.js'
import { uiRegistryPlugin } from '../src/server/services/ui-registry.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('Cordis-owned harness behavior', () => {
  it('mounts plugins from an explicitly configured external directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-external-plugin-'))
    temporaryDirectories.push(root)
    const projectRoot = path.join(root, 'alto')
    const programRoot = path.join(projectRoot, 'program')
    const externalRoot = path.join(root, 'company-plugins')
    await Promise.all([
      mkdir(programRoot, { recursive: true }),
      mkdir(path.join(externalRoot, 'plugins'), { recursive: true }),
    ])
    await writeFile(path.join(programRoot, 'cordis.json'), `${JSON.stringify({
      version: 2,
      plugins: [{
        id: 'host',
        name: 'Host',
        description: 'Hosts externally supplied plugins.',
      }],
    }, null, 2)}\n`)
    await writeFile(path.join(externalRoot, 'alto-plugins.json'), `${JSON.stringify({
      version: 1,
      mounts: [{
        parent: 'host',
        plugins: [{
          id: 'company-tool',
          name: 'Company Tool',
          description: 'Registers a tool from outside the Alto checkout.',
          module: 'plugins/company-tool.ts',
        }],
      }],
    }, null, 2)}\n`)
    const source = (marker: string) => `
const plugin = (ctx) => {
  ctx.tools.register(ctx, {
    name: 'company_tool',
    description: 'Returns the external plugin marker.',
    inputSchema: { type: 'object', properties: {} },
  }, () => ${JSON.stringify(marker)})
}
plugin.inject = ['tools']
export default plugin
`
    const sourcePath = path.join(externalRoot, 'plugins', 'company-tool.ts')
    await writeFile(sourcePath, source('external-v1'))

    const ctx = new Context()
    const toolsFiber = await ctx.plugin(toolRegistryPlugin)
    const runtime = new ProgramRuntime(ctx, {
      projectRoot,
      pluginDirectories: [externalRoot],
      watch: false,
    })
    const stopRuntime = await runtime.start()
    expect(runtime.snapshot().plugins).toMatchObject([
      { id: 'host' },
      {
        id: 'company-tool',
        parentId: 'host',
        module: '@external/company-plugins/plugins/company-tool.ts',
        state: 'active',
      },
    ])
    expect(runtime.snapshot().files.map((file) => file.path)).toEqual([
      '@external/company-plugins/plugins/company-tool.ts',
    ])
    await expect(ctx.tools.execute({
      callId: 'external-v1',
      threadId: 'thread',
      turnId: 'turn',
      tool: 'company_tool',
      arguments: {},
    })).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: 'external-v1' }],
    })

    await expect(runtime.applyChange('Try to edit the external source.', [{
      path: '@external/company-plugins/plugins/company-tool.ts',
      content: source('modified'),
    }])).rejects.toThrow('program changes may only edit')

    await writeFile(sourcePath, source('external-v2'))
    await runtime.reconcile(false, false, new Set([sourcePath]))
    await expect(ctx.tools.execute({
      callId: 'external-v2',
      threadId: 'thread',
      turnId: 'turn',
      tool: 'company_tool',
      arguments: {},
    })).resolves.toMatchObject({
      contentItems: [{ text: 'external-v2' }],
    })

    await stopRuntime()
    await toolsFiber.dispose()
  })

  it('rejects external plugin modules that escape their configured directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-external-plugin-escape-'))
    temporaryDirectories.push(root)
    const projectRoot = path.join(root, 'alto')
    const programRoot = path.join(projectRoot, 'program')
    const externalRoot = path.join(root, 'company-plugins')
    await Promise.all([
      mkdir(programRoot, { recursive: true }),
      mkdir(externalRoot, { recursive: true }),
    ])
    await writeFile(path.join(programRoot, 'cordis.json'), '{"version":2,"plugins":[]}\n')
    await writeFile(path.join(externalRoot, 'alto-plugins.json'), JSON.stringify({
      version: 1,
      mounts: [{
        plugins: [{
          id: 'escape',
          name: 'Escape',
          description: 'Attempts to escape its configured directory.',
          module: '../escape.ts',
        }],
      }],
    }))

    const runtime = new ProgramRuntime(new Context(), {
      projectRoot,
      pluginDirectories: [externalRoot],
      watch: false,
    })
    await expect(runtime.start()).rejects.toThrow('external plugin path escapes')
  })

  it('recompiles only plugins whose dependency graph contains the changed file', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'alto-selective-build-'))
    temporaryDirectories.push(projectRoot)
    const programRoot = path.join(projectRoot, 'program')
    const pluginRoot = path.join(programRoot, 'plugins')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(path.join(programRoot, 'cordis.json'), `${JSON.stringify({
      version: 2,
      plugins: ['first', 'second'].map((id) => ({
        id,
        name: id,
        description: `${id} plugin`,
        module: `plugins/${id}.ts`,
        client: `plugins/${id}.client.ts`,
        enabled: true,
        config: {},
      })),
    }, null, 2)}\n`)
    const pluginSource = (marker: string) => `
const plugin = () => undefined
plugin.marker = ${JSON.stringify(marker)}
export default plugin
`
    const firstPath = path.join(pluginRoot, 'first.ts')
    const firstClientPath = path.join(pluginRoot, 'first.client.ts')
    await writeFile(firstPath, pluginSource('first-v1'))
    await writeFile(firstClientPath, pluginSource('first-client-v1'))
    await writeFile(path.join(pluginRoot, 'second.ts'), pluginSource('second-v1'))
    await writeFile(path.join(pluginRoot, 'second.client.ts'), pluginSource('second-client-v1'))

    const runtime = new ProgramRuntime(new Context(), { projectRoot, watch: false })
    const stopRuntime = await runtime.start()
    const before = new Map(runtime.snapshot().plugins.map((plugin) => [plugin.id, {
      server: plugin.loadedAt,
      client: plugin.client?.loadedAt,
    }]))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(firstPath, pluginSource('first-v2'))
    await runtime.reconcile(false, false, new Set([firstPath]))
    const afterServerChange = new Map(runtime.snapshot().plugins.map((plugin) => [plugin.id, {
      server: plugin.loadedAt,
      client: plugin.client?.loadedAt,
    }]))

    expect(afterServerChange.get('first')?.server).not.toBe(before.get('first')?.server)
    expect(afterServerChange.get('first')?.client).toBe(before.get('first')?.client)
    expect(afterServerChange.get('second')).toEqual(before.get('second'))

    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(firstClientPath, pluginSource('first-client-v2'))
    await runtime.reconcile(false, false, new Set([firstClientPath]))
    const afterClientChange = new Map(runtime.snapshot().plugins.map((plugin) => [plugin.id, {
      server: plugin.loadedAt,
      client: plugin.client?.loadedAt,
    }]))
    expect(afterClientChange.get('first')?.server).toBe(afterServerChange.get('first')?.server)
    expect(afterClientChange.get('first')?.client).not.toBe(afterServerChange.get('first')?.client)
    expect(afterClientChange.get('second')).toEqual(before.get('second'))
    await stopRuntime()
  })

  it('compiles content-addressed browser plugins and tracks their program sources', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'codex-cordis-client-'))
    temporaryDirectories.push(projectRoot)
    const programRoot = path.join(projectRoot, 'program')
    const pluginRoot = path.join(programRoot, 'plugins')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(path.join(programRoot, 'cordis.json'), `${JSON.stringify({
      version: 2,
      plugins: [{
        id: 'browser-only',
        name: 'Browser Only',
        description: 'Exercises a browser-only plugin.',
        client: 'plugins/browser-only.client.tsx',
        enabled: true,
        config: {},
      }],
    }, null, 2)}\n`)
    await writeFile(path.join(pluginRoot, 'browser-only.css'), '.browser-only { color: purple; }\n')
    await writeFile(path.join(pluginRoot, 'browser-only.client.tsx'), `
import { useState } from 'react'
import styles from './browser-only.css'
const plugin = (ctx) => {
  void useState
  ctx.clientUi.registerStyle(ctx, 'browser-only', String(styles))
}
plugin.inject = ['clientUi']
export default plugin
`)

    const cacheRoot = path.join(projectRoot, '.codex-cordis', 'cache')
    await mkdir(cacheRoot, { recursive: true })
    await Promise.all(Array.from({ length: 65 }, (_, index) => (
      writeFile(path.join(cacheRoot, `zz-stale-${String(index).padStart(2, '0')}.mjs`), 'export {}\n')
    )))

    const runtime = new ProgramRuntime(new Context(), { projectRoot, watch: false })
    const stopRuntime = await runtime.start()
    const first = runtime.snapshot().plugins[0]?.client
    expect(first).toMatchObject({
      module: 'plugins/browser-only.client.tsx',
      url: expect.stringMatching(/^\/__cordis\/client\/browser-only\/[a-f0-9]{64}\.mjs$/),
    })
    expect(runtime.snapshot().files.map((file) => file.path)).toEqual([
      'plugins/browser-only.client.tsx',
      'plugins/browser-only.css',
    ])
    const bundle = first ? await runtime.clientBundle('browser-only', first.hash) : undefined
    expect(bundle?.toString('utf8')).toContain('__ALTO_BROWSER_HOST__')
    expect(bundle?.toString('utf8')).toContain('color: purple')

    await runtime.setPluginEnabled('browser-only', false)
    expect(runtime.snapshot().plugins[0]?.client).toBeUndefined()
    await runtime.setPluginEnabled('browser-only', true)
    expect(runtime.snapshot().plugins[0]?.client).toEqual(first)

    await runtime.setPluginEnabled('browser-only', false)
    await writeFile(path.join(pluginRoot, 'browser-only.css'), '.browser-only { color: plum; }\n')
    await runtime.setPluginEnabled('browser-only', true)
    expect(runtime.snapshot().plugins[0]?.client?.hash).not.toBe(first?.hash)
    await stopRuntime()
  })

  it('removes tools and turn middleware with their owning fibers', async () => {
    const ctx = new Context()
    const toolsFiber = await ctx.plugin(toolRegistryPlugin)
    const turnFiber = await ctx.plugin(turnProgramPlugin)
    const uiFiber = await ctx.plugin(uiRegistryPlugin)

    const behavior: Plugin = (owner) => {
      owner.tools.register(owner, {
        name: 'test_status',
        description: 'Return a test status.',
        inputSchema: { type: 'object', properties: {} },
      }, () => ({ state: 'active' }))
      owner.on('codex/turn/prepare', async (draft: TurnDraft, next) => ({
        ...await next(),
        additionalContext: {
          ...draft.additionalContext,
          test: { kind: 'application', value: 'installed' },
        },
      }))
      const registration = owner.ui.register(owner, {
        id: 'test-panel',
        slot: 'sidebar',
        title: 'Test panel',
        nodes: [{ type: 'text', text: 'installed' }],
      }, (action) => {
        registration.update({
          id: 'test-panel',
          title: 'Test panel',
          nodes: [{ type: 'text', text: action.values.message ?? 'updated' }],
        })
        return { action: action.actionId }
      })
      owner.ui.registerShell(owner, {
        id: 'test-shell',
        theme: { accent: '#6633ff', font: 'system' },
        root: {
          type: 'box',
          direction: 'row',
          children: [
            { type: 'surface', id: 'test-conversation' },
            { type: 'slot', name: 'sidebar' },
          ],
        },
      })
      owner.ui.registerSurface(owner, {
        id: 'test-conversation',
        kind: 'conversation',
        emptyState: 'none',
        markdown: false,
      })
    }
    behavior.inject = ['tools', 'turnProgram', 'ui']

    const behaviorFiber = await ctx.plugin(behavior)
    expect(ctx.tools.list().map((tool) => tool.name)).toEqual(['test_status'])
    await expect(ctx.tools.execute({
      callId: 'call-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      tool: 'test_status',
      arguments: {},
    })).resolves.toMatchObject({ success: true })
    await expect(ctx.turnProgram.prepare({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello' }],
    })).resolves.toMatchObject({
      additionalContext: { test: { value: 'installed' } },
    })
    expect(ctx.ui.snapshot().contributions).toMatchObject([{
      id: 'test-panel',
      slot: 'sidebar',
      nodes: [{ type: 'text', text: 'installed' }],
    }])
    expect(ctx.ui.snapshot().shell).toMatchObject({
      id: 'test-shell',
      theme: { accent: '#6633ff' },
    })
    expect(ctx.ui.snapshot().surfaces).toEqual([{
      id: 'test-conversation',
      kind: 'conversation',
      emptyState: 'none',
      markdown: false,
    }])
    await expect(ctx.ui.execute({
      contributionId: 'test-panel',
      actionId: 'refresh',
      values: { message: 'changed' },
    })).resolves.toEqual({ action: 'refresh' })
    expect(ctx.ui.snapshot().contributions[0]?.nodes).toEqual([{
      type: 'text',
      text: 'changed',
    }])

    await behaviorFiber.dispose()
    expect(ctx.tools.list()).toEqual([])
    expect(ctx.ui.snapshot().contributions).toEqual([])
    expect(ctx.ui.snapshot().regions).toEqual([])
    expect(ctx.ui.snapshot().surfaces).toEqual([])
    expect(ctx.ui.snapshot().shell).toBeUndefined()
    await expect(ctx.turnProgram.prepare({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello' }],
    })).resolves.not.toHaveProperty('additionalContext')

    await turnFiber.dispose()
    await toolsFiber.dispose()
    await uiFiber.dispose()
  })

  it('removes and replaces the default sidebar without replacing the shell', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'codex-cordis-sidebar-'))
    temporaryDirectories.push(projectRoot)
    const ctx = new Context()
    const projectsFiber = await ctx.plugin(projectRegistryPlugin, { projectRoot })
    const uiFiber = await ctx.plugin(uiRegistryPlugin)
    const surfacesFiber = await ctx.plugin(uiSurfaces)
    const shellFiber = await ctx.plugin(shellUi)
    const sidebarFiber = await ctx.plugin(defaultSidebar, { importCodexWorkspaces: false })

    const shellBefore = ctx.ui.snapshot().shell
    expect(shellBefore?.root).toMatchObject({
      children: [
        { type: 'outlet', name: 'sidebar' },
        { type: 'outlet', name: 'workspace-primary', fallback: { role: 'main' } },
      ],
    })
    const rootChildren = shellBefore?.root.type === 'box' ? shellBefore.root.children : []
    const workspace = rootChildren.find((node) => node.type === 'outlet' && node.name === 'workspace-primary')
    const main = workspace?.type === 'outlet' ? workspace.fallback : undefined
    const header = main?.type === 'box'
      ? main.children.find((node) => node.type === 'box' && node.id === 'conversation-header')
      : undefined
    const headerChildren = header?.type === 'box' ? header.children : []
    const leading = headerChildren.find((node) => node.type === 'box' && node.id === 'header-leading')
    const tools = headerChildren.find((node) => node.type === 'box' && node.id === 'header-tools')
    expect(leading?.type === 'box' ? leading.children : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'slot', name: 'header-left' }),
    ]))
    expect(tools?.type === 'box' ? tools.children : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'slot', name: 'header-right' }),
    ]))
    expect(ctx.ui.snapshot().regions).toMatchObject([{
      id: 'default-sidebar',
      outlet: 'sidebar',
      root: { role: 'aside' },
    }])
    expect(ctx.ui.snapshot().surfaces.map((surface) => surface.id)).toContain('default-history')

    await sidebarFiber.dispose()
    expect(ctx.ui.snapshot().shell).toEqual(shellBefore)
    expect(ctx.ui.snapshot().regions).toEqual([])
    expect(ctx.ui.snapshot().surfaces.map((surface) => surface.id)).not.toContain('default-history')

    const replacement: Plugin = (owner) => {
      owner.ui.registerShellRegion(owner, {
        id: 'replacement-sidebar',
        outlet: 'sidebar',
        root: {
          type: 'box',
          role: 'aside',
          width: 'narrow',
          children: [{ type: 'label', text: 'Replacement' }],
        },
      })
    }
    replacement.inject = ['ui']
    const replacementFiber = await ctx.plugin(replacement)
    expect(ctx.ui.snapshot().shell).toEqual(shellBefore)
    expect(ctx.ui.snapshot().regions).toMatchObject([{
      id: 'replacement-sidebar',
      outlet: 'sidebar',
      root: { width: 'narrow' },
    }])

    await replacementFiber.dispose()
    await shellFiber.dispose()
    await surfacesFiber.dispose()
    await uiFiber.dispose()
    await projectsFiber.dispose()
  })

  it('keeps one dispatcher live while its discoverable capabilities change', async () => {
    const ctx = new Context()
    const toolsFiber = await ctx.plugin(toolRegistryPlugin)
    const firstOwner: Plugin = (owner) => {
      owner.tools.register(owner, {
        name: 'first_tool',
        description: 'The first capability.',
        inputSchema: { type: 'object', properties: {} },
      }, () => ({ value: 'first' }))
    }
    firstOwner.inject = ['tools']
    const firstFiber = await ctx.plugin(firstOwner)
    const taskToolSpecs = ctx.tools.toAppServerSpecs()

    expect(taskToolSpecs).toHaveLength(1)
    expect(taskToolSpecs[0]).toMatchObject({ name: DISPATCHER_NAME })

    const list = () => ctx.tools.execute({
      callId: 'call-list',
      threadId: 'existing-thread',
      turnId: 'existing-turn',
      tool: DISPATCHER_NAME,
      arguments: { operation: 'list' },
    })
    await expect(list()).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining('first_tool') }],
    })

    const secondOwner: Plugin = (owner) => {
      owner.tools.register(owner, {
        name: 'second_tool',
        description: 'A capability installed after the task started.',
        inputSchema: { type: 'object', properties: {} },
      }, () => ({ value: 'second' }))
    }
    secondOwner.inject = ['tools']
    const secondFiber = await ctx.plugin(secondOwner)

    expect(ctx.tools.toAppServerSpecs()).toEqual(taskToolSpecs)
    await expect(list()).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining('second_tool') }],
    })
    await expect(ctx.tools.execute({
      callId: 'call-invoke',
      threadId: 'existing-thread',
      turnId: 'existing-turn',
      tool: DISPATCHER_NAME,
      arguments: {
        operation: 'invoke',
        tool: 'second_tool',
        arguments: {},
      },
    })).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining('second') }],
    })

    await secondFiber.dispose()
    const removed = await list()
    expect(removed.contentItems[0]?.text).not.toContain('second_tool')
    await expect(ctx.tools.execute({
      callId: 'call-stale',
      threadId: 'imported-thread',
      turnId: 'imported-turn',
      namespace: 'codex_app',
      tool: 'create_thread',
      arguments: {},
    })).resolves.toMatchObject({
      success: false,
      contentItems: [{
        text: expect.stringContaining('Do not emulate Alto workspace actions'),
      }],
    })
    await firstFiber.dispose()
    await toolsFiber.dispose()
  })

  it('restores the previous program when replacement compilation fails', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'codex-cordis-'))
    temporaryDirectories.push(projectRoot)
    const programRoot = path.join(projectRoot, 'program')
    const pluginRoot = path.join(programRoot, 'plugins')
    await mkdir(pluginRoot, { recursive: true })

    const profileText = `${JSON.stringify({
      version: 1,
      plugins: [{
        id: 'live-tool',
        name: 'Live Tool',
        description: 'Registers a tool that survives a failed replacement.',
        module: 'plugins/live-tool.ts',
        enabled: true,
        config: {},
      }],
    }, null, 2)}\n`
    const pluginText = `
const plugin = (ctx) => {
  ctx.tools.register(ctx, {
    name: 'live_tool',
    description: 'A live test tool.',
    inputSchema: { type: 'object', properties: {} },
  }, () => 'still active')
}
plugin.inject = ['tools']
export default plugin
`
    await writeFile(path.join(programRoot, 'cordis.json'), profileText)
    await writeFile(path.join(pluginRoot, 'live-tool.ts'), pluginText)

    const ctx = new Context()
    const toolsFiber = await ctx.plugin(toolRegistryPlugin)
    const runtime = new ProgramRuntime(ctx, { projectRoot, watch: false })
    const stopRuntime = await runtime.start()
    expect(ctx.tools.list().map((tool) => tool.name)).toEqual(['live_tool'])

    await expect(runtime.applyChange('Install a broken replacement.', [{
      path: 'plugins/live-tool.ts',
      content: 'export default ???',
    }])).rejects.toThrow()

    expect(ctx.tools.list().map((tool) => tool.name)).toEqual(['live_tool'])
    expect(runtime.snapshot().plugins).toMatchObject([{ state: 'active' }])
    await expect(readFile(path.join(pluginRoot, 'live-tool.ts'), 'utf8')).resolves.toBe(pluginText)

    await stopRuntime()
    await toolsFiber.dispose()
  })
})
