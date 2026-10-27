import type { Plugin } from 'cordis'
import { PANE_TABS_HOTKEY_ACTIONS } from './pane-tabs-api.js'

const hotkeysPaneTabs: Plugin = (ctx) => {
  ctx.clientHotkeys.registerAction(ctx, {
    id: PANE_TABS_HOTKEY_ACTIONS.create,
    label: 'New pane tab',
    detail: 'Open a new tab inside the focused tabbed pane.',
    category: 'Workspace',
    binding: {
      kind: 'leader',
      prefix: [{ key: 'p', label: 'Panes' }],
      key: 't',
    },
    enabled: () => ctx.clientPaneTabs.canCreateInActivePane(),
    run: () => {
      ctx.clientPaneTabs.createInActivePane()
    },
  })
}

hotkeysPaneTabs.inject = ['clientHotkeys', 'clientPaneTabs']

export default hotkeysPaneTabs
