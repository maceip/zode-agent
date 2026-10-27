import {
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleX,
  Circle,
  GitBranch,
  GitPullRequest,
  Layers,
  RefreshCw,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import type { ThreadSummary } from '../../src/shared/protocol.js'
import { DIFF_VIEWER_PANE_KIND } from './diff-viewer-api.js'
import type { ClientGitSupportService } from './git-support-client-api.js'
import type { GitBranchState, GitChangedFile, GitPullRequest as PullRequest, GitRepositoryState } from './git-support-api.js'
import {
  checkLabel,
  compactPath,
  gitFileGroups,
  projectThreadGitState,
  threadGitContext,
} from './git-support-ui.js'
import type { ClientWorkContextsService } from './work-contexts-client-api.js'
import type {
  ClientWorkspaceLayoutService,
  WorkspacePaneAddonProps,
} from './workspace-layout-api.js'
import type { ClientSessionSnapshot } from './session-api.js'
import { useStoreSelector } from './ui/store-selector.js'

interface GitPaneSessionSnapshot {
  threads: ClientSessionSnapshot['threads']
  history: ClientSessionSnapshot['history']
  threadId?: string
  activeProjectId?: string
  workspace: string
  remoteLocation?: string
  remoteWorkspace?: ClientSessionSnapshot['remoteWorkspace']
}

function gitPaneSessionSnapshot(state: ClientSessionSnapshot): GitPaneSessionSnapshot {
  return {
    threads: state.threads,
    history: state.history,
    ...(state.threadId ? { threadId: state.threadId } : {}),
    ...(state.activeProjectId ? { activeProjectId: state.activeProjectId } : {}),
    workspace: state.session.workspace,
    ...(state.remoteLocation ? { remoteLocation: state.remoteLocation } : {}),
    ...(state.remoteWorkspace ? { remoteWorkspace: state.remoteWorkspace } : {}),
  }
}

function gitPaneSessionSnapshotEqual(
  left: GitPaneSessionSnapshot,
  right: GitPaneSessionSnapshot,
): boolean {
  return left.threads === right.threads
    && left.history === right.history
    && left.threadId === right.threadId
    && left.activeProjectId === right.activeProjectId
    && left.workspace === right.workspace
    && left.remoteLocation === right.remoteLocation
    && left.remoteWorkspace === right.remoteWorkspace
}

export function openGitDiffPane(
  layout: Pick<ClientWorkspaceLayoutService, 'openPane'>,
  workspace: string,
  threadId: string | undefined,
  thread: ThreadSummary | undefined,
  projectId: string | undefined,
): void {
  layout.openPane({
    direction: 'horizontal',
    kind: DIFF_VIEWER_PANE_KIND,
    workspace,
    ...(threadId ? { anchorThreadId: threadId } : {}),
    ...(thread ? { thread } : {}),
    ...(projectId ? { projectId } : {}),
  })
}

function CheckIcon({ state }: { state: GitRepositoryState['pullRequests'][number]['checks'] }): ReactNode {
  if (state === 'passing') return <CircleCheck className="is-passing" size={12} />
  if (state === 'failing') return <CircleX className="is-failing" size={12} />
  if (state === 'pending') return <CircleDot className="is-pending" size={12} />
  return <Circle className="is-unknown" size={12} />
}

function webLink(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '')
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch { return undefined }
}

function requestsForDisplay(requests: PullRequest[]): PullRequest[] {
  const stack = requests.find((request) => request.stack)?.stack
  const ordered = stack?.entries.toSorted((left, right) => left.position - right.position).map((entry) => entry.pullRequest) ?? []
  return [...new Map([...ordered, ...requests].map((request) => [request.url, request])).values()]
}

function CheckList({ checks }: { checks: NonNullable<PullRequest['checkDetails']> }): ReactNode {
  if (!checks.length) return null
  return <ul className="git-pane-check-list">
    {checks.map((check, index) => <li key={`${check.name}:${index}`}>
      <CheckIcon state={check.state} />
      {webLink(check.url)
        ? <a href={webLink(check.url)} target="_blank" rel="noreferrer">{check.name}</a>
        : <span>{check.name}</span>}
      <small>{check.description ?? checkLabel(check.state)}</small>
    </li>)}
  </ul>
}

