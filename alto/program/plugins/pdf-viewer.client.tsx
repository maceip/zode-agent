import { paneToolbarStyles } from './pane-toolbar.js'
import {
  ExternalLink,
  FileText,
  RefreshCw,
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  clientStyles,
  type BrowserPlugin,
  type ClientHostService,
  type ClientUiService,
} from '../../src/client/plugin-api.js'
import type {
  ClientNativeView,
  ClientNativeViewsService,
} from '../../src/client/native-views.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import type { ClientMarkdownService } from './markdown-api.js'
import {
  PDF_VIEWER_INSPECT_METHOD,
  type PdfDocument,
} from './pdf-viewer-api.js'
import type {
  ClientWorkspaceLayoutService,
  WorkspacePaneKindProps,
} from './workspace-layout-api.js'
import { useViewerActivated } from './viewer-activation.js'
import styles from './pdf-viewer.css'

type DocumentState =
  | { tag: 'idle' | 'loading' }
  | { tag: 'ready'; document: PdfDocument }
  | { tag: 'failed'; problem: string }

function parsedDocument(value: JsonValue): PdfDocument {
  if (
    !isRecord(value)
    || typeof value.path !== 'string'
    || typeof value.name !== 'string'
    || typeof value.size !== 'number'
    || typeof value.modifiedAt !== 'number'
  ) throw new Error('Alto returned an invalid PDF document')
  return {
    path: value.path,
    name: value.name,
    size: value.size,
    modifiedAt: value.modifiedAt,
  }
}

