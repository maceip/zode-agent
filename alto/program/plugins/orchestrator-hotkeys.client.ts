import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import { AGENTS_TOGGLE_ACTION } from './orchestrator-panel.js'
import type {} from './hotkeys-api.js'

const agentsHotkeys: BrowserPlugin = (ctx) => {
  ctx.clientHotkeys.registerAction(ctx, {
    id: AGENTS_TOGGLE_ACTION,
    label: 'Toggle agents',
    category: 'Panels',
    binding: { kind: 'global', key: 'a', meta: true, shift: true },
    run: () => ctx.clientAgentsPanel.toggleTemporary(),
  })
}
agentsHotkeys.inject = ['clientHotkeys', 'clientAgentsPanel']
export default agentsHotkeys
