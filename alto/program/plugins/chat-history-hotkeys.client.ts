import type { BrowserPlugin } from '../../src/client/plugin-api.js'

const historyHotkeys: BrowserPlugin = (ctx) => {
  ctx.clientHotkeys.registerAction(ctx, {
    id: 'chat-history.open', label: 'Open chat history', category: 'Panels',
    binding: { kind: 'global', key: 'h', meta: true, shift: true },
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.newTab('history'),
  })
}
historyHotkeys.inject = ['clientHotkeys', 'clientWorkspaceLayout']
export default historyHotkeys
