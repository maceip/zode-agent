import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { CodeExplorerRegistry } from '../program/plugins/code-explorer.client.js'

describe('code explorer registry', () => {
  it('selects the highest-priority explorer and restores the previous one on teardown', async () => {
    const context = new Context()
    const registry = new CodeExplorerRegistry()
    const Default = () => 'default'
    const Override = () => 'override'
    const defaultFiber = await context.plugin((ctx) => {
      registry.register(ctx, { id: 'default', component: Default })
    })
    const overrideFiber = await context.plugin((ctx) => {
      registry.register(ctx, { id: 'override', component: Override, priority: 10 })
    })

    try {
      expect(registry.snapshot().explorer?.component).toBe(Override)

      await overrideFiber.dispose()

      expect(registry.snapshot().explorer?.component).toBe(Default)
    } finally {
      await defaultFiber.dispose()
      registry.dispose()
    }
  })

  it('removes the optional explorer entirely when its fiber unloads', async () => {
    const context = new Context()
    const registry = new CodeExplorerRegistry()
    const fiber = await context.plugin((ctx) => {
      registry.register(ctx, { id: 'tree', component: () => 'tree' })
    })

    try {
      expect(registry.snapshot().explorer?.id).toBe('tree')

      await fiber.dispose()

      expect(registry.snapshot().explorer).toBeUndefined()
    } finally {
      registry.dispose()
    }
  })
})
