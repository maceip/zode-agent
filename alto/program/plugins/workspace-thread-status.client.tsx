import type { Plugin } from 'cordis'
import { useSyncExternalStore } from 'react'
import { aggregateThreadWorkStatus } from './thread-status-api.js'
import { ThreadStatusIndicator } from './ui/thread-status.js'
import type { WorkspaceTabAddonProps } from './workspace-layout-api.js'

const workspaceThreadStatus: Plugin = (ctx) => {
  const TabStatus = ({ threadIds }: WorkspaceTabAddonProps) => {
    const status = useSyncExternalStore(
      ctx.clientThreadStatus.subscribe,
      ctx.clientThreadStatus.snapshot,
    )
    const aggregate = aggregateThreadWorkStatus(status, threadIds)
    if (!aggregate) return null
    return (
      <span className="workspace-tab-thread-status">
        <ThreadStatusIndicator status={aggregate} />
      </span>
    )
  }

  ctx.clientWorkspaceLayout.registerTabAddon(ctx, {
    id: 'workspace-thread-status',
    order: 10,
    renderer: TabStatus,
  })
}

workspaceThreadStatus.inject = ['clientThreadStatus', 'clientWorkspaceLayout']

export default workspaceThreadStatus
