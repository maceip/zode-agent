import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import { sourcePath } from './source-paths.js'

const editorFileLinks: BrowserPlugin = (ctx) => {
  ctx.clientMarkdown.registerFileLink(ctx, {
    id: 'editor',
    priority: 100,
    matches: sourcePath,
    open: (details, origin) => ctx.clientEditor.openFile(details, origin),
  })
}
editorFileLinks.inject = ['clientEditor', 'clientMarkdown']
export default editorFileLinks
