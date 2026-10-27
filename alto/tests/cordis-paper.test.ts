import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, type Plugin } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DynamicToolResult } from '../src/server/plugin-api.js'
import type { ProgramProfile } from '../src/server/program-profile.js'
import { ProgramRuntime } from '../src/server/services/program-runtime.js'
import {
  DISPATCHER_NAME,
  toolRegistryPlugin,
  type DynamicToolRegistry,
} from '../src/server/services/tool-registry.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

function textOf(result: DynamicToolResult): string {
  return result.contentItems[0]?.text ?? ''
}

async function dispatch(
  tools: DynamicToolRegistry,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await tools.execute({
    callId: `call-${tool}`,
    threadId: 'paper-thread',
    turnId: 'paper-turn',
    tool: DISPATCHER_NAME,
    arguments: { operation: 'invoke', tool, arguments: args },
  })
  expect(result.success, textOf(result)).toBe(true)
  return JSON.parse(textOf(result)) as Record<string, unknown>
}

describe('Cordis paper invariants', () => {
  it('reverses nested effects in LIFO order and restores external state', async () => {
    const ctx = new Context()
    const trace: string[] = []
    const state = new Set<string>()
    const plugin: Plugin = (owner) => {
      owner.effect(function* () {
        state.add('outer')
        trace.push('+outer')
        yield () => {
          state.delete('outer')
          trace.push('-outer')
        }

        state.add('inner')
        trace.push('+inner')
        yield () => {
          state.delete('inner')
          trace.push('-inner')
        }
      }, 'reversible-pair')
    }

    const fiber = await ctx.plugin(plugin)
    expect([...state]).toEqual(['outer', 'inner'])
    await fiber.dispose()
    expect(trace).toEqual(['+outer', '+inner', '-inner', '-outer'])
    expect([...state]).toEqual([])
  })

  it('suspends and reactivates the same consumer fiber around a coeffect', async () => {
    const ctx = new Context()
    const trace: string[] = []
    let activations = 0

    const consumer: Plugin = (owner) => {
      const value = owner.reflect.get('paperProbe') as string
      activations += 1
      trace.push(`+consumer:${value}`)
      return () => trace.push(`-consumer:${value}`)
    }
    consumer.inject = ['paperProbe']

    const provider = (value: string): Plugin => {
      const plugin: Plugin = (owner) => {
        owner.effect(function* () {
          trace.push(`+resource:${value}`)
          yield () => trace.push(`-resource:${value}`)
          yield owner.provide('paperProbe', value)
        }, 'provider-lifetime')
      }
      plugin.provide = 'paperProbe'
      return plugin
    }

    const consumerFiber = ctx.plugin(consumer)
    await consumerFiber
    const consumerUid = consumerFiber.uid
    expect(activations).toBe(0)

    const firstProvider = await ctx.plugin(provider('alpha'))
    await consumerFiber.await()
    expect(activations).toBe(1)
    expect(consumerFiber.uid).toBe(consumerUid)

    await firstProvider.dispose()
    await consumerFiber.await()
    expect(trace).toEqual([
      '+resource:alpha',
      '+consumer:alpha',
      '-consumer:alpha',
      '-resource:alpha',
    ])

    const secondProvider = await ctx.plugin(provider('beta'))
    await consumerFiber.await()
    expect(activations).toBe(2)
    expect(consumerFiber.uid).toBe(consumerUid)
    expect(trace.at(-1)).toBe('+consumer:beta')

    await secondProvider.dispose()
    await consumerFiber.dispose()
  })

  it('isolates coeffects and applies interception to descendants', async () => {
    const ctx = new Context()
    const leftRealm = Symbol('left')
    const rightRealm = Symbol('right')
    const seen = new Map<string, string>()

    const provider: Plugin<string> = (owner, value) => {
      owner.provide('isolatedProbe', value)
    }
    provider.provide = 'isolatedProbe'
    const consumer = (side: string): Plugin => {
      const plugin: Plugin = (owner) => {
        seen.set(side, owner.reflect.get('isolatedProbe') as string)
        seen.set(`${side}:logger`, owner.logger().name)
      }
      plugin.inject = ['isolatedProbe']
      return plugin
    }

    const left = ctx
      .isolate('isolatedProbe', leftRealm)
      .intercept('logger', { name: 'left-scope' })
    const right = ctx
      .isolate('isolatedProbe', rightRealm)
      .intercept('logger', { name: 'right-scope' })
    const leftProvider = await left.plugin(provider, 'left-value')
    const rightProvider = await right.plugin(provider, 'right-value')
    const leftConsumer = await left.plugin(consumer('left'))
    const rightConsumer = await right.plugin(consumer('right'))

    expect(Object.fromEntries(seen)).toEqual({
      left: 'left-value',
      'left:logger': 'left-scope',
      right: 'right-value',
      'right:logger': 'right-scope',
    })

    await leftProvider.dispose()
    expect(leftConsumer.state).toBe(0)
    expect(rightConsumer.state).toBe(2)

    await leftConsumer.dispose()
    await rightConsumer.dispose()
    await rightProvider.dispose()
  })
})

