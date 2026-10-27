export const nativeViewIpc = {
  create: 'alto:native-view:create',
  navigate: 'alto:native-view:navigate',
  action: 'alto:native-view:action',
  bounds: 'alto:native-view:bounds',
  visible: 'alto:native-view:visible',
  focus: 'alto:native-view:focus',
  destroy: 'alto:native-view:destroy',
  focusHost: 'alto:native-view:focus-host',
  state: 'alto:native-view:state',
  keyInput: 'alto:native-view:key-input',
} as const

export type NativeViewAction = 'back' | 'forward' | 'reload'

export interface NativeViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export type NativeViewCreateOptions =
  | {
      kind?: 'browser'
      url: string
    }
  | {
      kind: 'pdf'
      path: string
    }

export interface NativeViewState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface NativeViewKeyInput {
  type: 'keydown' | 'keyup'
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
}

export function isNativeViewModifierInput(input: NativeViewKeyInput): boolean {
  return input.ctrlKey
    || input.metaKey
    || input.altKey
    || input.key === 'Escape'
    || input.key === 'Control'
    || input.key === 'Meta'
    || input.key === 'Alt'
}

export function isHostShortcut(input: NativeViewKeyInput): boolean {
  if (input.type !== 'keydown') return false
  const key = input.key.toLocaleLowerCase()
  if (input.ctrlKey && key === 'tab') return true
  if (input.ctrlKey && input.shiftKey && ['arrowleft', 'arrowright'].includes(key)) return true
  if (input.metaKey) {
    if (['t', 'w', 'k', 'd', 'f'].includes(key) || /^[1-9]$/.test(key)) return true
    if (input.shiftKey && key === 'p') return true
  }
  if (input.ctrlKey && key === 'k') return true
  return input.altKey && [
    'n', 'h', 'j', 'k', 'l', 'i', 'o', '=', '-',
    'arrowleft', 'arrowright', 'arrowdown', 'arrowup',
  ].includes(key)
}

export function nativeViewUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('native browser views only support http and https URLs')
  }
  return url.href
}

export function nativeViewBounds(value: NativeViewBounds): NativeViewBounds {
  const finite = [value.x, value.y, value.width, value.height]
    .every((part) => Number.isFinite(part))
  if (!finite) throw new Error('native browser view bounds must be finite')

  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
    width: Math.max(0, Math.round(value.width)),
    height: Math.max(0, Math.round(value.height)),
  }
}
