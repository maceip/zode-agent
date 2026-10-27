import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import { PR_PANE, PR_TOGGLE_ACTION } from './pull-requests-api.js'
import type {} from './hotkeys-api.js'

const pullRequestHotkeys: BrowserPlugin = (ctx) => {
  ctx.clientHotkeys.registerAction(ctx, {
    id: PR_TOGGLE_ACTION,
    label: 'Toggle pull requests',
    detail: 'Show or hide your open GitHub pull requests.',
    category: 'Panels',
    binding: { kind: 'leader', key: 'r' },
    aliases: [{ kind: 'global', key: 'p', meta: true, shift: true }],
    run: () => ctx.clientUi.overlays.toggle(PR_PANE),
  })
}

pullRequestHotkeys.inject = ['clientHotkeys', 'clientUi']
export default pullRequestHotkeys
