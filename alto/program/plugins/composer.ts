import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { DEFAULT_COMPOSER_PLACEHOLDER } from './chat-surfaces-api.js'

const composer: HarnessPlugin = (ctx) => {
  ctx.ui.registerSurface(ctx, {
    id: 'default-composer', kind: 'composer', placeholder: DEFAULT_COMPOSER_PLACEHOLDER,
    focusHeight: 156, maxHeight: 180, capabilities: ['skills', 'markdown', 'images', 'files'],
  })
}
composer.inject = ['ui']
export default composer
