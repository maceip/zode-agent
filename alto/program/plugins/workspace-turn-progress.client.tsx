import {
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type {
  BrowserPlugin,
  ClientHostService,
  ClientUiService,
} from '../../src/client/plugin-api.js'
import type { ClientSessionService } from './session-api.js'
import {
  TurnProgressService,
  ConnectedTurnProgress,
} from './turn-progress.client.js'

function PaneTurnProgress({
  host,
  session,
  ui,
}: {
  host: ClientHostService
  session: ClientSessionService
  ui: ClientUiService
}): ReactNode {
  const [progress, setProgress] = useState<TurnProgressService>()

  useEffect(() => {
    const service = new TurnProgressService(host, session)
    setProgress(service)
    return () => service.dispose()
  }, [host, session])

  if (!progress) return null
  return <ConnectedTurnProgress progress={progress} session={session} ui={ui} />
}

const workspaceTurnProgress: BrowserPlugin = (ctx) => {
  const host = ctx.clientHost
  const ui = ctx.clientUi
  ctx.clientWorkspaceLayout.registerPaneAddon(ctx, {
    id: 'turn-progress',
    placement: 'before-composer',
    order: 10,
    renderer: ({ session }) => <PaneTurnProgress host={host} session={session} ui={ui} />,
  })
}

workspaceTurnProgress.inject = ['clientHost', 'clientUi', 'clientWorkspaceLayout']

export default workspaceTurnProgress
