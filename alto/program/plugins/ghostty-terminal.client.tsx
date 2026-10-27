import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { Plugin } from 'cordis'
import type {
  ClientNativeTerminalsService,
  ClientUiService,
} from '../../src/client/plugin-api.js'
import { clientStyles } from '../../src/client/plugin-api.js'
import { TerminalLaunchers } from './terminal-launchers.js'
import type { ClientNativeTerminal } from '../../src/client/native-terminals.js'
import type { NativeTerminalBounds, NativeTerminalOverlay } from '../../src/shared/native-terminals.js'
import type {
  ClientGhosttyTerminalService,
  GhosttyTerminalProps,
  TerminalLaunchRequest,
} from './ghostty-terminal-api.js'
import { useThemeAppearance } from './theme-runtime.js'
import styles from './ghostty-terminal.css'
import { isRecord } from '../../src/shared/protocol.js'
import { TERMINAL_DEFAULT_DIRECTORY, type GhosttyTerminalConfig } from './ghostty-terminal-api.js'

const SHARED_CONFIGURATION = `
font-family = Monaspace Neon
font-size = 12.5
window-padding-x = 8
window-padding-y = 8
cursor-style = block
cursor-style-blink = false
background-opacity = 1
`.trim()

export function defaultGhosttyConfiguration(mode: 'light' | 'dark', accent = '#7c3aed'): string {
  const palette = mode === 'dark'
    ? `
background = #1d2027
foreground = #c8ccd8
cursor-color = #b9becd
cursor-text = #1d2027
selection-background = #3b3f4d
selection-foreground = #eceef4
palette = 0=#1a1c22
palette = 1=#df7b85
palette = 2=#74b995
palette = 3=#c7a261
palette = 4=#76a7ff
palette = 5=${accent}
palette = 6=#68b7c5
palette = 7=#c8ccd8
palette = 8=#747b8d
palette = 9=#ef929d
palette = 10=#86cba5
palette = 11=#d8b472
palette = 12=#91b8ff
palette = 13=#b89aff
palette = 14=#83c8d3
palette = 15=#eceef4
`.trim()
    : `
background = #f2f3f6
foreground = #51566d
cursor-color = #565b74
cursor-text = #f2f3f6
selection-background = #d9dcf0
selection-foreground = #34384c
palette = 0=#202331
palette = 1=#ee3f4f
palette = 2=#16a36a
palette = 3=#d99616
palette = 4=#3478f6
palette = 5=${accent}
palette = 6=#1499a9
palette = 7=#c9ccd7
palette = 8=#7c8198
palette = 9=#f05a68
palette = 10=#20b978
palette = 11=#e9aa2d
palette = 12=#5b8ff8
palette = 13=#9a63ff
palette = 14=#25aeba
palette = 15=#ffffff
`.trim()
  return `${palette}\n${SHARED_CONFIGURATION}`
}

