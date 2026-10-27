import type { BrowserPlugin, ClientHostService } from '../../src/client/plugin-api.js'
import { CONVERSATION_RENAME, CONVERSATION_TITLES_STATE, type ConversationTitleSnapshot } from './conversation-titles-api.js'
import type { WorkspaceTabNameSource } from './workspace-layout-api.js'
import { workspaceViewThreads } from './workspace-tab-data.js'

export function conversationTabNames(host: ClientHostService): WorkspaceTabNameSource {
  const titles = (): ConversationTitleSnapshot => host.snapshot().snapshot?.extensions[CONVERSATION_TITLES_STATE] as unknown as ConversationTitleSnapshot ?? {}
  return {
    id: 'conversation-title',
    name: (id) => titles()[id]?.title,
    rename: async (id, title) => { await host.call(CONVERSATION_RENAME, { id, title }) },
    subscribe: (listener) => host.subscribe(listener),
    valid: (id, view) => workspaceViewThreads(view).some((thread) => thread.id === id),
    match: (view) => {
      const threads = workspaceViewThreads(view)
      const thread = threads.length === 1 ? threads[0] : undefined
      const title = thread && titles()[thread.id]?.title
      if (!thread || !title) return undefined
      // Existing custom tab names and task bindings retain ownership.
      if (/^(?:New chat|Untitled conversation)(?: \d+)?$/i.test(view.name) || view.name === title) return thread.id
      return undefined
    },
  }
}

const plugin: BrowserPlugin = (ctx) => {
  ctx.clientWorkspaceLayout.registerTabNameSource(ctx, conversationTabNames(ctx.clientHost))
}
plugin.inject = ['clientHost', 'clientWorkspaceLayout']
export default plugin
