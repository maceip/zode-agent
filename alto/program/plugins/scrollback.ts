import type { HarnessPlugin, UiSurface } from '../../src/server/plugin-api.js'

const surface: UiSurface = {
  id: 'default-scrollback',
  kind: 'scrollback',
  label: 'Conversation scrollback',
}

const scrollback: HarnessPlugin = (ctx) => {
  ctx.ui.registerSurface(ctx, surface)
}

scrollback.inject = ['ui']

export default scrollback
