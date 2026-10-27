import {
  ArrowUpRight,
  BriefcaseBusiness,
  ChevronDown,
  ChevronUp,
  Cloud,
  GitBranch,
  GitPullRequest,
  LayoutDashboard,
  Laptop,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type {
  BrowserPlugin,
  ClientComponentRenderer,
  ClientSubmitMode,
  ClientUiService,
} from '../../src/client/plugin-api.js'
import { clientStyles } from '../../src/client/plugin-api.js'
import {
  threadRecencyAt,
  type LocalProject,
  type ThreadSummary,
  type UiSurface,
} from '../../src/shared/protocol.js'
import {
  COMPOSER_COMPONENT,
  type ComposerComponentProps,
} from './chat-surfaces-api.js'
import type {
  GitBranchState,
  GitPullRequest as PullRequest,
  GitRepositoryState,
  GitSupportSnapshot,
} from './git-support-api.js'
import type { ClientGitSupportService } from './git-support-client-api.js'
import type {
  ClientSessionFactoryService,
  ClientSessionHandle,
  ClientSessionSnapshot,
} from './session-api.js'
import type {
  ClientThreadStatusService,
  ClientThreadStatusSnapshot,
} from './thread-status-api.js'
import type {
  WorkCheckout,
  WorkContextSnapshot,
  WorkProviderDescriptor,
} from './work-contexts-api.js'
import type { ClientWorkContextsService } from './work-contexts-client-api.js'
import type {
  ClientWorkspaceLayoutService,
  WorkspacePaneKindProps,
} from './workspace-layout-api.js'
import styles from './workspace-overview.css'

const overviewComposerSurface: UiSurface = {
  id: 'workspace-overview-composer',
  kind: 'composer',
  label: 'Start a chat',
  placeholder: 'Start a chat in this workspace',
  capabilities: ['skills', 'markdown', 'images', 'files'],
}

interface OverviewInput {
  workspace: string
  projectId?: string
  threads: readonly ThreadSummary[]
  contexts: WorkContextSnapshot
  git: GitSupportSnapshot
  branches: Readonly<Record<string, GitBranchState>>
  providers: readonly WorkProviderDescriptor[]
  threadStatus: ClientThreadStatusSnapshot
}

export interface OverviewBranch {
  name: string
  checkouts: WorkCheckout[]
  pullRequests: PullRequest[]
  chats: ThreadSummary[]
  running: boolean
  updatedAt: number
  repository?: GitRepositoryState
}

export interface OverviewChat {
  thread: ThreadSummary
  branch: string
  running: boolean
}

export interface WorkspaceOverviewModel {
  branches: OverviewBranch[]
  recentChats: OverviewChat[]
  branchCount: number
  worktreeCount: number
  pullRequestCount: number
  runCount: number
  chatCount: number
  runningCount: number
}

function normalizedPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
}

function pathContains(root: string, candidate: string): boolean {
  const parent = normalizedPath(root)
  const child = normalizedPath(candidate)
  return Boolean(parent) && (child === parent || child.startsWith(`${parent}/`))
}

function repositoryFor(snapshot: GitSupportSnapshot, location: string): GitRepositoryState | undefined {
  const candidate = normalizedPath(location)
  const root = snapshot.aliases[candidate]
  if (root) return snapshot.repositories[root]
  return Object.values(snapshot.repositories)
    .filter((repository) => pathContains(repository.root, candidate))
    .toSorted((left, right) => right.root.length - left.root.length)[0]
}

