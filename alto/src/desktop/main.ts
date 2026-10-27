import { stat } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain, Menu, shell } from 'electron'
import { desktopIpc } from '../shared/desktop.js'
import type {
  NativeViewBounds,
  NativeViewAction,
  NativeViewCreateOptions,
} from '../shared/native-views.js'
import { nativeViewIpc } from '../shared/native-views.js'
import type {
  NativeTerminalBounds,
  NativeTerminalCreateOptions,
  NativeTerminalOverlay,
} from '../shared/native-terminals.js'
import { nativeTerminalIpc } from '../shared/native-terminals.js'
import { startHarness, type HarnessApp } from '../server/app.js'
import { ownedDesktopHarnessOptions } from './harness-security.js'
import { NativeViewManager } from './native-view-manager.js'
import { NativeTerminalManager } from './native-terminal-manager.js'
import { macApplicationMenuTemplate } from './application-menu.js'
import { hydrateDesktopEnvironment } from './process-environment.js'
import { desktopRuntimeRoot } from './runtime-root.js'
import {
  desktopContextCopyTarget,
  externalBrowserUrl,
  externalFilePath,
  localFilePath,
  trustedRendererUrl,
} from './renderer-security.js'

hydrateDesktopEnvironment()

const development = process.argv.includes('--development')
const projectRoot = process.env.ALTO_ROOT
  ?? await desktopRuntimeRoot(app.getAppPath(), app.getPath('userData'))

console.log(`Starting Alto Desktop from ${projectRoot}`)

let window: BrowserWindow | undefined
let manager: NativeViewManager | undefined
let terminalManager: NativeTerminalManager | undefined
let harness: HarnessApp | undefined
let closingHarness = false
let quitting = false
let windowCreation: Promise<void> | undefined
let appOrigin: string | undefined

async function openLocalFile(value: string): Promise<void> {
  const filePath = localFilePath(value)
  if (!filePath) throw new Error('local links must use an absolute path')
  const metadata = await stat(filePath)
  if (!metadata.isFile()) throw new Error('local links must point to a file')
  if ((metadata.mode & 0o111) !== 0) throw new Error('refusing to launch an executable file')
  const problem = await shell.openPath(filePath)
  if (problem) throw new Error(problem)
}

function openExternalTarget(value: string): void {
  const url = externalBrowserUrl(value)
  const filePath = externalFilePath(value)
  const opening = url ? shell.openExternal(url) : filePath ? openLocalFile(filePath) : undefined
  if (!opening) return
  void opening.catch((error: unknown) => {
    console.error(`Could not open external target ${url ?? filePath}`, error)
  })
}

async function ensureHarness(): Promise<HarnessApp> {
  if (harness) return harness
  harness = await startHarness(ownedDesktopHarnessOptions(projectRoot, development))
  appOrigin = harness.origin
  return harness
}

function assertRenderer(event: Electron.IpcMainInvokeEvent): NativeViewManager {
  if (
    !window
    || event.sender !== window.webContents
    || !appOrigin
    || !trustedRendererUrl(event.senderFrame?.url ?? '', appOrigin)
    || !manager
  ) {
    throw new Error('native browser view request came from an untrusted renderer')
  }
  return manager
}

function registerNativeViewIpc(): void {
  ipcMain.handle(nativeViewIpc.create, (event, options: NativeViewCreateOptions) => (
    assertRenderer(event).create(options)
  ))
  ipcMain.handle(nativeViewIpc.navigate, (event, id: string, url: string) => (
    assertRenderer(event).navigate(id, url)
  ))
  ipcMain.handle(nativeViewIpc.action, (event, id: string, action: NativeViewAction) => {
    assertRenderer(event).action(id, action)
  })
  ipcMain.handle(nativeViewIpc.bounds, (event, id: string, bounds: NativeViewBounds) => {
    assertRenderer(event).setBounds(id, bounds)
  })
  ipcMain.handle(nativeViewIpc.visible, (event, id: string, visible: boolean) => {
    assertRenderer(event).setVisible(id, visible)
  })
  ipcMain.handle(nativeViewIpc.focus, (event, id: string) => {
    assertRenderer(event).focus(id)
  })
  ipcMain.handle(nativeViewIpc.destroy, (event, id: string) => {
    assertRenderer(event).destroy(id)
  })
  ipcMain.handle(nativeViewIpc.focusHost, (event) => {
    assertRenderer(event)
    window?.webContents.focus()
  })
}

function registerDesktopIpc(): void {
  ipcMain.handle(desktopIpc.openFile, (event, filePath: string) => {
    assertRenderer(event)
    return openLocalFile(filePath)
  })
}

function assertTerminalRenderer(event: Electron.IpcMainInvokeEvent): NativeTerminalManager {
  if (
    !window
    || event.sender !== window.webContents
    || !appOrigin
    || !trustedRendererUrl(event.senderFrame?.url ?? '', appOrigin)
    || !terminalManager
  ) {
    throw new Error('native terminal request came from an untrusted renderer')
  }
  return terminalManager
}

