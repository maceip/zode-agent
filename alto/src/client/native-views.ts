import type {
  NativeViewBounds,
  NativeViewAction,
  NativeViewCreateOptions,
  NativeViewKeyInput,
  NativeViewState,
} from '../shared/native-views.js'
import type { NativeTerminalBridge } from './native-terminals.js'
export interface NativeViewBridge {
  create(options: NativeViewCreateOptions): Promise<NativeViewState>
  navigate(id: string, url: string): Promise<NativeViewState>
  action(id: string, action: NativeViewAction): Promise<void>
  setBounds(id: string, bounds: NativeViewBounds): Promise<void>
  setVisible(id: string, visible: boolean): Promise<void>
  focus(id: string): Promise<void>
  destroy(id: string): Promise<void>
  focusHost(): Promise<void>
  onState(listener: (state: NativeViewState) => void): () => void
  onKeyInput?(listener: (input: NativeViewKeyInput) => void): () => void
}

declare global {
  interface Window {
    __ALTO_DESKTOP__?: {
      platform: string
      openFile?(path: string): Promise<void>
      onOpenSettings?(listener: () => void): () => void
      nativeViews: NativeViewBridge
      nativeTerminals?: NativeTerminalBridge
    }
  }
}

export interface ClientNativeView {
  readonly id: string
  subscribe(listener: () => void): () => void
  snapshot(): NativeViewState
  navigate(url: string): Promise<void>
  perform(action: NativeViewAction): Promise<void>
  setBounds(bounds: NativeViewBounds): void
  setVisible(visible: boolean): void
  focus(): void
  destroy(): Promise<void>
}

export interface ClientNativeViewsService {
  available(): boolean
  create(options: NativeViewCreateOptions): Promise<ClientNativeView>
}

class DesktopNativeView implements ClientNativeView {
  readonly id: string

  private readonly listeners = new Set<() => void>()
  private readonly removeStateListener: () => void
  private state: NativeViewState
  private bounds?: NativeViewBounds
  private visible = false
  private destroyed = false

  constructor(
    private readonly bridge: NativeViewBridge,
    initial: NativeViewState,
  ) {
    this.id = initial.id
    this.state = initial
    this.removeStateListener = bridge.onState((state) => {
      if (state.id !== this.id || this.destroyed) return
      this.state = state
      for (const listener of this.listeners) listener()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): NativeViewState => this.state

  async navigate(url: string): Promise<void> {
    this.assertLive()
    this.state = await this.bridge.navigate(this.id, url)
    for (const listener of this.listeners) listener()
  }

  async perform(action: NativeViewAction): Promise<void> {
    this.assertLive()
    await this.bridge.action(this.id, action)
  }

  setBounds(bounds: NativeViewBounds): void {
    if (this.destroyed || sameBounds(bounds, this.bounds)) return
    this.bounds = bounds
    void this.bridge.setBounds(this.id, bounds).catch(() => undefined)
  }

  setVisible(visible: boolean): void {
    if (this.destroyed || this.visible === visible) return
    this.visible = visible
    void this.bridge.setVisible(this.id, visible).catch(() => undefined)
  }

  focus(): void {
    if (this.destroyed) return
    void this.bridge.focus(this.id).catch(() => undefined)
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    this.removeStateListener()
    this.listeners.clear()
    await this.bridge.destroy(this.id).catch(() => undefined)
  }

  private assertLive(): void {
    if (this.destroyed) throw new Error('native browser view has been destroyed')
  }

}

function sameBounds(left: NativeViewBounds, right: NativeViewBounds | undefined): boolean {
  return Boolean(right)
    && left.x === right?.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
}

export class ClientNativeViews implements ClientNativeViewsService {
  available(): boolean {
    return typeof window !== 'undefined'
      && Boolean(window.__ALTO_DESKTOP__?.nativeViews)
  }

  async create(options: NativeViewCreateOptions): Promise<ClientNativeView> {
    const bridge = typeof window === 'undefined'
      ? undefined
      : window.__ALTO_DESKTOP__?.nativeViews
    if (!bridge) throw new Error('native browser views require the Alto desktop app')
    return new DesktopNativeView(
      bridge,
      await bridge.create(options),
    )
  }
}

export const clientNativeViews: ClientNativeViewsService = new ClientNativeViews()
