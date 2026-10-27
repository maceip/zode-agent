import type {
  NativeTerminalBounds,
  NativeTerminalCreateOptions,
  NativeTerminalKeyInput,
  NativeTerminalOverlay,
  NativeTerminalState,
} from '../shared/native-terminals.js'
import {
  nativeTerminalBounds,
  nativeTerminalConfiguration,
  nativeTerminalOptions,
  nativeTerminalOverlay,
} from '../shared/native-terminals.js'

export interface NativeTerminalBridge {
  create(options: NativeTerminalCreateOptions): Promise<NativeTerminalState>
  setBounds(id: string, bounds: NativeTerminalBounds): Promise<void>
  setVisible(id: string, visible: boolean): Promise<void>
  setOverlay?(id: string, overlay: NativeTerminalOverlay | null): Promise<void>
  focus(id: string): Promise<void>
  configure(id: string, configuration: string): Promise<void>
  destroy(id: string): Promise<void>
  onKeyInput?(listener: (input: NativeTerminalKeyInput) => void): () => void
}

export interface ClientNativeTerminal {
  readonly id: string
  readonly backend: 'ghostty'
  readonly supportsOverlay?: boolean
  setOverlay?(overlay: NativeTerminalOverlay | null): void
  setBounds(bounds: NativeTerminalBounds): void
  setVisible(visible: boolean): void
  focus(): void
  configure(configuration: string): void
  destroy(): Promise<void>
}

export interface ClientNativeTerminalsService {
  available(): boolean
  create(options?: NativeTerminalCreateOptions): Promise<ClientNativeTerminal>
}

class DesktopNativeTerminal implements ClientNativeTerminal {
  readonly id: string
  readonly backend = 'ghostty' as const
  readonly supportsOverlay: boolean
  private overlayKey = 'null'

  private bounds?: NativeTerminalBounds
  private visible = false
  private configuration?: string
  private destroyed = false

  constructor(
    private readonly bridge: NativeTerminalBridge,
    state: NativeTerminalState,
    bounds?: NativeTerminalBounds,
    configuration?: string,
  ) {
    this.id = state.id
    this.supportsOverlay = Boolean(state.supportsOverlay && bridge.setOverlay)
    if (bounds) this.bounds = bounds
    if (configuration) this.configuration = configuration
  }

  setBounds(bounds: NativeTerminalBounds): void {
    const normalized = nativeTerminalBounds(bounds)
    if (this.destroyed || sameBounds(normalized, this.bounds)) return
    this.bounds = normalized
    void this.bridge.setBounds(this.id, normalized).catch(() => undefined)
  }

  setVisible(visible: boolean): void {
    if (this.destroyed || this.visible === visible) return
    this.visible = visible
    void this.bridge.setVisible(this.id, visible).catch(() => undefined)
  }

  setOverlay(overlay: NativeTerminalOverlay | null): void {
    if (this.destroyed || !this.supportsOverlay) return
    const normalized = nativeTerminalOverlay(overlay)
    const key = JSON.stringify(normalized)
    if (key === this.overlayKey) return
    this.overlayKey = key
    void this.bridge.setOverlay?.(this.id, normalized).catch(() => undefined)
  }

  focus(): void {
    if (this.destroyed) return
    void this.bridge.focus(this.id).catch(() => undefined)
  }

  configure(configuration: string): void {
    const normalized = nativeTerminalConfiguration(configuration)
    if (this.destroyed || normalized === this.configuration) return
    this.configuration = normalized
    void this.bridge.configure(this.id, normalized).catch(() => undefined)
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    await this.bridge.destroy(this.id).catch(() => undefined)
  }
}

function sameBounds(
  left: NativeTerminalBounds,
  right: NativeTerminalBounds | undefined,
): boolean {
  return Boolean(right)
    && left.x === right?.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
}

export class ClientNativeTerminals implements ClientNativeTerminalsService {
  available(): boolean {
    return typeof window !== 'undefined'
      && Boolean(window.__ALTO_DESKTOP__?.nativeTerminals)
  }

  async create(options: NativeTerminalCreateOptions = {}): Promise<ClientNativeTerminal> {
    const bridge = typeof window === 'undefined'
      ? undefined
      : window.__ALTO_DESKTOP__?.nativeTerminals
    if (!bridge) throw new Error('Ghostty terminals require the Alto desktop app')
    const normalized = nativeTerminalOptions(options)
    const state = await bridge.create(normalized)
    return new DesktopNativeTerminal(bridge, state, normalized.bounds, normalized.configuration)
  }
}

export const clientNativeTerminals: ClientNativeTerminalsService = new ClientNativeTerminals()