function registerNativeTerminalIpc(): void {
  ipcMain.handle(nativeTerminalIpc.create, (event, options: NativeTerminalCreateOptions) => (
    assertTerminalRenderer(event).create(options)
  ))
  ipcMain.handle(nativeTerminalIpc.bounds, (event, id: string, bounds: NativeTerminalBounds) => {
    assertTerminalRenderer(event).setBounds(id, bounds)
  })
  ipcMain.handle(nativeTerminalIpc.visible, (event, id: string, visible: boolean) => {
    assertTerminalRenderer(event).setVisible(id, visible)
  })
  ipcMain.handle(nativeTerminalIpc.overlay, (event, id: string, overlay: NativeTerminalOverlay | null) => {
    assertTerminalRenderer(event).setOverlay(id, overlay)
  })
  ipcMain.handle(nativeTerminalIpc.focus, (event, id: string) => {
    assertTerminalRenderer(event).focus(id)
  })
  ipcMain.handle(nativeTerminalIpc.configure, (event, id: string, configuration: string) => {
    assertTerminalRenderer(event).configure(id, configuration)
  })
  ipcMain.handle(nativeTerminalIpc.destroy, (event, id: string) => {
    assertTerminalRenderer(event).destroy(id)
  })
}

async function createWindow(): Promise<void> {
  const ownedHarness = await ensureHarness()
  console.log(`Loading Alto Desktop from ${ownedHarness.origin}`)
  const preload = path.join(projectRoot, 'dist', 'desktop', 'preload.cjs')
  window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    title: 'Alto',
    ...(process.platform === 'darwin' ? {
      backgroundColor: '#00000000',
      transparent: true,
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 12, y: 14 },
      vibrancy: 'under-window' as const,
      visualEffectState: 'active' as const,
    } : {
      backgroundColor: '#f5f5f7',
    }),
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.platform === 'darwin') {
    let materialTimer: ReturnType<typeof setTimeout> | undefined
    const applyWindowMaterial = () => {
      const target = window
      if (!target || target.isDestroyed()) return
      target.setBackgroundColor('#00000000')
      target.setVibrancy('under-window')
    }
    const refreshWindowMaterial = () => {
      if (materialTimer !== undefined) clearTimeout(materialTimer)
      // AppKit can replace the transparent backing surface while a window is
      // moved or resized. Wait until that transaction finishes before
      // restoring the material sampled by the sidebar's backdrop filter.
      materialTimer = setTimeout(() => {
        materialTimer = undefined
        applyWindowMaterial()
      }, 0)
    }
    applyWindowMaterial()
    window.webContents.on('did-finish-load', refreshWindowMaterial)
    window.on('moved', refreshWindowMaterial)
    window.on('resized', refreshWindowMaterial)
    window.on('show', refreshWindowMaterial)
    window.on('focus', refreshWindowMaterial)
    window.on('restore', refreshWindowMaterial)
    window.on('enter-full-screen', refreshWindowMaterial)
    window.on('leave-full-screen', refreshWindowMaterial)
  }
  manager = new NativeViewManager(window)
  terminalManager = new NativeTerminalManager(window, projectRoot)
  window.webContents.on('will-navigate', (event, url) => {
    if (trustedRendererUrl(url, ownedHarness.origin)) return
    event.preventDefault()
    openExternalTarget(url)
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!trustedRendererUrl(url, ownedHarness.origin)) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalTarget(url)
    return { action: 'deny' }
  })
  window.webContents.on('context-menu', (_event, params) => {
    const copyTarget = desktopContextCopyTarget(params.linkURL, params.titleText)
    if (!copyTarget) return
    const target = window
    if (!target || target.isDestroyed()) return
    Menu.buildFromTemplate([{
      label: copyTarget.label,
      click: () => clipboard.writeText(copyTarget.value),
    }]).popup({ window: target })
  })
  window.on('close', (event) => {
    if (process.platform !== 'darwin' || quitting) return

    // A normal macOS close hides the workspace instead of tearing down its
    // renderer and native panes. Activating the Dock icon reveals this exact
    // window again, including live chats, drafts, browser views, and terminals.
    event.preventDefault()
    window?.hide()
  })
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) {
      manager?.destroyAll()
      terminalManager?.destroyAll()
    }
  })
  window.on('closed', () => {
    manager?.destroyAll()
    terminalManager?.destroyAll()
    manager = undefined
    terminalManager = undefined
    window = undefined
  })
  await window.loadURL(ownedHarness.url)
  console.log('Alto Desktop is ready')
}

async function showOrCreateWindow(): Promise<void> {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return
  }

  windowCreation ??= createWindow().finally(() => {
    windowCreation = undefined
  })
  await windowCreation
}

function openSettingsFromMenu(): void {
  void showOrCreateWindow().then(() => {
    const target = window
    if (!target || target.isDestroyed()) return
    target.webContents.send(desktopIpc.openSettings)
  }).catch((error: unknown) => {
    console.error('Could not open Settings from the application menu', error)
  })
}

function installApplicationMenu(): void {
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(Menu.buildFromTemplate(
    macApplicationMenuTemplate(app.getName(), openSettingsFromMenu),
  ))
}

app.setName('Alto')
registerDesktopIpc()
registerNativeViewIpc()
registerNativeTerminalIpc()

// Install the listener during ESM evaluation. On macOS, waiting on app.whenReady()
// can miss Electron's ready transition before the first window is created.
app.once('ready', () => {
  installApplicationMenu()
  void showOrCreateWindow().catch((error: unknown) => {
    console.error(error)
    app.quit()
  })
})

app.on('activate', () => {
  void showOrCreateWindow().catch((error: unknown) => {
    console.error(error)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  quitting = true
  manager?.destroyAll()
  terminalManager?.destroyAll()
  if (!harness || closingHarness) return
  event.preventDefault()
  closingHarness = true
  const ownedHarness = harness
  harness = undefined
  void ownedHarness.close().finally(() => app.quit())
})
