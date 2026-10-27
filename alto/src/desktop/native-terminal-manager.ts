import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
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
  nativeTerminalIpc,
  nativeTerminalOptions,
  nativeTerminalOverlay,
} from '../shared/native-terminals.js'

interface GhosttyNativeAddon {
  initialize(
    hostView: Buffer,
    resourcesDirectory: string,
    onKeyInput: (input: NativeTerminalKeyInput) => void,
  ): void
  create(id: string, options: NativeTerminalCreateOptions): void
  setBounds(id: string, bounds: NativeTerminalBounds): void
  setOverlay?(id: string, overlay: NativeTerminalOverlay | null): void
  setVisible(id: string, visible: boolean): void
  focus(id: string): void
  configure?(id: string, configuration: string): void
  destroy(id: string): void
  destroyAll(): void
}

const require = createRequire(import.meta.url)

export function nativeTerminalInputClaimsHost(input: NativeTerminalKeyInput): boolean {
  return input.type === 'keydown'
}

export class NativeTerminalManager {
  private addon?: GhosttyNativeAddon
  private loadError?: string

  constructor(
    private readonly window: BrowserWindow,
    private readonly projectRoot: string,
  ) {}

  create(options: NativeTerminalCreateOptions): NativeTerminalState {
    const addon = this.loadAddon()
    const id = randomUUID()
    addon.create(id, nativeTerminalOptions(options))
    return { id, backend: 'ghostty', supportsOverlay: Boolean(addon.setOverlay) }
  }

  setBounds(id: string, bounds: NativeTerminalBounds): void {
    this.loadAddon().setBounds(id, nativeTerminalBounds(bounds))
  }

  setVisible(id: string, visible: boolean): void {
    this.loadAddon().setVisible(id, Boolean(visible))
  }

  setOverlay(id: string, overlay: NativeTerminalOverlay | null): void {
    this.loadAddon().setOverlay?.(id, nativeTerminalOverlay(overlay))
  }

  focus(id: string): void {
    this.loadAddon().focus(id)
  }

  configure(id: string, configuration: string): void {
    this.loadAddon().configure?.(id, nativeTerminalConfiguration(configuration))
  }

  destroy(id: string): void {
    this.addon?.destroy(id)
  }

  destroyAll(): void {
    this.addon?.destroyAll()
  }

  private loadAddon(): GhosttyNativeAddon {
    if (this.addon) return this.addon
    if (this.loadError) throw new Error(this.loadError)

    const addonPath = process.env.ALTO_GHOSTTY_ADDON
      ?? path.join(this.projectRoot, 'native', 'ghostty', 'build', 'ghostty-terminal.node')
    if (!existsSync(addonPath)) {
      this.loadError = 'Ghostty native support is not built. Run npm run build:ghostty.'
      throw new Error(this.loadError)
    }

    try {
      const addon = require(addonPath) as GhosttyNativeAddon
      addon.initialize(
        this.window.getNativeWindowHandle(),
        path.join(this.projectRoot, 'native', 'ghostty', 'vendor', 'share', 'ghostty'),
        (input) => {
          if (this.window.isDestroyed()) return
          // A shortcut can move first responder from the web UI into Ghostty
          // between its key-down and key-up. The trailing key-up still arrives
          // here, but it must not steal focus back from the destination pane.
          if (nativeTerminalInputClaimsHost(input)) this.window.webContents.focus()
          this.window.webContents.send(nativeTerminalIpc.keyInput, input)
        },
      )
      this.addon = addon
      return addon
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.loadError = `Ghostty native support failed to load: ${message}`
      throw new Error(this.loadError, { cause: error })
    }
  }
}
