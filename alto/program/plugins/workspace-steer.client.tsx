import type { Plugin } from 'cordis'
import type { UiSurface } from '../../src/shared/protocol.js'
import { SteerSurface } from './steer.client.js'
import type { WorkspacePaneAddonProps } from './workspace-layout-api.js'

const surface: UiSurface = {
  id: 'workspace-layout-steer',
  kind: 'steer',
}

const workspaceSteer: Plugin = (ctx) => {
  const PaneSteer = ({ session }: WorkspacePaneAddonProps) => (
    <SteerSurface surface={surface} queue={ctx.clientSteer.queue} session={session} />
  )

  ctx.clientWorkspaceLayout.registerPaneAddon(ctx, {
    id: 'workspace-steer',
    placement: 'before-composer',
    order: 20,
    renderer: PaneSteer,
  })
}

workspaceSteer.inject = ['clientSteer', 'clientWorkspaceLayout']

export default workspaceSteer