function PullRequestChecks({ request }: { request: PullRequest }): ReactNode {
  const checks = request.checkDetails ?? []
  const failing = checks.filter((check) => check.state === 'failing')
  const pending = checks.filter((check) => check.state === 'pending')
  const passing = checks.filter((check) => check.state === 'passing')
  return <>
    {(request.checks !== 'passing' || !passing.length) && <div className="git-pane-check-summary">
      <CheckIcon state={request.checks} /><span>{checkLabel(request.checks) ?? 'No checks reported'}</span>
    </div>}
    <CheckList checks={[...failing, ...pending]} />
    {passing.length > 0 && <details className="git-pane-passing-checks">
      <summary className="git-pane-check-summary">
        <CheckIcon state="passing" /><span>{passing.length} passing</span>
        <ChevronRight className="git-pane-check-chevron" size={12} aria-hidden="true" />
      </summary>
      <CheckList checks={passing} />
    </details>}
  </>
}

function PullRequestDetails({ requests }: { requests: PullRequest[] }): ReactNode {
  const stack = requests.find((request) => request.stack)?.stack
  const displayed = requestsForDisplay(requests)
  return <div className="git-pane-pr-details">
    {stack && <div className="git-pane-stack-base"><GitBranch size={12} /><span>{stack.baseBranch}</span><small>Base</small></div>}
    {displayed.map((request) => <section className="git-pane-pr-section" key={request.url}>
      <a className="git-pane-pr-row" href={webLink(request.url)} target="_blank" rel="noreferrer">
        <GitPullRequest size={14} aria-hidden="true" />
        <span><strong>#{request.number}<small>{request.draft ? 'Draft' : request.state.toLowerCase()}</small></strong><span>{request.title}</span></span>
      </a>
      <PullRequestChecks request={request} />
      {(request.checkCount ?? 0) > (request.checkDetails?.length ?? 0) && <a className="git-pane-more-checks" href={webLink(request.url) ? `${request.url}/checks` : undefined} target="_blank" rel="noreferrer">View all {request.checkCount} checks</a>}
    </section>)}
    {stack && stack.size > stack.entries.length && <p className="git-pane-stack-more">Showing {stack.entries.length} of {stack.size} pull requests.</p>}
  </div>
}

function FileList({ label, files }: { label: string; files: GitChangedFile[] }): ReactNode {
  if (!files.length) return null
  return (
    <section className="git-pane-files">
      <h4>{label}<span>{files.length}</span></h4>
      {files.slice(0, 8).map((file) => (
        <div title={file.path} key={`${label}:${file.path}`}>
          <span>{compactPath(file.path)}</span>
          <code>{file.indexStatus === '?' ? '?' : `${file.indexStatus}${file.worktreeStatus}`.trim()}</code>
        </div>
      ))}
      {files.length > 8 && <small>{files.length - 8} more</small>}
    </section>
  )
}

function GitPanePopover({
  anchor,
  state,
  branchOnly = false,
  refresh,
  close,
  requests,
  id,
  hold,
  leave,
}: {
  anchor: HTMLElement
  state: GitRepositoryState
  branchOnly?: boolean
  refresh(): void
  close(): void
  requests?: PullRequest[] | undefined
  id?: string | undefined
  hold?(): void
  leave?(): void
}): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const bounds = anchor.getBoundingClientRect()
  const paneBounds = anchor.closest('.workspace-chat-pane')?.getBoundingClientRect()
  const width = Math.min(360, window.innerWidth - 16, (paneBounds?.width ?? window.innerWidth) - 16)
  const left = Math.max((paneBounds?.left ?? 0) + 8, Math.min(bounds.right - width, window.innerWidth - width - 8))
  const top = bounds.bottom + 6
  const files = gitFileGroups(state)
  const pullRequest = state.pullRequests[0]

  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !anchor.contains(target)) close()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (root.current?.contains(document.activeElement)) anchor.focus()
      close()
    }
    const reposition = (): void => close()
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', escape)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', escape)
      window.removeEventListener('resize', reposition)
    }
  }, [anchor, close])

  return createPortal(
    <div className="git-pane-popover" style={{ left, top, width, maxHeight: Math.max(100, window.innerHeight - top - 8) }} ref={root}
      id={id} role="dialog" aria-label={requests ? 'Pull request details' : 'Git status'}
      onPointerEnter={hold} onPointerLeave={leave} onFocusCapture={hold}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) leave?.() }}>
      <header>
        <strong>{requests?.some((request) => request.stack) ? 'Pull request stack' : requests ? 'Pull requests' : 'Git'}</strong>
        <button type="button" title="Refresh Git status" aria-label="Refresh Git status" onClick={refresh}>
          <RefreshCw size={12} />
        </button>
      </header>
      {requests ? <PullRequestDetails requests={requests} /> : <>
      <section className="git-pane-summary">
        <div><GitBranch size={13} /><span>{state.branch}</span><small>{state.head}</small></div>
        {state.upstream && (
          <div className="git-pane-sync">
            <span>{state.upstream}</span>
            {(state.ahead > 0 || state.behind > 0) && <small>↑{state.ahead} ↓{state.behind}</small>}
          </div>
        )}
        {pullRequest && (
          <a href={pullRequest.url} target="_blank" rel="noreferrer">
            <GitPullRequest size={13} />
            <span>#{pullRequest.number} · {pullRequest.title}</span>
          </a>
        )}
        {pullRequest?.checks && (
          <div>
            <CheckIcon state={pullRequest.checks} />
            <span>{checkLabel(pullRequest.checks)}</span>
          </div>
        )}
      </section>
      <FileList label="Staged" files={files.staged} />
      <FileList label="Modified" files={files.modified} />
      <FileList label="Untracked" files={files.untracked} />
      {!branchOnly && !state.files.length && <div className="git-pane-clean">Working tree clean</div>}
      </>}
    </div>,
    document.body,
  )
}