function NativePdfSurface({
  path,
  active,
  focused,
  nativeViews,
  ui,
  ready,
}: {
  path: string
  active: boolean
  focused: boolean
  nativeViews: ClientNativeViewsService
  ui: ClientUiService
  ready: (view: ClientNativeView | undefined) => void
}): ReactNode {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<ClientNativeView | undefined>(undefined)
  const syncRef = useRef<() => void>(() => undefined)
  const activeRef = useRef(active)
  const focusedRef = useRef(focused)
  const readyRef = useRef(ready)
  const nativeViewsOccluded = useSyncExternalStore(
    ui.overlays.subscribe,
    ui.overlays.nativeViewsOccluded,
  )
  const nativeViewsOccludedRef = useRef(nativeViewsOccluded)
  const [problem, setProblem] = useState<string>()

  activeRef.current = active
  focusedRef.current = focused
  readyRef.current = ready
  nativeViewsOccludedRef.current = nativeViewsOccluded

  useEffect(() => {
    let live = true
    let frame: number | undefined

    const sync = (): void => {
      if (frame !== undefined) return
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        const mount = mountRef.current
        const view = viewRef.current
        if (!mount || !view) return
        if (!activeRef.current) {
          view.setVisible(false)
          return
        }
        const rect = mount.getBoundingClientRect()
        const left = Math.max(0, rect.left)
        const top = Math.max(0, rect.top)
        const right = Math.min(window.innerWidth, rect.right)
        const bottom = Math.min(window.innerHeight, rect.bottom)
        const width = Math.max(0, right - left)
        const height = Math.max(0, bottom - top)
        view.setBounds({ x: left, y: top, width, height })
        view.setVisible(
          activeRef.current
          && !nativeViewsOccludedRef.current
          && width > 1
          && height > 1
          && document.visibilityState === 'visible',
        )
      })
    }
    syncRef.current = sync

    void nativeViews.create({ kind: 'pdf', path }).then((view) => {
      if (!live) {
        void view.destroy()
        return
      }
      viewRef.current = view
      readyRef.current(view)
      sync()
      if (activeRef.current && focusedRef.current) view.focus()
    }).catch((error: unknown) => {
      if (live) setProblem(error instanceof Error ? error.message : String(error))
    })

    return () => {
      live = false
      if (syncRef.current === sync) syncRef.current = () => undefined
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      const view = viewRef.current
      viewRef.current = undefined
      readyRef.current(undefined)
      void view?.destroy()
    }
  }, [nativeViews, path])

  useEffect(() => {
    if (!active) {
      viewRef.current?.setVisible(false)
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

  useEffect(() => syncRef.current(), [active, nativeViewsOccluded])
  useEffect(() => {
    if (active && focused) viewRef.current?.focus()
  }, [active, focused])

  return (
    <div className="pdf-viewer-native-surface" data-native-pane-surface="" ref={mountRef}>
      {problem ? <p role="alert">{problem}</p> : null}
    </div>
  )
}

function PdfViewerPane({
  pane,
  focused,
  visible,
  host,
  nativeViews,
  ui,
}: WorkspacePaneKindProps & {
  host: ClientHostService
  nativeViews: ClientNativeViewsService
  ui: ClientUiService
}): ReactNode {
  const activated = useViewerActivated(visible)
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<DocumentState>({ tag: 'idle' })
  const [view, setView] = useState<ClientNativeView>()
  const filePath = pane.resource

  useEffect(() => {
    if (!filePath) {
      setState({ tag: 'idle' })
      return
    }
    if (!activated) return
    let current = true
    setState({ tag: 'loading' })
    void host.call(PDF_VIEWER_INSPECT_METHOD, { path: filePath }).then((value) => {
      if (current) setState({ tag: 'ready', document: parsedDocument(value) })
    }).catch((error: unknown) => {
      if (current) setState({ tag: 'failed', problem: error instanceof Error ? error.message : String(error) })
    })
    return () => { current = false }
  }, [activated, filePath, host, reload])

  const document = state.tag === 'ready' ? state.document : undefined
  const openExternally = (): void => {
    if (document) void window.__ALTO_DESKTOP__?.openFile?.(document.path)
  }

  return (
    <section className={`${clientStyles.pane} pdf-viewer-pane`}>
      <header className={`${clientStyles.paneHeader} ${paneToolbarStyles.pane} pdf-viewer-toolbar`}>
        <div className={`${paneToolbarStyles.title} pdf-viewer-file`} title={document?.path ?? filePath}>
          <FileText size={15} strokeWidth={1.6} />
          <span>{document?.name ?? filePath?.split('/').at(-1) ?? 'PDF file'}</span>
        </div>
        <div className={`${paneToolbarStyles.actions} pdf-viewer-actions`}>
          <button
            className={clientStyles.iconButton}
            type="button"
            aria-label="Reload PDF file"
            title="Reload"
            disabled={!view}
            onClick={() => { void view?.perform('reload') }}
          >
            <RefreshCw size={14} strokeWidth={1.6} />
          </button>
          <button
            className={clientStyles.iconButton}
            type="button"
            aria-label="Open PDF in the default application"
            title="Open externally"
            disabled={!document || !window.__ALTO_DESKTOP__?.openFile}
            onClick={openExternally}
          >
            <ExternalLink size={14} strokeWidth={1.6} />
          </button>
        </div>
      </header>
      <div className="pdf-viewer-content">
        {!filePath && <div className="pdf-viewer-empty">Open a PDF file from a chat.</div>}
        {state.tag === 'loading' && <div className="pdf-viewer-loading"><RefreshCw size={16} /> Loading…</div>}
        {state.tag === 'failed' && (
          <div className="pdf-viewer-error" role="alert">
            <span>{state.problem}</span>
            <button type="button" onClick={() => setReload((value) => value + 1)}>Try again</button>
          </div>
        )}
        {document && (
          nativeViews.available() ? (
            <NativePdfSurface
              key={`${document.path}:${reload}`}
              path={document.path}
              active={visible}
              focused={focused}
              nativeViews={nativeViews}
              ui={ui}
              ready={setView}
            />
          ) : (
            <div className="pdf-viewer-unavailable">
              <FileText size={22} />
              <strong>Open this PDF in Alto Desktop</strong>
              <span>The embedded PDF renderer uses Alto’s native desktop surface.</span>
            </div>
          )
        )}
      </div>
    </section>
  )
}

export function openPdfBesideOrigin(
  layout: ClientWorkspaceLayoutService,
  path: string,
  origin: HTMLElement,
): void {
  const paneId = origin.closest<HTMLElement>('[data-workspace-pane-id]')?.dataset.workspacePaneId
  const target = paneId ? layout.paneTargets().find((candidate) => candidate.paneId === paneId) : undefined
  const session = target?.session.snapshot()
  layout.openPane({
    direction: 'horizontal',
    kind: 'pdf-viewer',
    resource: path,
    ...(session?.threadId ? { anchorThreadId: session.threadId } : {}),
    ...(session?.session.workspace ? { workspace: session.session.workspace } : {}),
    ...(session?.activeProjectId ? { projectId: session.activeProjectId } : {}),
  })
}

const pdfViewerClient: BrowserPlugin = (ctx) => {
  ctx.clientMarkdown.registerFileLink(ctx, {
    id: 'pdf-viewer',
    extensions: ['.pdf'],
    priority: 100,
    open: (details, origin) => openPdfBesideOrigin(ctx.clientWorkspaceLayout, details.path, origin),
  })
  ctx.clientWorkspaceLayout.registerPaneKind(ctx, {
    id: 'pdf-viewer',
    label: 'PDF',
    description: 'Native PDF preview with search, navigation, and zoom controls',
    shortcut: 'p',
    icon: FileText,
    renderer: (props) => (
      <PdfViewerPane
        {...props}
        host={ctx.clientHost}
        nativeViews={ctx.clientNativeViews}
        ui={ctx.clientUi}
      />
    ),
  })
  ctx.clientUi.registerStyle(ctx, 'pdf-viewer', String(styles))
}

pdfViewerClient.inject = [
  'clientHost',
  'clientMarkdown',
  'clientNativeViews',
  'clientUi',
  'clientWorkspaceLayout',
]

export default pdfViewerClient