describe('ProgramRuntime reconciliation proof', () => {
  it('hot-swaps one nested component while preserving unrelated fibers and isolated graphs', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'codex-cordis-paper-'))
    temporaryDirectories.push(projectRoot)
    const programRoot = path.join(projectRoot, 'program')
    const pluginRoot = path.join(programRoot, 'plugins')
    await mkdir(pluginRoot, { recursive: true })

    const profile = (leftValue: string): ProgramProfile => ({
      version: 2,
      plugins: [
        {
          id: 'stable',
          name: 'Stable',
          description: 'An unrelated stable plugin.',
          module: 'plugins/stable.ts',
          enabled: true,
          config: {},
          isolate: {},
          intercept: {},
          children: [],
        },
        {
          id: 'left',
          name: 'Left Graph',
          description: 'An isolated graph used by the reconciliation proof.',
          enabled: true,
          config: {},
          isolate: { graphProbe: true },
          intercept: { logger: { name: 'left-program-scope' } },
          children: [
            {
              id: 'left-provider',
              name: 'Left Provider',
              description: 'Provides the left graph value.',
              module: 'plugins/provider-left.ts',
              enabled: true,
              config: { value: leftValue },
              isolate: {},
              intercept: {},
              children: [],
            },
            {
              id: 'left-consumer',
              name: 'Left Consumer',
              description: 'Consumes the left graph value.',
              module: 'plugins/consumer.ts',
              enabled: true,
              config: { tool: 'left_read', state: 'left' },
              isolate: {},
              intercept: {},
              children: [],
            },
            {
              id: 'left-logger',
              name: 'Left Logger',
              description: 'Reads the intercepted logger configuration.',
              module: 'plugins/logger.ts',
              enabled: true,
              config: {},
              isolate: {},
              intercept: {},
              children: [],
            },
          ],
        },
        {
          id: 'right',
          name: 'Right Graph',
          description: 'A second isolated graph used by the reconciliation proof.',
          enabled: true,
          config: {},
          isolate: { graphProbe: true },
          intercept: {},
          children: [
            {
              id: 'right-provider',
              name: 'Right Provider',
              description: 'Provides the right graph value.',
              module: 'plugins/provider-right.ts',
              enabled: true,
              config: { value: 'right-v1' },
              isolate: {},
              intercept: {},
              children: [],
            },
            {
              id: 'right-consumer',
              name: 'Right Consumer',
              description: 'Consumes the right graph value.',
              module: 'plugins/consumer.ts',
              enabled: true,
              config: { tool: 'right_read', state: 'right' },
              isolate: {},
              intercept: {},
              children: [],
            },
          ],
        },
      ],
    })
    const profileText = (value: string): string => `${JSON.stringify(profile(value), null, 2)}\n`
    const providerV1 = `
const plugin = (ctx, config) => ctx.provide('graphProbe', config.value)
plugin.provide = 'graphProbe'
export default plugin
`
    const providerV2 = `
const plugin = (ctx, config) => ctx.provide('graphProbe', config.value + ':code-v2')
plugin.provide = 'graphProbe'
export default plugin
`
    const consumerSource = `
const states = globalThis.__cordisPaperStates ??= new Map()
const plugin = (ctx, config) => {
  const state = states.get(config.state) ?? { activations: 0, disposals: 0 }
  states.set(config.state, state)
  const activation = ++state.activations
  ctx.tools.register(ctx, {
    name: config.tool,
    description: 'Read an isolated graph value.',
    inputSchema: { type: 'object', properties: {} },
  }, () => ({ value: ctx.graphProbe, activation, disposals: state.disposals }))
  return () => { state.disposals += 1 }
}
plugin.inject = ['graphProbe', 'tools']
export default plugin
`
    const stableSource = `
const token = Math.random().toString(36)
let activations = 0
const plugin = (ctx) => {
  const activation = ++activations
  ctx.tools.register(ctx, {
    name: 'stable_identity',
    description: 'Expose this module and fiber identity.',
    inputSchema: { type: 'object', properties: {} },
  }, () => ({ token, activation }))
}
plugin.inject = ['tools']
export default plugin
`
    const loggerSource = `
const plugin = (ctx) => {
  ctx.tools.register(ctx, {
    name: 'scope_logger',
    description: 'Expose the intercepted logger name.',
    inputSchema: { type: 'object', properties: {} },
  }, () => ({ name: ctx.logger().name }))
}
plugin.inject = ['tools']
export default plugin
`

    await writeFile(path.join(programRoot, 'cordis.json'), profileText('left-v1'))
    await writeFile(path.join(pluginRoot, 'provider-left.ts'), providerV1)
    await writeFile(path.join(pluginRoot, 'provider-right.ts'), providerV1)
    await writeFile(path.join(pluginRoot, 'consumer.ts'), consumerSource)
    await writeFile(path.join(pluginRoot, 'stable.ts'), stableSource)
    await writeFile(path.join(pluginRoot, 'logger.ts'), loggerSource)

    const ctx = new Context()
    const toolsFiber = await ctx.plugin(toolRegistryPlugin)
    const runtime = new ProgramRuntime(ctx, { projectRoot, watch: false })
    const stopRuntime = await runtime.start()
    const originalSpecs = ctx.tools.toAppServerSpecs()
    const stableBefore = await dispatch(ctx.tools, 'stable_identity')
    expect(await dispatch(ctx.tools, 'left_read')).toMatchObject({
      value: 'left-v1',
      activation: 1,
    })
    expect(await dispatch(ctx.tools, 'right_read')).toMatchObject({
      value: 'right-v1',
      activation: 1,
    })
    expect(await dispatch(ctx.tools, 'scope_logger')).toEqual({
      name: 'left-program-scope',
    })
    expect(runtime.snapshot().plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'left', depth: 0, isolate: { graphProbe: true } }),
      expect.objectContaining({
        id: 'left-consumer',
        parentId: 'left',
        depth: 1,
        inject: ['graphProbe', 'tools'],
      }),
    ]))

    await runtime.applyChange('Update only the left provider config.', [{
      path: 'cordis.json',
      content: profileText('left-v2'),
    }])
    expect(await dispatch(ctx.tools, 'left_read')).toMatchObject({
      value: 'left-v2',
      activation: 2,
    })
    expect(await dispatch(ctx.tools, 'right_read')).toMatchObject({
      value: 'right-v1',
      activation: 1,
    })
    expect(await dispatch(ctx.tools, 'stable_identity')).toEqual(stableBefore)
    expect(ctx.tools.toAppServerSpecs()).toEqual(originalSpecs)

    const beforeCodeSwap = runtime.snapshot()
    await runtime.applyChange('Hot-swap only the provider component.', [{
      path: 'plugins/provider-left.ts',
      content: providerV2,
    }])
    expect(await dispatch(ctx.tools, 'left_read')).toMatchObject({
      value: 'left-v2:code-v2',
      activation: 3,
    })
    expect(await dispatch(ctx.tools, 'right_read')).toMatchObject({
      value: 'right-v1',
      activation: 1,
    })
    expect(await dispatch(ctx.tools, 'stable_identity')).toEqual(stableBefore)
    const afterCodeSwap = runtime.snapshot()
    expect(afterCodeSwap.plugins.find(({ id }) => id === 'stable')?.loadedAt)
      .toBe(beforeCodeSwap.plugins.find(({ id }) => id === 'stable')?.loadedAt)
    expect(afterCodeSwap.plugins.find(({ id }) => id === 'left-provider')?.loadedAt)
      .not.toBe(beforeCodeSwap.plugins.find(({ id }) => id === 'left-provider')?.loadedAt)

    const consumerLoadedAt = afterCodeSwap.plugins.find(({ id }) => id === 'left-consumer')?.loadedAt
    await runtime.setPluginEnabled('left-provider', false)
    expect(runtime.snapshot().plugins.find(({ id }) => id === 'left-provider')).toMatchObject({
      enabled: false,
      effectiveEnabled: false,
      state: 'disabled',
    })
    expect(runtime.snapshot().plugins.find(({ id }) => id === 'left-consumer')).toMatchObject({
      enabled: true,
      effectiveEnabled: true,
      state: 'pending',
    })
    expect(ctx.tools.list().map(({ name }) => name)).not.toContain('left_read')
    expect(await dispatch(ctx.tools, 'right_read')).toMatchObject({
      value: 'right-v1',
      activation: 1,
    })
    expect(await dispatch(ctx.tools, 'stable_identity')).toEqual(stableBefore)
    const disabledProfile = JSON.parse(
      await readFile(path.join(programRoot, 'cordis.json'), 'utf8'),
    ) as ProgramProfile
    expect(disabledProfile.plugins[1]?.children[0]?.enabled).toBe(false)

    await runtime.setPluginEnabled('left-provider', true)
    expect(await dispatch(ctx.tools, 'left_read')).toMatchObject({
      value: 'left-v2:code-v2',
      activation: 4,
      disposals: 3,
    })
    expect(await dispatch(ctx.tools, 'right_read')).toMatchObject({
      value: 'right-v1',
      activation: 1,
    })
    expect(await dispatch(ctx.tools, 'stable_identity')).toEqual(stableBefore)
    expect(runtime.snapshot().plugins.find(({ id }) => id === 'left-consumer')?.loadedAt)
      .toBe(consumerLoadedAt)

    await expect(runtime.applyChange('Attempt an activation that throws.', [{
      path: 'plugins/provider-left.ts',
      content: `
const plugin = () => { throw new Error('activation exploded') }
plugin.provide = 'graphProbe'
export default plugin
`,
    }])).rejects.toThrow('previous program was restored')
    expect(await dispatch(ctx.tools, 'left_read')).toMatchObject({
      value: 'left-v2:code-v2',
    })
    expect(await dispatch(ctx.tools, 'stable_identity')).toEqual(stableBefore)
    await expect(readFile(path.join(pluginRoot, 'provider-left.ts'), 'utf8')).resolves.toBe(providerV2)

    const extensionPlugin = 'const plugin = () => undefined\nexport default plugin\n'
    await runtime.applyChange('Add a deployment-specific plugin.', [{
      path: 'extensions/example/provider.ts',
      content: extensionPlugin,
    }])
    await expect(readFile(
      path.join(programRoot, 'extensions/example/provider.ts'),
      'utf8',
    )).resolves.toBe(extensionPlugin)

    await stopRuntime()
    await toolsFiber.dispose()
    delete (globalThis as { __cordisPaperStates?: unknown }).__cordisPaperStates
  })

  it('restores the server tree when the browser rejects a paired activation', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'alto-activation-'))
    temporaryDirectories.push(projectRoot)
    const programRoot = path.join(projectRoot, 'program')
    const pluginRoot = path.join(programRoot, 'plugins')
    await mkdir(pluginRoot, { recursive: true })
    const profile = {
      version: 2,
      plugins: [{
        id: 'paired',
        name: 'Paired plugin',
        description: 'Exercises coordinated server and browser activation.',
        module: 'plugins/paired.ts',
        client: 'plugins/paired.client.ts',
        enabled: true,
        config: {},
      }],
    }
    const serverSource = (value: string): string => `
const plugin = (ctx) => ctx.provide('activationProbe', '${value}')
plugin.provide = 'activationProbe'
export default plugin
`
    const clientSource = (value: string): string => `
const plugin = () => undefined
plugin.clientValue = '${value}'
export default plugin
`
    await writeFile(path.join(programRoot, 'cordis.json'), `${JSON.stringify(profile, null, 2)}\n`)
    await writeFile(path.join(pluginRoot, 'paired.ts'), serverSource('v1'))
    await writeFile(path.join(pluginRoot, 'paired.client.ts'), clientSource('v1'))

    const ctx = new Context()
    const runtime = new ProgramRuntime(ctx, { projectRoot, watch: false })
    const stopRuntime = await runtime.start()
    const committed = runtime.snapshot()
    expect(ctx.reflect.get('activationProbe')).toBe('v1')

    const activate = vi.fn(async (candidate) => {
      expect(candidate.revision).toBe(committed.revision + 1)
      expect(ctx.reflect.get('activationProbe')).toBe('v2')
      throw new Error('browser rejected candidate')
    })
    runtime.setClientActivator(activate)
    await writeFile(path.join(pluginRoot, 'paired.ts'), serverSource('v2'))
    await writeFile(path.join(pluginRoot, 'paired.client.ts'), clientSource('v2'))

    await expect(runtime.reconcile(true)).rejects.toThrow('previous program was restored')
    expect(activate).toHaveBeenCalledOnce()
    expect(ctx.reflect.get('activationProbe')).toBe('v1')
    expect(runtime.snapshot()).toMatchObject({ revision: committed.revision })

    await stopRuntime()
  })
})
