export const WORKSPACE_PANE_HOTKEY_ACTIONS = {
  splitRight: 'workspace.pane.split-right',
  splitDown: 'workspace.pane.split-down',
  fullscreen: 'workspace.pane.fullscreen',
  close: 'workspace.pane.close',
} as const

export type WorkspacePaneHotkeyActionId =
  typeof WORKSPACE_PANE_HOTKEY_ACTIONS[keyof typeof WORKSPACE_PANE_HOTKEY_ACTIONS]