function terminalBounds(mount: HTMLElement): NativeTerminalBounds {
  const rect = mount.getBoundingClientRect()
  const left = Math.max(0, rect.left)
  const top = Math.max(0, rect.top)
  const right = Math.min(window.innerWidth, rect.right)
  const bottom = Math.min(window.innerHeight, rect.bottom)
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

function terminalOverlayBounds(element: HTMLElement): NativeTerminalOverlay | null {
  const bounds = terminalBounds(element)
  if (bounds.width <= 1 || bounds.height <= 1) return null
  const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0
  return { ...bounds, borderRadius: radius }
}

function GhosttySurface({
  nativeTerminals,
  ui,
  workingDirectory,
  command,
  identity,
  prepare,
  configuration,
  active = true,
  focused = false,
}: GhosttyTerminalProps & {
  nativeTerminals: ClientNativeTerminalsService
  ui: ClientUiService
  prepare(request: TerminalLaunchRequest): Promise<{ command?: string; workingDirectory: string }>
}): ReactNode {
  const theme = useThemeAppearance()
  const resolvedConfiguration = configuration
    ?? defaultGhosttyConfiguration(theme.mode, theme.accent)
  const mountRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<ClientNativeTerminal | undefined>(undefined)
  const configurationRef = useRef(resolvedConfiguration)
  const syncRef = useRef<() => void>(() => undefined)
  const activeRef = useRef(active)
  const focusedRef = useRef(focused)
  const focusRequested = useRef(false)
  const nativeViewsOccluded = useSyncExternalStore(
    ui.overlays.subscribe,
    ui.overlays.nativeViewsOccluded,
  )
  const overlayId = useSyncExternalStore(ui.overlays.subscribe, ui.overlays.snapshot)
  const nativeViewsOccludedRef = useRef(nativeViewsOccluded)
  const overlayIdRef = useRef(overlayId)
  const [problem, setProblem] = useState<string>()
  const [attempt, setAttempt] = useState(0)

  activeRef.current = active
  focusedRef.current = focused
  nativeViewsOccludedRef.current = nativeViewsOccluded
  overlayIdRef.current = overlayId
  configurationRef.current = resolvedConfiguration

  useEffect(() => {
    setProblem(undefined)
    let live = true
    let frame: number | undefined
    let creating = false
    let failed = false
    let overlayElement: HTMLElement | undefined
    const overlayObserver = new ResizeObserver(() => sync())

    const sync = (): void => {
      if (frame !== undefined) return
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        const mount = mountRef.current
        if (!mount) return

        const terminal = terminalRef.current
        if (!activeRef.current) {
          terminal?.setVisible(false)
          return
        }
        const bounds = terminalBounds(mount)
        const drawable = bounds.width > 1 && bounds.height > 1
        if (!terminal && !creating && !failed && activeRef.current && drawable) {
          creating = true
          void (async () => {
            const launch = await prepare({
              ...(identity ? { identity } : {}),
              ...(workingDirectory ? { workingDirectory } : {}),
              ...(command ? { command } : {}),
            })
            if (!live) return undefined
            return nativeTerminals.create({
              ...(workingDirectory ? { workingDirectory } : {}),
              ...launch,
              configuration: configurationRef.current,
              bounds,
            })
          })().then((created) => {
            creating = false
            if (!created) return
            if (!live) {
              void created.destroy()
              return
            }
            terminalRef.current = created
            created.configure(configurationRef.current)
            focusRequested.current = activeRef.current && focusedRef.current && !nativeViewsOccludedRef.current
            sync()
          }).catch((error: unknown) => {
            creating = false
            failed = true
            if (live) setProblem(error instanceof Error ? error.message : String(error))
          })
          return
        }
        if (!terminal) return

        const element = nativeViewsOccludedRef.current && terminal.supportsOverlay
          ? [...document.querySelectorAll<HTMLElement>('[data-native-overlay]')]
            .find((candidate) => candidate.dataset.nativeOverlay === overlayIdRef.current)
          : undefined
        if (element !== overlayElement) {
          overlayObserver.disconnect()
          overlayElement = element
          if (element) overlayObserver.observe(element)
        }
        const overlay = element ? terminalOverlayBounds(element) : null
        terminal.setBounds(bounds)
        terminal.setOverlay?.(overlay)
        terminal.setVisible(
          activeRef.current
          && (!nativeViewsOccludedRef.current || overlay !== null)
          && drawable
          && document.visibilityState === 'visible',
        )
        if (focusRequested.current && activeRef.current && focusedRef.current && !nativeViewsOccludedRef.current) {
          focusRequested.current = false
          terminal.focus()
        }
      })
    }
    syncRef.current = sync

    sync()

    return () => {
      live = false
      if (syncRef.current === sync) syncRef.current = () => undefined
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      overlayObserver.disconnect()
      const terminal = terminalRef.current
      terminalRef.current = undefined
      terminal?.setVisible(false)
      void terminal?.destroy()
    }
  }, [command, nativeTerminals, workingDirectory, prepare, identity?.workspaceId, identity?.paneId, identity?.tabId, attempt])

  useEffect(() => {
    if (!active) {
      terminalRef.current?.setVisible(false)
      return
    }
    const sync = (): void => syncRef.current()
    const observer = new ResizeObserver(sync)
    if (mountRef.current) observer.observe(mountRef.current)
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [active])

  useEffect(() => {
    terminalRef.current?.configure(resolvedConfiguration)
  }, [resolvedConfiguration])

  useEffect(() => {
    syncRef.current()
  }, [active, nativeViewsOccluded, overlayId])

  useEffect(() => {
    focusRequested.current = active && focused && !nativeViewsOccluded
    syncRef.current()
  }, [active, focused, nativeViewsOccluded])

  return (
    <div className="ghostty-terminal-surface" data-native-pane-surface="" ref={mountRef}>
      {problem ? (
        <div className="ghostty-terminal-problem">
          <strong>Ghostty terminal unavailable</strong>
          <span>{problem}</span>
          <button className={clientStyles.button} onClick={() => setAttempt((current) => current + 1)}>Retry</button>
        </div>
      ) : null}
    </div>
  )
}

const ghosttyTerminal: Plugin<GhosttyTerminalConfig> = (ctx, config) => {
  const launchers = new TerminalLaunchers()
  const prepare = async (request: TerminalLaunchRequest) => {
    let workingDirectory = request.workingDirectory
    if (!workingDirectory) {
      const defaults = await ctx.clientHost.call(TERMINAL_DEFAULT_DIRECTORY)
      if (!isRecord(defaults) || typeof defaults.workingDirectory !== 'string' || !defaults.workingDirectory) {
        throw new Error('The default terminal directory is unavailable.')
      }
      workingDirectory = defaults.workingDirectory
    }
    const launch = await launchers.prepare({ ...request, workingDirectory })
    return { ...launch, workingDirectory }
  }
  const Renderer = (props: GhosttyTerminalProps): ReactNode => {
    const command = props.command ?? config.command
    const configuration = props.configuration ?? config.configuration
    return (
      <GhosttySurface
        {...props}
        {...(command ? { command } : {})}
        {...(configuration ? { configuration } : {})}
        nativeTerminals={ctx.clientNativeTerminals}
        ui={ctx.clientUi}
        prepare={prepare}
      />
    )
  }
  const service: ClientGhosttyTerminalService = {
    renderer: Renderer,
    registerLauncher: (owner, launcher) => launchers.register(owner, launcher),
    close: (identity) => launchers.close(identity),
  }
  ctx.provide('clientGhosttyTerminal', service)
  ctx.clientUi.registerStyle(ctx, 'ghostty-terminal', String(styles))
}

ghosttyTerminal.inject = ['clientHost', 'clientNativeTerminals', 'clientUi']
ghosttyTerminal.provide = 'clientGhosttyTerminal'

export default ghosttyTerminal
