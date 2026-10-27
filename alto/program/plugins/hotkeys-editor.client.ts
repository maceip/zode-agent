import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import type {} from './editor-pane-api.js'

const hotkeysEditor: BrowserPlugin = (ctx) => {
  ctx.clientHotkeys.registerAction(ctx, {
    id: 'editor.open', label: 'Open editor pane', category: 'Workspace',
    detail: 'Open or focus Neovim for the current chat’s workspace.',
    binding: { kind: 'global', key: 'e', meta: true },
    enabled: () => !ctx.clientEditor.unavailable(ctx.clientSession),
    run: () => ctx.clientEditor.open(ctx.clientSession),
  })
}
hotkeysEditor.inject = ['clientEditor', 'clientHotkeys', 'clientSession']
export default hotkeysEditor
