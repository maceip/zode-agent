import type { Plugin } from 'cordis'

const hotkeysSidebar: Plugin = (ctx) => {
  ctx.clientHotkeys.registerAction(ctx, {
    id: 'panel.sidebar.toggle',
    label: 'Toggle conversation sidebar',
    detail: 'Hide or temporarily reveal the conversation history on the left.',
    category: 'Panels',
    binding: { kind: 'leader', key: 'e' },
    aliases: [{ kind: 'global', key: 'b', meta: true }],
    run: () => {
      const sidebar = ctx.clientSidebar.snapshot()
      ctx.clientSidebar.setCollapsed(!sidebar.collapsed)
    },
  })
}

hotkeysSidebar.inject = ['clientHotkeys', 'clientSidebar']

export default hotkeysSidebar
