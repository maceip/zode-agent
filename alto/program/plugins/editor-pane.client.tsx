import { SquareCode } from 'lucide-react'
import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { clientStyles, type BrowserPlugin, type ClientHostService } from '../../src/client/plugin-api.js'
import { isRecord } from '../../src/shared/protocol.js'
import { EDITOR_PANE_KIND, EDITOR_PREPARE, EDITOR_OPEN_FILE, type ClientEditorService, type EditorLaunch } from './editor-pane-api.js'
import type { GhosttyTerminalProps, TerminalIdentity } from './ghostty-terminal-api.js'
import type { MarkdownFileLinkDetails } from './markdown-api.js'
import type { ClientSessionService } from './session-api.js'
import type { ClientWorkContextsService } from './work-contexts-client-api.js'
import type { ClientWorkspaceLayoutService, WorkspacePaneKindProps } from './workspace-layout-api.js'
import styles from './editor-pane.css'

export function editorTarget(session: ClientSessionService, contexts: ClientWorkContextsService) {
  const state = session.snapshot()
  const selected = state.threadId ? contexts.snapshot().threadTargets[state.threadId] : undefined
  const workspace = selected?.location ?? state.session.workspace
  const problem = state.remoteLocation || (selected && selected.kind !== 'local')
    ? 'Neovim panes currently support local workspaces.'
    : state.projectScope === 'unscoped' || !workspace
      ? 'Choose a workspace for this chat first.' : undefined
  return { workspace, problem, state }
}

interface EditorPaneLocation {
  workspaceId: string
  paneId: string
  workspace: string
  canonicalWorkspace?: string
  pending?: boolean
  openFile?: (details: MarkdownFileLinkDetails) => void
}

export class EditorPanes implements ClientEditorService {
  private readonly panes = new Map<string, EditorPaneLocation>()
  private readonly sessions = new Map<string, TerminalIdentity>()
  constructor(
    private readonly layout: ClientWorkspaceLayoutService,
    private readonly contexts: ClientWorkContextsService,
    private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>,
  ) {}

  identity(workspace: string, initial: TerminalIdentity): TerminalIdentity {
    const existing = this.sessions.get(workspace)
    if (existing) return existing
    const key = `alto.editor-session.v1:${workspace}`
    let identity = initial
    try {
      const stored: unknown = JSON.parse(this.storage?.getItem(key) ?? 'null')
      if (isRecord(stored) && ['workspaceId', 'paneId', 'tabId'].every((name) => (
        typeof stored[name] === 'string' && stored[name].length > 0 && stored[name].length <= 512
      ))) identity = { workspaceId: stored.workspaceId as string, paneId: stored.paneId as string, tabId: stored.tabId as string }
      this.storage?.setItem(key, JSON.stringify(identity))
    } catch { /* Preserve the running session in memory if storage is unavailable. */ }
    this.sessions.set(workspace, identity)
    return identity
  }

  unavailable(session: ClientSessionService): string | undefined {
    return !this.layout.available() ? 'The workspace layout is unavailable.' : editorTarget(session, this.contexts).problem
  }

  mount(location: EditorPaneLocation): () => void {
    this.panes.set(location.paneId, location)
    return () => { if (this.panes.get(location.paneId) === location) this.panes.delete(location.paneId) }
  }

  openFile(details: MarkdownFileLinkDetails, origin: HTMLElement): boolean {
    const originId = origin.closest<HTMLElement>('[data-workspace-pane-id]')?.dataset.workspacePaneId
    const source = this.layout.paneTargets().find((target) => target.paneId === originId)
    const target = source ? editorTarget(source.session, this.contexts) : undefined
    if (target?.problem) return false
    const workspaceId = source?.workspaceId ?? this.layout.tabs().find((tab) => tab.active)?.id
    const candidates = [...this.panes.values()].filter((pane) => {
      if (!pane.openFile) return false
      if (target) return pane.workspace === target.workspace || pane.canonicalWorkspace === target.workspace
      return pane.workspaceId === workspaceId && [pane.workspace, pane.canonicalWorkspace].some((workspace) => (
        workspace && details.path.startsWith(`${workspace.replace(/\/$/u, '')}/`)
      ))
    }).sort((a, b) => Number(b.workspaceId === workspaceId) - Number(a.workspaceId === workspaceId))
    for (const pane of candidates) {
      if (!this.layout.focusPane(pane.workspaceId, pane.paneId)) continue
      pane.openFile!(details)
      return true
    }
    return false
  }

