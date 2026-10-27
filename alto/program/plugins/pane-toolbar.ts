import { clientStyles } from '../../src/client/plugin-api.js'

// A running Alto window can hot-reload plugins before its fixed client bundle
// picks up a newly added style key. Keep the stable class names as fallbacks so
// toolbar migrations apply immediately and converge on clientStyles at restart.
const styles = clientStyles as typeof clientStyles & {
  toolbar?: string
  paneToolbar?: string
  toolbarTitle?: string
  toolbarPicker?: string
  toolbarActions?: string
  toolbarGroup?: string
  toolbarModes?: string
}

export const paneToolbarStyles = {
  toolbar: styles.toolbar ?? 'alto-toolbar',
  pane: styles.paneToolbar ?? 'alto-pane-toolbar',
  title: styles.toolbarTitle ?? 'alto-toolbar-title',
  picker: styles.toolbarPicker ?? 'alto-toolbar-picker',
  actions: styles.toolbarActions ?? 'alto-toolbar-actions',
  group: styles.toolbarGroup ?? 'alto-toolbar-group',
  modes: styles.toolbarModes ?? 'alto-toolbar-modes',
} as const
