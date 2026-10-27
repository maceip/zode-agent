import type {
  HarnessPlugin,
  UiShellRegion,
  UiSurface,
} from '../../src/server/plugin-api.js'
import {
  installCodexWorkspaceSource,
  type CodexWorkspaceImportOptions,
} from './sidebar/codex-workspaces.js'
import type { SidebarResizeConfig } from './sidebar.client.js'

export type SidebarOptions = CodexWorkspaceImportOptions & SidebarResizeConfig

const surfaces: UiSurface[] = [
  {
    id: 'default-new-thread',
    kind: 'new-thread',
    label: 'New chat',
    appearance: 'full',
  },
  {
    id: 'default-new-workspace',
    kind: 'new-workspace',
    label: 'New workspace',
    appearance: 'full',
  },
  {
    id: 'default-history',
    kind: 'history',
    label: 'Workspaces',
    appearance: 'full',
    limit: 40,
    showAge: false,
    emptyText: '',
  },
  {
    id: 'default-sidebar-resize',
    kind: 'sidebar-resize',
  },
]

const region: UiShellRegion = {
  id: 'default-sidebar',
  outlet: 'sidebar',
  root: {
    type: 'box',
    id: 'conversation-history',
    role: 'aside',
    direction: 'column',
    width: 'compact',
    surface: 'panel',
    border: 'soft',
    children: [
      {
        type: 'box',
        direction: 'column',
        gap: 'sm',
        padding: 'md',
        children: [
          { type: 'surface', id: 'default-new-thread' },
        ],
      },
      { type: 'surface', id: 'default-history' },
      { type: 'surface', id: 'default-sidebar-resize' },
    ],
  },
}

const sidebar: HarnessPlugin<SidebarOptions> = (ctx, options) => {
  installCodexWorkspaceSource(ctx, options ?? {})
  for (const surface of surfaces) ctx.ui.registerSurface(ctx, surface)
  ctx.ui.registerShellRegion(ctx, region)
}

sidebar.inject = ['projects', 'ui']

export default sidebar
