import { contextBridge, ipcRenderer } from 'electron'
import { desktopIpc } from '../shared/desktop.js'
import type {
  NativeViewBounds,
  NativeViewAction,
  NativeViewCreateOptions,
  NativeViewKeyInput,
  NativeViewState,
} from '../shared/native-views.js'
import { nativeViewIpc } from '../shared/native-views.js'
import type {
  NativeTerminalBounds,
  NativeTerminalCreateOptions,
  NativeTerminalKeyInput,
  NativeTerminalOverlay,
  NativeTerminalState,
} from '../shared/native-terminals.js'
import { nativeTerminalIpc } from '../shared/native-terminals.js'

contextBridge.exposeInMainWorld('__ALTO_DESKTOP__', {
  platform: process.platform,
  openFile: (path: string): Promise<void> => (
    ipcRenderer.invoke(desktopIpc.openFile, path) as Promise<void>
  ),
  onOpenSettings: (listener: () => void): (() => void) => {
    const receive = (): void => listener()
    ipcRenderer.on(desktopIpc.openSettings, receive)
    return () => ipcRenderer.off(desktopIpc.openSettings, receive)
  },
  nativeViews: {
    create: (options: NativeViewCreateOptions): Promise<NativeViewState> => (
      ipcRenderer.invoke(nativeViewIpc.create, options) as Promise<NativeViewState>
    ),
    navigate: (id: string, url: string): Promise<NativeViewState> => (
      ipcRenderer.invoke(nativeViewIpc.navigate, id, url) as Promise<NativeViewState>
    ),
    action: (id: string, action: NativeViewAction): Promise<void> => (
      ipcRenderer.invoke(nativeViewIpc.action, id, action) as Promise<void>
    ),
    setBounds: (id: string, bounds: NativeViewBounds): Promise<void> => (
      ipcRenderer.invoke(nativeViewIpc.bounds, id, bounds) as Promise<void>
    ),
    setVisible: (id: string, visible: boolean): Promise<void> => (
      ipcRenderer.invoke(nativeViewIpc.visible, id, visible) as Promise<void>
    ),
    focus: (id: string): Promise<void> => (
      ipcRenderer.invoke(nativeViewIpc.focus, id) as Promise<void>
    ),
    destroy: (id: string): Promise<void> => (
      ipcRenderer.invoke(nativeViewIpc.destroy, id) as Promise<void>
    ),
    focusHost: (): Promise<void> => (
      ipcRenderer.invoke(nativeViewIpc.focusHost) as Promise<void>
    ),
    onState: (listener: (state: NativeViewState) => void): (() => void) => {
      const receive = (_event: Electron.IpcRendererEvent, state: NativeViewState) => listener(state)
      ipcRenderer.on(nativeViewIpc.state, receive)
      return () => ipcRenderer.off(nativeViewIpc.state, receive)
    },
    onKeyInput: (listener: (input: NativeViewKeyInput) => void): (() => void) => {
      const receive = (_event: Electron.IpcRendererEvent, input: NativeViewKeyInput) => listener(input)
      ipcRenderer.on(nativeViewIpc.keyInput, receive)
      return () => ipcRenderer.off(nativeViewIpc.keyInput, receive)
    },
  },
  nativeTerminals: {
    create: (options: NativeTerminalCreateOptions): Promise<NativeTerminalState> => (
      ipcRenderer.invoke(nativeTerminalIpc.create, options) as Promise<NativeTerminalState>
    ),
    setBounds: (id: string, bounds: NativeTerminalBounds): Promise<void> => (
      ipcRenderer.invoke(nativeTerminalIpc.bounds, id, bounds) as Promise<void>
    ),
    setVisible: (id: string, visible: boolean): Promise<void> => (
      ipcRenderer.invoke(nativeTerminalIpc.visible, id, visible) as Promise<void>
    ),
    setOverlay: (id: string, overlay: NativeTerminalOverlay | null): Promise<void> => (
      ipcRenderer.invoke(nativeTerminalIpc.overlay, id, overlay) as Promise<void>
    ),
    focus: (id: string): Promise<void> => (
      ipcRenderer.invoke(nativeTerminalIpc.focus, id) as Promise<void>
    ),
    configure: (id: string, configuration: string): Promise<void> => (
      ipcRenderer.invoke(nativeTerminalIpc.configure, id, configuration) as Promise<void>
    ),
    destroy: (id: string): Promise<void> => (
      ipcRenderer.invoke(nativeTerminalIpc.destroy, id) as Promise<void>
    ),
    onKeyInput: (listener: (input: NativeTerminalKeyInput) => void): (() => void) => {
      const receive = (_event: Electron.IpcRendererEvent, input: NativeTerminalKeyInput) => listener(input)
      ipcRenderer.on(nativeTerminalIpc.keyInput, receive)
      return () => ipcRenderer.off(nativeTerminalIpc.keyInput, receive)
    },
  },
})
