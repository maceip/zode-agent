import type { Plugin } from 'cordis'
import type { UiSurface } from '../../src/shared/protocol.js'
import { ScrollbackSurface } from './scrollback.client.js'
import type { WorkspacePaneAddonProps } from './workspace-layout-api.js'

const surface: UiSurface = {
  id: 'workspace-layout-scrollback',
  kind: 'scrollback',
  label: 'Conversation scrollback',
}

const workspaceScrollback: Plugin = (ctx) => {
  const PaneScrollback = ({ paneId, session, visible }: WorkspacePaneAddonProps) => (
    <ScrollbackSurface surface={surface} session={session} paneId={paneId} visible={visible} />
  )

  ctx.clientWorkspaceLayout.registerPaneAddon(ctx, {
    id: 'workspace-scrollback',
    placement: 'conversation-overlay',
    renderer: PaneScrollback,
  })
}

workspaceScrollback.inject = ['clientWorkspaceLayout']

export default workspaceScrollback