  open(session: ClientSessionService): void {
    const problem = this.unavailable(session)
    if (problem) throw new Error(problem)
    const { workspace, state } = editorTarget(session, this.contexts)
    const targets = this.layout.paneTargets()
    const source = targets.find((target) => target.session === session)
      ?? targets.find((target) => state.threadId && target.session.snapshot().threadId === state.threadId)
      ?? targets.find((target) => target.focused)
    const workspaceId = source?.workspaceId ?? this.layout.tabs().find((tab) => tab.active)?.id
    for (const pane of this.panes.values()) {
      if (pane.workspaceId === workspaceId && pane.workspace === workspace
        && (pane.pending || this.layout.focusPane(pane.workspaceId, pane.paneId))) return
    }
    const opened = this.layout.openPane({
      kind: EDITOR_PANE_KIND, direction: 'horizontal', workspace,
      ...(source ? { anchor: { workspaceId: source.workspaceId, paneId: source.paneId } } : {}),
      ...(state.threadId ? { anchorThreadId: state.threadId } : {}),
      ...(state.activeProjectId ? { projectId: state.activeProjectId } : {}),
    })
    this.panes.set(opened.paneId, { ...opened, workspace, pending: true })
  }
}

export function EditorPane({ workspaceId, pane, visible, focused, host, Terminal, editors }: WorkspacePaneKindProps & {
  host: ClientHostService
  Terminal: ComponentType<GhosttyTerminalProps>
  editors: EditorPanes
}): ReactNode {
  const [launch, setLaunch] = useState<EditorLaunch & { identity: TerminalIdentity }>()
  const [problem, setProblem] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [fileProblem, setFileProblem] = useState<string>()
  useEffect(() => {
    let live = true
    let latest = 0
    const unmount = editors.mount({ workspaceId, paneId: pane.id, workspace: pane.workspace,
      ...(launch ? { canonicalWorkspace: launch.workingDirectory, openFile: (details: MarkdownFileLinkDetails) => {
        const request = ++latest
        setFileProblem(undefined)
        void host.call(EDITOR_OPEN_FILE, { workspace: launch.workingDirectory, identity: { ...launch.identity },
          path: details.path, ...(details.line ? { line: details.line } : {}),
          ...(details.column ? { column: details.column } : {}),
        }).catch((error: unknown) => {
          if (live && request === latest) setFileProblem(error instanceof Error ? error.message : String(error))
        })
      } } : {}),
    })
    return () => { live = false; unmount() }
  }, [editors, host, workspaceId, pane.id, pane.workspace, launch])
  useEffect(() => {
    let live = true
    setLaunch(undefined)
    setProblem(undefined)
    void host.call(EDITOR_PREPARE, { workspace: pane.workspace }).then((value) => {
      if (!isRecord(value) || typeof value.command !== 'string' || typeof value.workingDirectory !== 'string') {
        throw new Error('Alto could not prepare Neovim.')
      }
      if (live) setLaunch({ command: value.command, workingDirectory: value.workingDirectory,
        identity: editors.identity(value.workingDirectory, { workspaceId, paneId: pane.id, tabId: 'neovim' }),
      })
    }).catch((error: unknown) => {
      if (live) setProblem(error instanceof Error ? error.message : String(error))
    })
    return () => { live = false }
  }, [host, pane.workspace, pane.id, workspaceId, editors, attempt])
  return <div className={`${clientStyles.pane} editor-pane`}>
    <div className={`${clientStyles.paneHeader} editor-pane-header workspace-local-tabbar`}>
      <SquareCode size={14} aria-hidden="true" /><span>Neovim</span>
    </div>
    {fileProblem && <div className="editor-pane-file-error" role="alert">
      <span>{fileProblem}</span><button type="button" className={clientStyles.button} onClick={() => setFileProblem(undefined)}>Dismiss</button>
    </div>}
    <div className="editor-pane-content">
    {launch ? <Terminal {...launch}
      active={visible} focused={focused} />
      : <div className="editor-pane-status" role={problem ? 'alert' : 'status'}>
          <span>{problem ?? 'Opening Neovim…'}</span>
          {problem && <button className={clientStyles.button} type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
        </div>}
    </div>
  </div>
}

const editorPane: BrowserPlugin = (ctx) => {
  let storage: Storage | undefined
  try { storage = window.localStorage } catch { /* Keep session bindings in memory. */ }
  const editors = new EditorPanes(ctx.clientWorkspaceLayout, ctx.clientWorkContexts, storage)
  const Terminal = ctx.clientGhosttyTerminal.renderer
  ctx.provide('clientEditor', editors)
  ctx.clientWorkspaceLayout.registerPaneKind(ctx, {
    id: EDITOR_PANE_KIND, label: 'Editor', description: 'Edit this workspace in Neovim', icon: SquareCode, shortcut: 'e',
    renderer: (props) => <EditorPane {...props} host={ctx.clientHost} Terminal={Terminal} editors={editors} />,
  })
  ctx.clientUi.registerStyle(ctx, 'editor-pane', String(styles))
}
editorPane.inject = ['clientGhosttyTerminal', 'clientHost', 'clientUi', 'clientWorkspaceLayout', 'clientWorkContexts']
editorPane.provide = 'clientEditor'
export default editorPane
