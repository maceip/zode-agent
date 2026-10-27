import type { HarnessPlugin, UiSurface } from '../../src/server/plugin-api.js'

const surface: UiSurface = {
  id: 'default-turn-progress',
  kind: 'turn-progress',
}

const turnProgress: HarnessPlugin = (ctx) => {
  ctx.ui.registerSurface(ctx, surface)
}

turnProgress.inject = ['ui']

export default turnProgress