function VisibleGitPaneStatus({
  focused,
  session,
  git,
  contexts,
}: WorkspacePaneAddonProps & {
  git: ClientGitSupportService
  contexts: ClientWorkContextsService
}): ReactNode {
  const sessionState = useStoreSelector(
    session,
    gitPaneSessionSnapshot,
    gitPaneSessionSnapshotEqual,
  )
  const contextState = useSyncExternalStore(contexts.subscribe, contexts.snapshot)
  const gitSnapshot = useSyncExternalStore(git.subscribe, git.snapshot)
  const anchor = useRef<HTMLElement>(null)
  const popupId = useId()
  const [open, setOpen] = useState(false)
  const pinned = useRef(false)
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [capturedBranch, setCapturedBranch] = useState<{ key: string; state: GitBranchState }>()
  const gitContext = sessionState.remoteLocation ? {
    kind: 'remote' as const,
    location: sessionState.workspace,
    branch: sessionState.remoteWorkspace?.branch,
    repository: sessionState.remoteWorkspace?.repository,
    targetUpdatedAt: undefined,
  } : threadGitContext({
    ...(sessionState.threadId ? { id: sessionState.threadId } : {}),
    cwd: sessionState.workspace,
    ...(sessionState.activeProjectId ? { projectId: sessionState.activeProjectId } : {}),
  }, contexts)
  const location = gitContext.location
  const requestKey = JSON.stringify([gitContext.kind, location, gitContext.branch, gitContext.repository])
  const latestKey = useRef(requestKey)
  latestKey.current = requestKey
  const repositoryState = gitContext.kind === 'local' ? git.repositoryFor(location) : undefined
  const { state, branchOnly } = projectThreadGitState({
    kind: gitContext.kind, location,
    ...(gitContext.branch ? { branch: gitContext.branch } : {}),
    ...(gitContext.repository ? { repository: gitContext.repository } : {}),
  }, repositoryState, capturedBranch?.key === requestKey ? capturedBranch.state : undefined)
  void contextState
  void gitSnapshot

  useEffect(() => {
    let current = true
    setCapturedBranch(undefined)
    if (gitContext.kind === 'local') void git.inspect(location, { includeRemote: focused })
    if (gitContext.branch && (gitContext.kind !== 'remote' || gitContext.repository)) {
      void git.inspectBranch(location, gitContext.branch, {
        ...(gitContext.repository ? { repository: gitContext.repository } : {}),
      }).then((next) => {
        if (current && next) setCapturedBranch({ key: requestKey, state: next })
      })
    }
    return () => {
      current = false
    }
  }, [
    focused,
    git,
    gitContext.branch,
    gitContext.kind,
    gitContext.repository,
    gitContext.targetUpdatedAt,
    location,
    requestKey,
  ])

  const refresh = (force = true): void => {
    if (gitContext.kind === 'local') {
      void git.inspect(location, { includeRemote: true, force })
    }
    if (gitContext.branch && (gitContext.kind !== 'remote' || gitContext.repository)) {
      void git.inspectBranch(location, gitContext.branch, {
        ...(gitContext.repository ? { repository: gitContext.repository } : {}),
        force,
      }).then((next) => {
        if (next && latestKey.current === requestKey) setCapturedBranch({ key: requestKey, state: next })
      })
    }
  }

  const hold = (): void => { clearTimeout(dismissTimer.current) }
  const close = (): void => {
    hold()
    pinned.current = false
    setOpen(false)
  }
  const preview = (): void => {
    hold()
    if (!open) {
      setOpen(true)
      refresh(false)
    }
  }
  const leave = (): void => {
    hold()
    if (pinned.current) return
    dismissTimer.current = setTimeout(() => {
      const focusedElement = document.activeElement
      if (anchor.current?.contains(focusedElement) || document.getElementById(popupId)?.contains(focusedElement)) return
      setOpen(false)
    }, 180)
  }
  useEffect(() => {
    close()
    return () => { clearTimeout(dismissTimer.current) }
  }, [requestKey, sessionState.threadId])

  if (!state) return null
  const requests = state.pullRequests
  const stack = requests.find((request) => request.stack)?.stack
  const pullRequest = requests[0]
  const displayed = requestsForDisplay(requests)
  const checks = displayed.some((request) => request.checks === 'failing') ? 'failing'
    : displayed.some((request) => request.checks === 'pending') ? 'pending'
      : displayed.length && displayed.every((request) => request.checks === 'passing') ? 'passing' : undefined
  const sync = state.ahead || state.behind
  if (!pullRequest && !sync) return null
  const label = stack ? `Stack ${stack.size}` : requests.length > 1 ? `PRs ${requests.length}` : pullRequest
    ? `#${pullRequest.number}`
    : `↑${state.ahead} ↓${state.behind}`

  return (
    <div className="git-pane-control">
      {pullRequest && !stack && requests.length === 1 ? <a
        className={`git-pane-button git-pane-pr${checks ? ` is-${checks}` : ''}`}
        ref={(element) => { anchor.current = element }} href={webLink(pullRequest.url)} target="_blank" rel="noreferrer"
        aria-label={`Open pull request #${pullRequest.number}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined}
        onPointerEnter={preview} onPointerLeave={leave} onFocus={preview} onBlur={leave}
        onClick={close}
      ><GitPullRequest size={12} /><span>{label}</span></a> : <button
        className={`git-pane-button${pullRequest ? ' git-pane-pr' : ''}${checks ? ` is-${checks}` : ''}`}
        type="button"
        ref={(element) => { anchor.current = element }}
        aria-label={stack ? `Pull request stack, ${stack.size} pull requests` : pullRequest ? `${requests.length} pull requests` : 'Git status'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        onPointerEnter={pullRequest ? preview : undefined} onPointerLeave={leave}
        onFocus={pullRequest ? preview : undefined} onBlur={leave}
        onClick={(event) => {
          event.stopPropagation()
          if (open && pinned.current) close()
          else {
            hold()
            pinned.current = true
            setOpen(true)
            refresh(false)
          }
        }}
      >
        {stack ? <Layers size={12} /> : pullRequest ? <GitPullRequest size={12} /> : <GitBranch size={11} />}
        <span>{label}</span>
      </button>}
      {open && anchor.current && (
        <GitPanePopover
          anchor={anchor.current}
          state={state}
          id={popupId}
          requests={pullRequest ? requests : undefined}
          branchOnly={branchOnly}
          refresh={() => refresh()}
          close={close}
          hold={hold}
          leave={leave}
        />
      )}
    </div>
  )
}

function GitPaneStatus(props: WorkspacePaneAddonProps & {
  git: ClientGitSupportService
  contexts: ClientWorkContextsService
}): ReactNode {
  return props.visible ? <VisibleGitPaneStatus {...props} /> : null
}

const gitPaneStatus: BrowserPlugin = (ctx) => {
  ctx.clientWorkspaceLayout.registerPaneAddon(ctx, {
    id: 'git-pane-status',
    placement: 'pane-title',
    order: 30,
    renderer: (props) => (
      <GitPaneStatus
        {...props}
        git={ctx.clientGitSupport}
        contexts={ctx.clientWorkContexts}
      />
    ),
  })
}

gitPaneStatus.inject = ['clientGitSupport', 'clientWorkContexts', 'clientWorkspaceLayout']

export default gitPaneStatus
