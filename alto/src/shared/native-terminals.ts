export const nativeTerminalIpc = {
  create: 'alto:native-terminal:create',
  bounds: 'alto:native-terminal:bounds',
  visible: 'alto:native-terminal:visible',
  overlay: 'alto:native-terminal:overlay',
  focus: 'alto:native-terminal:focus',
  configure: 'alto:native-terminal:configure',
  destroy: 'alto:native-terminal:destroy',
  keyInput: 'alto:native-terminal:key-input',
} as const

export interface NativeTerminalBounds {
  x: number
  y: number
  width: number
  height: number
}

/** A web overlay in viewport coordinates; native content remains visible outside it. */
export interface NativeTerminalOverlay extends NativeTerminalBounds {
  borderRadius: number
}

export function nativeTerminalOverlay(value: NativeTerminalOverlay | null): NativeTerminalOverlay | null {
  if (value === null) return null
  const bounds = nativeTerminalBounds(value)
  if (!Number.isFinite(value.borderRadius)) throw new Error('native terminal overlay radius must be finite')
  return { ...bounds, borderRadius: Math.max(0, Math.min(value.borderRadius, bounds.width / 2, bounds.height / 2)) }
}

export interface NativeTerminalCreateOptions {
  workingDirectory?: string
  command?: string
  configuration?: string
  bounds?: NativeTerminalBounds
}

export interface NativeTerminalState {
  id: string
  backend: 'ghostty'
  supportsOverlay?: boolean
}

export interface NativeTerminalKeyInput {
  type: 'keydown' | 'keyup'
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
}

export function nativeTerminalBounds(value: NativeTerminalBounds): NativeTerminalBounds {
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) {
    throw new Error('native terminal bounds must be finite')
  }
  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
    width: Math.max(0, Math.round(value.width)),
    height: Math.max(0, Math.round(value.height)),
  }
}

export function nativeTerminalOptions(
  value: NativeTerminalCreateOptions,
): NativeTerminalCreateOptions {
  const workingDirectory = value.workingDirectory?.trim()
  const command = value.command?.trim()
  const configuration = value.configuration
    ? nativeTerminalConfiguration(value.configuration)
    : undefined
  if (workingDirectory?.includes('\0') || command?.includes('\0')) {
    throw new Error('native terminal options cannot contain null bytes')
  }
  return {
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(command ? { command } : {}),
    ...(configuration ? { configuration } : {}),
    ...(value.bounds ? { bounds: nativeTerminalBounds(value.bounds) } : {}),
  }
}

export function nativeTerminalConfiguration(value: string): string {
  const configuration = value.trim()
  if (configuration.includes('\0')) {
    throw new Error('native terminal configuration cannot contain null bytes')
  }
  if (configuration.length > 32_768) {
    throw new Error('native terminal configuration is too large')
  }
  return configuration
}
