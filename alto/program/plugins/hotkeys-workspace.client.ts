import type { Plugin } from 'cordis'
import type { WorkspaceMoveDirection } from './workspace-layout-state.js'
import { WORKSPACE_PANE_HOTKEY_ACTIONS } from './workspace-hotkey-actions.js'

const hotkeysWorkspace: Plugin = (ctx) => {
  ctx.clientHotkeys.registerAction(ctx, {
    id: 'workspace.tab.new',
    label: 'New tab',
    detail: 'Open the current workspace in a new tab and switch to it.',
    category: 'Workspace',
    binding: { kind: 'leader', key: 't' },
    aliases: [{ kind: 'global', key: 't', meta: true }],
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.newTab(),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'workspace.tab.close',
    label: 'Close workspace tab',
    detail: 'Close the active top-level workspace tab. The final tab remains open.',
    category: 'Workspace',
    binding: {
      kind: 'leader',
      prefix: [{ key: 'w', label: 'Workspaces' }],
      key: 'x',
    },
    enabled: () => ctx.clientWorkspaceLayout.canCloseActiveTab(),
    run: () => ctx.clientWorkspaceLayout.closeActiveTab(),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'workspace.tab.restore',
    label: 'Reopen closed pane or tab',
    detail: 'Restore the most recently closed pane or top-level workspace tab.',
    category: 'Workspace',
    binding: { kind: 'global', key: 't', meta: true, shift: true },
    enabled: () => ctx.clientWorkspaceLayout.canRestoreClosedTab(),
    run: () => ctx.clientWorkspaceLayout.restoreClosedTab(),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: WORKSPACE_PANE_HOTKEY_ACTIONS.splitRight,
    label: 'Vertical split',
    detail: 'Split the focused pane side by side.',
    category: 'Workspace',
    binding: {
      kind: 'leader',
      prefix: [{ key: 'p', label: 'Panes' }],
      key: 'r',
    },
    aliases: [{ kind: 'global', key: 'd', meta: true }],
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.splitFocused('horizontal'),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: WORKSPACE_PANE_HOTKEY_ACTIONS.splitDown,
    label: 'Horizontal split',
    detail: 'Split the focused pane into top and bottom.',
    category: 'Workspace',
    binding: {
      kind: 'leader',
      prefix: [{ key: 'p', label: 'Panes' }],
      key: 'd',
    },
    aliases: [{ kind: 'global', key: 'd', meta: true, shift: true }],
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.splitFocused('vertical'),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: WORKSPACE_PANE_HOTKEY_ACTIONS.fullscreen,
    label: 'Toggle focused pane full screen',
    detail: 'Expand the focused pane to fill its workspace, or restore the split layout.',
    category: 'Workspace',
    binding: { kind: 'leader', key: 'f' },
    aliases: [{ kind: 'global', key: 'f', meta: true }],
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.toggleFocusedPaneFullscreen(),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'workspace.pane.new',
    label: 'New pane',
    detail: 'Open a new pane beside the focused pane.',
    category: 'Workspace',
    binding: { kind: 'global', key: 'n', alt: true },
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.splitFocused('horizontal'),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'workspace.tab.next',
    label: 'Next workspace tab',
    detail: 'Switch to the next workspace tab.',
    category: 'Workspace',
    binding: { kind: 'global', key: 'Tab', ctrl: true },
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.cycleTabs(1),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'workspace.tab.previous',
    label: 'Previous workspace tab',
    detail: 'Switch to the previous workspace tab.',
    category: 'Workspace',
    binding: { kind: 'global', key: 'Tab', ctrl: true, shift: true },
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.cycleTabs(-1),
  })

  for (let index = 0; index < 9; index += 1) {
    const key = String(index + 1)
    ctx.clientHotkeys.registerAction(ctx, {
      id: `workspace.tab.select.${key}`,
      label: `Select workspace tab ${key}`,
      detail: `Switch to workspace tab ${key} when it exists.`,
      category: 'Workspace',
      binding: { kind: 'global', key, meta: true },
      enabled: () => ctx.clientWorkspaceLayout.available(),
      run: () => ctx.clientWorkspaceLayout.selectTab(index),
    })
  }

  const focusBindings: Array<{
    direction: WorkspaceMoveDirection
    key: string
    arrow: string
    cycleTabAtEdge: boolean
  }> = [
    { direction: 'left', key: 'h', arrow: 'ArrowLeft', cycleTabAtEdge: true },
    { direction: 'down', key: 'j', arrow: 'ArrowDown', cycleTabAtEdge: false },
    { direction: 'up', key: 'k', arrow: 'ArrowUp', cycleTabAtEdge: false },
    { direction: 'right', key: 'l', arrow: 'ArrowRight', cycleTabAtEdge: true },
  ]
  for (const binding of focusBindings) {
    ctx.clientHotkeys.registerAction(ctx, {
      id: `workspace.pane.focus-${binding.direction}`,
      label: `Focus pane ${binding.direction}`,
      detail: binding.cycleTabAtEdge
        ? `Focus the pane to the ${binding.direction}, or cross into the adjacent tab at the edge.`
        : `Focus the pane ${binding.direction} of the current pane.`,
      category: 'Workspace',
      binding: { kind: 'global', key: binding.key, alt: true },
      aliases: [{ kind: 'global', key: binding.arrow, alt: true }],
      enabled: () => ctx.clientWorkspaceLayout.available(),
      // Each pane owns its focus target. Chat panes select their composer and
      // native panes such as Ghostty claim first-responder focus themselves.
      run: () => ctx.clientWorkspaceLayout.focusAdjacentPane(
        binding.direction,
        binding.cycleTabAtEdge,
      ),
    })
  }

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'workspace.tab.move-left',
    label: 'Move workspace tab left',
    detail: 'Move the active workspace tab one position left.',
    category: 'Workspace',
    binding: { kind: 'global', key: 'i', alt: true },
    aliases: [{ kind: 'global', key: 'ArrowLeft', ctrl: true, shift: true }],
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.moveActiveTab(-1),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'workspace.tab.move-right',
    label: 'Move workspace tab right',
    detail: 'Move the active workspace tab one position right.',
    category: 'Workspace',
    binding: { kind: 'global', key: 'o', alt: true },
    aliases: [{ kind: 'global', key: 'ArrowRight', ctrl: true, shift: true }],
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.moveActiveTab(1),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'workspace.pane.grow',
    label: 'Grow focused pane',
    detail: 'Increase the focused pane along its split boundaries.',
    category: 'Workspace',
    binding: { kind: 'global', key: '=', alt: true },
    aliases: [{ kind: 'global', key: '+', alt: true, shift: true }],
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.resizeFocusedPane(1),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'workspace.pane.shrink',
    label: 'Shrink focused pane',
    detail: 'Decrease the focused pane along its split boundaries.',
    category: 'Workspace',
    binding: { kind: 'global', key: '-', alt: true },
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => ctx.clientWorkspaceLayout.resizeFocusedPane(-1),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: WORKSPACE_PANE_HOTKEY_ACTIONS.close,
    label: 'Close focused pane',
    detail: 'Close the focused pane when another pane remains open.',
    category: 'Workspace',
    binding: {
      kind: 'leader',
      prefix: [{ key: 'p', label: 'Panes' }],
      key: 'x',
    },
    enabled: () => ctx.clientWorkspaceLayout.canCloseFocusedPane(),
    run: () => ctx.clientWorkspaceLayout.closeFocusedPane(),
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'workspace.close-current',
    label: 'Close pane or tab',
    detail: 'Close the focused pane, or its workspace tab when it is the only pane.',
    category: 'Workspace',
    binding: { kind: 'global', key: 'w', meta: true },
    // Keep Command-W captured on the final tab so Electron never interprets
    // it as a request to close the Alto window.
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => {
      if (ctx.clientWorkspaceLayout.canCloseFocusedPane()) {
        ctx.clientWorkspaceLayout.closeFocusedPane()
      } else {
        ctx.clientWorkspaceLayout.closeActiveTab()
      }
    },
  })
}

hotkeysWorkspace.inject = ['clientHotkeys', 'clientWorkspaceLayout']

export default hotkeysWorkspace
