export const OPEN_IN_IDE = 'open-in-ide.open'

export const IDE_OPTIONS = [
  { id: 'vscode', label: 'Visual Studio Code', command: 'code', app: 'Visual Studio Code.app', cli: 'Contents/Resources/app/bin/code' },
  { id: 'cursor', label: 'Cursor', command: 'cursor', app: 'Cursor.app', cli: 'Contents/Resources/app/bin/cursor' },
  { id: 'zed', label: 'Zed', command: 'zed', app: 'Zed.app', cli: 'Contents/MacOS/cli' },
] as const

export type IdeId = typeof IDE_OPTIONS[number]['id']

export function isIdeId(value: unknown): value is IdeId {
  return IDE_OPTIONS.some((ide) => ide.id === value)
}
