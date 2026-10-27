import { Context, type Plugin } from 'cordis'
import { expect, it } from 'vitest'
import scheduledClient from '../program/plugins/scheduled.client.js'
import { SidebarController } from '../program/plugins/sidebar.client.js'
import { ClientUiRegistry } from '../src/client/plugin-runtime.js'

it('keeps the scheduled dialog mounted while its sidebar action is unloaded and replaced', async () => {
  const root = new Context()
  const ui = new ClientUiRegistry()
  const services: Plugin = (ctx) => {
    ctx.provide('clientUi', ui)
    ctx.provide('clientHost', {} as Context['clientHost'])
    ctx.provide('clientSession', {} as Context['clientSession'])
    ctx.provide('clientWorkContexts', {} as Context['clientWorkContexts'])
  }
  services.provide = ['clientUi', 'clientHost', 'clientSession', 'clientWorkContexts']
  const fibers = [await root.plugin(services), await root.plugin(scheduledClient, {})]
  const installSidebar = async () => {
    const sidebar = new SidebarController()
    const plugin: Plugin = (ctx) => { ctx.provide('clientSidebar', sidebar) }
    plugin.provide = 'clientSidebar'
    const fiber = await root.plugin(plugin)
    fibers.push(fiber)
    return { sidebar, fiber }
  }
  try {
    const overlay = ui.rootRenderers().find((entry) => entry.id === 'scheduled-overlay')?.renderer
    expect(overlay).toBeDefined()
    ui.overlays.open('scheduled')
    for (let replacement = 0; replacement < 2; replacement++) {
      const { sidebar, fiber } = await installSidebar()
      expect(sidebar.actions().map((action) => action.id)).toEqual(['scheduled'])
      expect(ui.rootRenderers()).toEqual([{ id: 'scheduled-overlay', renderer: overlay }])
      await fiber.dispose()
      expect(sidebar.actions()).toEqual([])
      expect(ui.rootRenderers()).toEqual([{ id: 'scheduled-overlay', renderer: overlay }])
      expect(ui.overlays.snapshot()).toBe('scheduled')
    }
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
  expect(ui.rootRenderers()).toEqual([])
})