function timestamp(value: string | number | undefined): number {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1_000 : value
  const parsed = value ? Date.parse(value) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function threadMatchesWorkspace(
  thread: ThreadSummary,
  workspace: string,
  projectId: string | undefined,
): boolean {
  if (projectId && thread.projectId) return thread.projectId === projectId
  return pathContains(workspace, thread.cwd) || pathContains(thread.cwd, workspace)
}

function providerLabel(providers: readonly WorkProviderDescriptor[], kind: string): string {
  return providers.find((provider) => provider.id === kind)?.label ?? kind
}

function checkoutRecency(checkout: WorkCheckout): number {
  return timestamp(checkout.lastUsedAt)
}

function uniquePullRequests(requests: readonly PullRequest[]): PullRequest[] {
  return [...new Map(requests.map((request) => [request.url || String(request.number), request])).values()]
    .toSorted((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))
}

export function workspaceOverviewModel(input: OverviewInput): WorkspaceOverviewModel {
  const groups = new Map<string, OverviewBranch>()
  const runningThreads = new Set(input.threadStatus.running)
  const ensure = (name: string): OverviewBranch => {
    const branch = name.trim() || 'Workspace'
    let group = groups.get(branch)
    if (!group) {
      group = {
        name: branch,
        checkouts: [],
        pullRequests: [],
        chats: [],
        running: false,
        updatedAt: 0,
      }
      groups.set(branch, group)
    }
    return group
  }

  const streams = input.contexts.workstreams.filter((stream) => (
    input.projectId ? stream.projectId === input.projectId : stream.checkouts.some(
      (checkout) => pathContains(input.workspace, checkout.location),
    )
  ))
  for (const stream of streams) {
    const group = ensure(stream.branch)
    group.checkouts.push(...stream.checkouts)
    for (const checkout of stream.checkouts) {
      group.updatedAt = Math.max(group.updatedAt, checkoutRecency(checkout))
      if (checkout.statusTone === 'progress') group.running = true
      const repository = repositoryFor(input.git, checkout.location)
      if (repository?.branch === stream.branch) {
        group.repository ??= repository
        group.pullRequests.push(...repository.pullRequests)
      }
    }
    const branch = input.branches[stream.branch]
    if (branch) {
      group.pullRequests.push(...branch.pullRequests)
    }
  }

  const threads = input.threads
    .filter((thread) => threadMatchesWorkspace(thread, input.workspace, input.projectId))
    .toSorted((left, right) => threadRecencyAt(right) - threadRecencyAt(left))
    .slice(0, 40)
  const recentChats: OverviewChat[] = []
  for (const thread of threads) {
    const target = input.contexts.threadTargets[thread.id]
    const checkout = target
      ?? streams.flatMap((stream) => stream.checkouts).find((candidate) => (
        candidate.kind === 'local' && pathContains(candidate.location, thread.cwd)
      ))
    const branch = target?.branch ?? thread.gitInfo?.branch ?? checkout?.branch ?? 'Workspace'
    const running = runningThreads.has(thread.id) || thread.status?.type === 'active'
    const group = ensure(branch)
    group.chats.push(thread)
    group.running ||= running
    recentChats.push({ thread, branch, running })
    group.updatedAt = Math.max(group.updatedAt, timestamp(threadRecencyAt(thread)))
  }

  for (const group of groups.values()) {
    group.checkouts = [...new Map(group.checkouts.map((checkout) => [checkout.id, checkout])).values()]
      .toSorted((left, right) => (
        Number(right.statusTone === 'progress') - Number(left.statusTone === 'progress')
        || Number(right.kind === 'local') - Number(left.kind === 'local')
        || Number(right.primary) - Number(left.primary)
        || checkoutRecency(right) - checkoutRecency(left)
        || left.label.localeCompare(right.label)
      ))
    group.pullRequests = uniquePullRequests(group.pullRequests)
    group.chats = group.chats.slice(0, 5)
    for (const request of group.pullRequests) {
      group.updatedAt = Math.max(group.updatedAt, timestamp(request.updatedAt))
    }
  }

  const branches = [...groups.values()]
    .toSorted((left, right) => (
      Number(right.running) - Number(left.running)
      || right.updatedAt - left.updatedAt
      || left.name.localeCompare(right.name)
    ))
    .slice(0, 12)
  const checkouts = branches.flatMap((branch) => branch.checkouts)
  const pullRequests = uniquePullRequests(branches.flatMap((branch) => branch.pullRequests))
  return {
    branches,
    recentChats,
    branchCount: branches.length,
    worktreeCount: checkouts.filter((checkout) => checkout.kind === 'local' && !checkout.primary).length,
    pullRequestCount: pullRequests.length,
    runCount: checkouts.filter((checkout) => checkout.kind !== 'local').length,
    chatCount: recentChats.length,
    runningCount: branches.filter((branch) => branch.running).length,
  }
}

export function relativeAge(value: number, now = Date.now()): string {
  if (!value) return 'Recently'
  const seconds = Math.max(0, Math.floor((now - value) / 1_000))
  if (seconds < 60) return 'Just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days < 7 ? `${days}d ago` : new Date(value).toLocaleDateString()
}

function workspaceName(project: LocalProject | undefined, workspace: string): string {
  if (project?.name) return project.name
  return normalizedPath(workspace).split('/').filter(Boolean).at(-1) ?? 'Workspace'
}

function relativeLocation(location: string, workspace: string): string {
  const root = normalizedPath(workspace)
  const candidate = normalizedPath(location)
  if (candidate === root) return '.'
  if (candidate.startsWith(`${root}/`)) return `./${candidate.slice(root.length + 1)}`
  return candidate.split('/').filter(Boolean).at(-1) ?? candidate
}

function StatusDot({ tone }: { tone: WorkCheckout['statusTone'] }): ReactNode {
  return <span className={`workspace-overview-status is-${tone ?? 'neutral'}`} aria-hidden="true" />
}

function CheckoutRow({
  checkout,
  workspace,
  providers,
}: {
  checkout: WorkCheckout
  workspace: string
  providers: readonly WorkProviderDescriptor[]
}): ReactNode {
  const remote = checkout.kind !== 'local'
  const Icon = remote ? (checkout.statusTone === 'progress' ? LoaderCircle : Cloud) : Laptop
  const kind = remote
    ? providerLabel(providers, checkout.kind)
    : checkout.primary ? 'Primary checkout' : 'Worktree'
  const body = (
    <>
      <Icon className={checkout.statusTone === 'progress' ? 'is-spinning' : undefined} size={16} />
      <span className="workspace-overview-row-copy">
        <strong>{checkout.label}</strong>
        <small>{kind} · {relativeLocation(checkout.location, workspace)}</small>
      </span>
      {checkout.status ? <span className="workspace-overview-state">{checkout.status}</span> : null}
      {checkout.status || checkout.statusTone
        ? <StatusDot tone={checkout.statusTone} />
        : null}
      {checkout.url ? <ArrowUpRight size={14} /> : null}
    </>
  )
  return checkout.url ? (
    <a className="workspace-overview-row" href={checkout.url} rel="noreferrer" target="_blank">
      {body}
    </a>
  ) : <div className="workspace-overview-row">{body}</div>
}

export function PullRequestRow({ request }: { request: PullRequest }): ReactNode {
  return (
    <a className="workspace-overview-row" href={request.url} rel="noreferrer" target="_blank">
      <GitPullRequest size={16} />
      <span className="workspace-overview-row-copy">
        <strong>{request.title}</strong>
        <small>#{request.number} into {request.baseBranch}{request.draft ? ' · Draft' : ''}</small>
      </span>
      {request.checks ? <span className={`workspace-overview-checks is-${request.checks}`}>{request.checks}</span> : null}
      <ArrowUpRight size={14} />
    </a>
  )
}

function ChatRow({
  chat,
  open,
}: {
  chat: OverviewChat
  open: () => void
}): ReactNode {
  const { thread, branch, running } = chat
  return (
    <button className="workspace-overview-row workspace-overview-chat" type="button" onClick={open}>
      <MessageSquare size={16} />
      <span className="workspace-overview-row-copy">
        <strong>{thread.title || 'Untitled chat'}</strong>
        <small><GitBranch size={12} />{branch}<span>·</span>{thread.preview || 'No preview'}</small>
      </span>
      <span className="workspace-overview-row-age">{relativeAge(timestamp(threadRecencyAt(thread)))}</span>
      {running ? <LoaderCircle className="is-spinning" size={14} aria-label="Working" /> : null}
    </button>
  )
}

function BranchCard({
  branch,
  workspace,
  providers,
  expanded,
}: {
  branch: OverviewBranch
  workspace: string
  providers: readonly WorkProviderDescriptor[]
  expanded: boolean
}): ReactNode {
  const local = branch.checkouts.filter((checkout) => checkout.kind === 'local')
  const remote = branch.checkouts.filter((checkout) => checkout.kind !== 'local')
  const worktrees = local.filter((checkout) => !checkout.primary)
  const summary = [
    local.some((checkout) => checkout.primary) ? 'Primary checkout' : undefined,
    worktrees.length ? `${worktrees.length} ${worktrees.length === 1 ? 'worktree' : 'worktrees'}` : undefined,
    remote.length ? `${remote.length} ${remote.length === 1 ? 'run' : 'runs'}` : undefined,
    branch.pullRequests.length
      ? `${branch.pullRequests.length} ${branch.pullRequests.length === 1 ? 'PR' : 'PRs'}`
      : undefined,
  ].filter((value): value is string => Boolean(value))

  return (
    <article className={`workspace-overview-branch${expanded ? ' is-expanded' : ''}`}>
      <header>
        <span className="workspace-overview-branch-icon"><GitBranch size={16} /></span>
        <span>
          <strong>{branch.name}</strong>
          <small>{summary.join(' · ') || relativeAge(branch.updatedAt)}</small>
        </span>
        {branch.running ? <span className="workspace-overview-active"><StatusDot tone="progress" />Active</span> : null}
      </header>
      {!expanded && local.length ? (
        <div className="workspace-overview-compact-work">
          {local.slice(0, 2).map((checkout) => (
            <CheckoutRow
              checkout={checkout}
              providers={providers}
              workspace={workspace}
              key={checkout.id}
            />
          ))}
        </div>
      ) : null}
      {expanded ? (
        <div className="workspace-overview-groups">
          {local.length || remote.length ? (
            <section>
              <h3>Worktrees and runs</h3>
              <div>
                {[...local, ...remote].map((checkout) => (
                  <CheckoutRow
                    checkout={checkout}
                    providers={providers}
                    workspace={workspace}
                    key={checkout.id}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {branch.pullRequests.length ? (
            <section>
              <h3>Pull requests</h3>
              <div>{branch.pullRequests.map((request) => <PullRequestRow request={request} key={request.url} />)}</div>
            </section>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function OverviewContent({
  workspaceId,
  pane,
  session,
  git,
  contexts,
  threadStatus,
  layout,
  ui,
  Composer,
  focused,
  visible,
}: WorkspacePaneKindProps & {
  session: ClientSessionHandle
  git: ClientGitSupportService
  contexts: ClientWorkContextsService
  threadStatus: ClientThreadStatusService
  layout: ClientWorkspaceLayoutService
  ui: ClientUiService
  Composer: ClientComponentRenderer<ComposerComponentProps>
}): ReactNode {
  const sessionState = useSyncExternalStore(session.session.subscribe, session.session.snapshot)
  const contextState = useSyncExternalStore(contexts.subscribe, contexts.snapshot)
  const gitState = useSyncExternalStore(git.subscribe, git.snapshot)
  const statusState = useSyncExternalStore(threadStatus.subscribe, threadStatus.snapshot)
  const [branches, setBranches] = useState<Record<string, GitBranchState>>({})
  const [expanded, setExpanded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [problem, setProblem] = useState<string>()
  const project = sessionState.projects.find((candidate) => candidate.id === pane.projectId)
    ?? sessionState.projects.find((candidate) => candidate.primaryRoot === pane.workspace)

  const refresh = async (force = false): Promise<void> => {
    setRefreshing(true)
    setProblem(undefined)
    try {
      await contexts.refresh()
      const snapshot = contexts.snapshot()
      const streams = snapshot.workstreams.filter((stream) => (
        pane.projectId ? stream.projectId === pane.projectId : stream.checkouts.some(
          (checkout) => pathContains(pane.workspace, checkout.location),
        )
      ))
      const recentBranches = new Set(sessionState.threads
        .filter((thread) => threadMatchesWorkspace(thread, pane.workspace, pane.projectId))
        .toSorted((left, right) => threadRecencyAt(right) - threadRecencyAt(left))
        .flatMap((thread) => thread.gitInfo?.branch ? [thread.gitInfo.branch] : []))
      const inspectedStreams = streams
        .toSorted((left, right) => (
          Number(right.checkouts.some((checkout) => checkout.statusTone === 'progress'))
          - Number(left.checkouts.some((checkout) => checkout.statusTone === 'progress'))
          || Number(recentBranches.has(right.branch)) - Number(recentBranches.has(left.branch))
          || left.branch.localeCompare(right.branch)
        ))
        .slice(0, 12)
      const localLocations = [...new Set([
        pane.workspace,
        ...inspectedStreams.flatMap((stream) => stream.checkouts)
          .filter((checkout) => checkout.kind === 'local')
          .map((checkout) => checkout.location),
      ])]
      await Promise.all(localLocations.map((location) => git.inspect(location, {
        includeRemote: true,
        force,
      })))
      const inspected = await Promise.all(inspectedStreams.map(async (stream) => [
        stream.branch,
        await git.inspectBranch(pane.workspace, stream.branch, {
          ...(stream.repository ? { repository: stream.repository } : {}),
          force,
        }),
      ] as const))
      setBranches(Object.fromEntries(inspected.filter(
        (entry): entry is readonly [string, GitBranchState] => Boolean(entry[1]),
      )))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!visible) return
    void refresh(false)
  }, [pane.projectId, pane.workspace, visible])

  const model = useMemo(() => workspaceOverviewModel({
    workspace: pane.workspace,
    ...(pane.projectId ? { projectId: pane.projectId } : {}),
    threads: sessionState.threads,
    contexts: contextState,
    git: gitState,
    branches,
    providers: contextState.providers,
    threadStatus: statusState,
  }), [branches, contextState, gitState, pane.projectId, pane.workspace, sessionState.threads, statusState])
  const name = workspaceName(project, pane.workspace)
  const visibleChats = expanded ? model.recentChats.slice(0, 12) : model.recentChats.slice(0, 5)
  const visibleBranches = expanded ? model.branches : model.branches.slice(0, 4)
  const canExpand = model.recentChats.length > 5
    || model.branches.length > 4
    || model.branches.some((branch) => (
      branch.pullRequests.length > 0
      || branch.checkouts.some((checkout) => checkout.kind !== 'local')
    ))

  const openThread = (thread: ThreadSummary): void => {
    if (!layout.focusThread(thread.id)) layout.showThreadInPane(workspaceId, pane.id, thread)
  }

  const submit = async (
    draft: Parameters<ClientUiService['submit']>[0],
    mode: ClientSubmitMode,
  ): Promise<void> => {
    setProblem(undefined)
    const before = session.session.snapshot()
    await ui.submit(draft, (forwarded) => session.session.send(forwarded), {
      mode,
      target: {
        id: before.threadId ?? `new:${pane.workspace}`,
        ...(before.threadId ? { threadId: before.threadId } : {}),
        activeTurn: before.turn.tag === 'running',
        send: (forwarded) => session.session.send(forwarded),
        steer: (forwarded) => session.session.steer(forwarded),
      },
    })
    const next = session.session.snapshot()
    const thread = next.threadId
      ? next.threads.find((candidate) => candidate.id === next.threadId)
      : undefined
    if (!thread) throw new Error('Alto created the chat but could not open it in this tab')
    layout.showThreadInPane(workspaceId, pane.id, thread)
  }

  return (
    <section className={`${clientStyles.pane} workspace-overview`} aria-label={`${name} overview`}>
      <div className="workspace-overview-scroll">
        <div className="workspace-overview-content">
          <header className="workspace-overview-heading">
            <div>
              <span><BriefcaseBusiness size={14} />Workspace overview</span>
              <h1>{name}</h1>
              <p title={pane.workspace}>{pane.workspace}</p>
            </div>
            <button
              className={clientStyles.iconButton}
              type="button"
              aria-label="Refresh workspace activity"
              title="Refresh workspace activity"
              disabled={refreshing}
              onClick={() => { void refresh(true) }}
            >
              <RefreshCw className={refreshing ? 'is-spinning' : undefined} size={16} />
            </button>
          </header>
          {problem || contextState.problem ? (
            <p className="workspace-overview-problem" role="status">{problem ?? contextState.problem}</p>
          ) : null}
          <section className="workspace-overview-section">
            <header>
              <h2>Recent chats</h2>
              <span>{model.chatCount}</span>
            </header>
            {visibleChats.length ? (
              <div className="workspace-overview-panel workspace-overview-chats">
                {visibleChats.map((chat) => (
                  <ChatRow
                    chat={chat}
                    open={() => openThread(chat.thread)}
                    key={chat.thread.id}
                  />
                ))}
              </div>
            ) : (
              <div className="workspace-overview-empty is-compact">
                <MessageSquare size={20} />
                <span>No recent chats in this workspace.</span>
              </div>
            )}
          </section>
          <section className="workspace-overview-section">
            <header>
              <h2>Branches and worktrees</h2>
              <span>{model.branchCount}</span>
            </header>
            {visibleBranches.length ? (
              <div className="workspace-overview-branches">
                {visibleBranches.map((branch) => (
                  <BranchCard
                    branch={branch}
                    workspace={pane.workspace}
                    providers={contextState.providers}
                    expanded={expanded}
                    key={branch.name}
                  />
                ))}
              </div>
            ) : (
              <div className="workspace-overview-empty is-compact">
                <GitBranch size={20} />
                <span>No branches or worktrees found.</span>
              </div>
            )}
          </section>
          {canExpand || expanded ? (
            <button
              className={`${clientStyles.button} ghost workspace-overview-expand`}
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {expanded ? 'Show less' : 'Expand more'}
            </button>
          ) : null}
        </div>
      </div>
      <div className="workspace-pane-composer workspace-overview-composer">
        <Composer
          surface={overviewComposerSurface}
          session={session.session}
          autoFocus={focused}
          submitDraft={submit}
          lockWorkspace
        />
      </div>
    </section>
  )
}

function WorkspaceOverviewPane({
  workspaceId,
  pane,
  focused,
  visible,
  services,
  Composer,
}: WorkspacePaneKindProps & {
  services: {
    factory: ClientSessionFactoryService
    git: ClientGitSupportService
    contexts: ClientWorkContextsService
    threadStatus: ClientThreadStatusService
    layout: ClientWorkspaceLayoutService
    ui: ClientUiService
  }
  Composer: ClientComponentRenderer<ComposerComponentProps>
}): ReactNode {
  const [session, setSession] = useState<ClientSessionHandle>()
  useEffect(() => {
    const handle = services.factory.create({
      initialWorkspace: pane.workspace,
      ...(pane.projectId ? { initialProjectId: pane.projectId } : { initialProjectId: null }),
      restoreActiveThread: false,
      persistActiveThread: false,
    })
    setSession(handle)
    return () => {
      handle.dispose()
    }
  }, [pane.id, pane.projectId, pane.workspace, services.factory])

  if (!session) return <div className="workspace-overview-loading">Loading workspace…</div>
  return (
    <OverviewContent
      pane={pane}
      focused={focused}
      visible={visible}
      workspaceId={workspaceId}
      session={session}
      git={services.git}
      contexts={services.contexts}
      threadStatus={services.threadStatus}
      layout={services.layout}
      ui={services.ui}
      Composer={Composer}
    />
  )
}

const workspaceOverview: BrowserPlugin = (ctx) => {
  const Composer = ctx.clientUi.component<ComposerComponentProps>(COMPOSER_COMPONENT)
  if (!Composer) throw new Error('Workspace Overview requires the shared chat composer')
  const services = {
    factory: ctx.clientSessionFactory,
    git: ctx.clientGitSupport,
    contexts: ctx.clientWorkContexts,
    threadStatus: ctx.clientThreadStatus,
    layout: ctx.clientWorkspaceLayout,
    ui: ctx.clientUi,
  }
  ctx.clientWorkspaceLayout.registerPaneKind(ctx, {
    id: 'workspace-overview',
    label: 'Overview',
    description: 'Recent branches, worktrees, pull requests, runs, and chats',
    shortcut: 'o',
    newTab: true,
    icon: LayoutDashboard,
    renderer: (props) => <WorkspaceOverviewPane {...props} services={services} Composer={Composer} />,
  })
  ctx.clientUi.registerStyle(ctx, 'workspace-overview', String(styles))
}

workspaceOverview.inject = [
  'clientGitSupport',
  'clientSessionFactory',
  'clientThreadStatus',
  'clientUi',
  'clientWorkContexts',
  'clientWorkspaceLayout',
]
workspaceOverview.resources = {
  requires: { components: [COMPOSER_COMPONENT] },
}

export default workspaceOverview
