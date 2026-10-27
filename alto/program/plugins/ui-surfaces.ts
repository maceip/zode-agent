import type { HarnessPlugin, UiSurface } from '../../src/server/plugin-api.js'

const surfaces: UiSurface[] = [
  {
    id: 'default-plugins',
    kind: 'plugins',
    label: 'Plugins',
    appearance: 'icon',
  },
  {
    id: 'default-settings',
    kind: 'settings',
    label: 'Settings',
    appearance: 'icon',
  },
  {
    id: 'default-conversation',
    kind: 'conversation',
    emptyState: 'none',
    markdown: true,
  },

]

const uiSurfaces: HarnessPlugin = (ctx) => {

  for (const surface of surfaces) ctx.ui.registerSurface(ctx, surface)
  ctx.provide('uiDefaults', true)
}

uiSurfaces.inject = ['ui']
uiSurfaces.provide = 'uiDefaults'

export default uiSurfaces
