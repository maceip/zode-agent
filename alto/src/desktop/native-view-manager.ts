import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow } from 'electron'
import { WebContentsView } from 'electron'
import type {
  NativeViewBounds,
  NativeViewAction,
  NativeViewCreateOptions,
  NativeViewKeyInput,
  NativeViewState,
} from '../shared/native-views.js'
import {
  isHostShortcut,
  isNativeViewModifierInput,
  nativeViewBounds,
  nativeViewIpc,
  nativeViewUrl,
} from '../shared/native-views.js'
import { localPdfPath } from './renderer-security.js'

interface NativeViewRecord {
  kind: 'browser' | 'pdf'
  sourceUrl: string
  view: WebContentsView
  state: NativeViewState
}

const BROWSER_PARTITION = 'persist:codex-cordis-browser'

export class NativeViewManager {
  private readonly views = new Map<string, NativeViewRecord>()

  constructor(private readonly window: BrowserWindow) {}

  async create(options: NativeViewCreateOptions): Promise<NativeViewState> {
    const target = await this.resolveTarget(options)
    const { kind, url } = target
    const id = randomUUID()
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        plugins: kind === 'pdf',
      },
    })
    view.setBackgroundColor('#ffffff')
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setVisible(false)

    const record: NativeViewRecord = {
      kind,
      sourceUrl: url,
      view,
      state: {
        id,
        url,
        title: '',
        loading: true,
        canGoBack: false,
        canGoForward: false,
      },
    }
    this.views.set(id, record)
    this.window.contentView.addChildView(view)
    const browserSession = view.webContents.session
    browserSession.setPermissionCheckHandler((_webContents, permission) => (
      permission === 'clipboard-sanitized-write'
    ))
    browserSession.setPermissionRequestHandler((_webContents, permission, respond) => {
      respond(permission === 'clipboard-sanitized-write')
    })
    const chromeUserAgent = browserSession.getUserAgent()
      .replace(/\sElectron\/[^\s]+/gu, '')
    view.webContents.setUserAgent(chromeUserAgent)
    this.attach(record)

    void view.webContents.loadURL(url).catch((error: unknown) => {
      if (!this.views.has(id)) return
      record.state = {
        ...record.state,
        loading: false,
        title: error instanceof Error ? error.message : String(error),
      }
      this.emit(record)
    })
    return record.state
  }

  navigate(id: string, value: string): NativeViewState {
    const record = this.get(id)
    if (record.kind !== 'browser') throw new Error('PDF views do not support navigation')
    const url = nativeViewUrl(value)
    record.state = { ...record.state, url, loading: true }
    this.emit(record)
    void record.view.webContents.loadURL(url).catch((error: unknown) => {
      if (!this.views.has(id)) return
      record.state = {
        ...record.state,
        loading: false,
        title: error instanceof Error ? error.message : String(error),
      }
      this.emit(record)
    })
    return record.state
  }

  action(id: string, action: NativeViewAction): void {
    const webContents = this.get(id).view.webContents
    if (action === 'back') {
      if (webContents.navigationHistory.canGoBack()) webContents.navigationHistory.goBack()
      return
    }
    if (action === 'forward') {
      if (webContents.navigationHistory.canGoForward()) webContents.navigationHistory.goForward()
      return
    }
    if (action === 'reload') webContents.reload()
  }

  setBounds(id: string, bounds: NativeViewBounds): void {
    this.get(id).view.setBounds(nativeViewBounds(bounds))
  }

  setVisible(id: string, visible: boolean): void {
    this.get(id).view.setVisible(Boolean(visible))
  }

  focus(id: string): void {
    this.get(id).view.webContents.focus()
  }

  destroy(id: string): void {
    const record = this.views.get(id)
    if (!record) return
    this.views.delete(id)
    this.window.contentView.removeChildView(record.view)
    record.view.webContents.close()
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id)
  }

  private get(id: string): NativeViewRecord {
    const record = this.views.get(id)
    if (!record) throw new Error(`unknown native browser view: ${id}`)
    return record
  }

  private async resolveTarget(options: NativeViewCreateOptions): Promise<{
    kind: 'browser' | 'pdf'
    url: string
  }> {
    if (options.kind !== 'pdf') {
      return { kind: 'browser', url: nativeViewUrl(options.url) }
    }

    const candidate = localPdfPath(options.path)
    if (!candidate) throw new Error('native PDF views require an absolute .pdf path')
    const resolved = await realpath(candidate)
    const metadata = await stat(resolved)
    if (!metadata.isFile()) throw new Error('native PDF views require a file')
    return { kind: 'pdf', url: pathToFileURL(resolved).href }
  }

  private attach(record: NativeViewRecord): void {
    const { webContents } = record.view
    const refresh = (): void => {
      if (!this.views.has(record.state.id)) return
      record.state = {
        ...record.state,
        url: webContents.getURL() || record.state.url,
        title: webContents.getTitle(),
        loading: webContents.isLoading(),
        canGoBack: webContents.navigationHistory.canGoBack(),
        canGoForward: webContents.navigationHistory.canGoForward(),
      }
      this.emit(record)
    }

    webContents.on('did-start-loading', refresh)
    webContents.on('did-stop-loading', refresh)
    webContents.on('did-navigate', refresh)
    webContents.on('did-navigate-in-page', refresh)
    webContents.on('page-title-updated', refresh)
    webContents.on('before-input-event', (event, input) => {
      const type = input.type === 'keyDown'
        ? 'keydown'
        : input.type === 'keyUp'
          ? 'keyup'
          : undefined
      if (!type) return
      const forwarded: NativeViewKeyInput = {
        type,
        key: input.key,
        code: input.code,
        ctrlKey: input.control,
        metaKey: input.meta,
        altKey: input.alt,
        shiftKey: input.shift,
        repeat: input.isAutoRepeat,
      }
      if (!isNativeViewModifierInput(forwarded)) return

      if (isHostShortcut(forwarded)) {
        event.preventDefault()
        this.window.webContents.focus()
      }
      if (!this.window.isDestroyed()) {
        this.window.webContents.send(nativeViewIpc.keyInput, forwarded)
      }
    })
    webContents.on('will-navigate', (event) => {
      try {
        if (record.kind === 'browser') {
          nativeViewUrl(event.url)
        } else {
          const requested = new URL(event.url)
          const source = new URL(record.sourceUrl)
          requested.hash = ''
          source.hash = ''
          if (requested.href !== source.href) throw new Error('PDF navigation left the source file')
        }
      } catch {
        event.preventDefault()
      }
    })
    webContents.setWindowOpenHandler(({ url }) => {
      if (record.kind !== 'browser') return { action: 'deny' }
      try {
        this.navigate(record.state.id, url)
      } catch {
        // The URL validator deliberately rejects non-web schemes.
      }
      return { action: 'deny' }
    })
  }

  private emit(record: NativeViewRecord): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(nativeViewIpc.state, record.state)
    }
  }
}
