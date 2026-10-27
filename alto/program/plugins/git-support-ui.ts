import type { ThreadSummary } from '../../src/shared/protocol.js'
import type { ClientWorkContextsService } from './work-contexts-client-api.js'
import type {
  GitBranchState,
  GitChangedFile,
  GitCheckState,
  GitRepositoryState,
} from './git-support-api.js'

export interface GitFileGroups {
  staged: GitChangedFile[]
  modified: GitChangedFile[]
  untracked: GitChangedFile[]
}

export function gitFileGroups(state: GitRepositoryState): GitFileGroups {
  return {
    staged: state.files.filter((file) => file.indexStatus !== ' ' && file.indexStatus !== '?'),
    modified: state.files.filter((file) => file.worktreeStatus !== ' ' && file.worktreeStatus !== '?'),
    untracked: state.files.filter((file) => file.indexStatus === '?' && file.worktreeStatus === '?'),
  }
}

export function gitChangeCount(state: GitRepositoryState): number {
  return new Set(state.files.map((file) => file.path)).size
}

export function checkLabel(state: GitCheckState | undefined): string | undefined {
  if (state === 'passing') return 'Checks passing'
  if (state === 'failing') return 'Checks failing'
  if (state === 'pending') return 'Checks running'
  return undefined
}

export function compactPath(value: string): string {
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : value
}

export interface ThreadGitSubject {
  id?: string
  cwd: string
  projectId?: string
  gitInfo?: ThreadSummary['gitInfo']
}

export interface ThreadGitContext {
  kind: 'local' | 'branch' | 'remote'
  location: string
  branch?: string
  repository?: string
  head?: string
  provider?: string
  status?: string
  targetUpdatedAt?: string
}

/**
 * Resolves the Git identity currently owned by the chat. An explicit work
 * target overrides the checkout captured when App Server created the thread.
 * Remote targets keep a local repository location only as command context;
 * callers must not project that checkout's files or sync counts as remote
 * state.
 */
export function threadGitContext(
  thread: ThreadGitSubject,
  contexts: ClientWorkContextsService,
): ThreadGitContext {
  const target = contexts.targetForThread(thread.id)
  const localForPath = contexts.localCheckoutForPath(thread.cwd, thread.projectId)
  if (target?.kind === 'local') {
    return {
      kind: 'local',
      location: target.location,
      branch: target.branch,
      ...(target.repository ? { repository: target.repository } : {}),
      ...(target.head ? { head: target.head } : {}),
      targetUpdatedAt: target.updatedAt,
    }
  }
  if (target) {
    const repository = target.repository ?? localForPath?.repository ?? thread.gitInfo?.originUrl
    return {
      kind: 'remote',
      location: localForPath?.location ?? thread.cwd,
      branch: target.branch,
      ...(repository ? { repository } : {}),
      ...(target.head ? { head: target.head } : {}),
      provider: target.kind,
      ...(target.status ? { status: target.status } : {}),
      targetUpdatedAt: target.updatedAt,
    }
  }

  if (thread.gitInfo?.branch) {
    const captured = contexts.snapshot().workstreams
      .filter((stream) => !thread.projectId || stream.projectId === thread.projectId)
      .flatMap((stream) => stream.checkouts)
      .find((checkout) => (
        checkout.kind === 'local'
        && checkout.branch === thread.gitInfo?.branch
        && (!thread.gitInfo.sha || !checkout.head || checkout.head === thread.gitInfo.sha)
    ))
    if (captured) {
      const repository = captured.repository ?? thread.gitInfo.originUrl
      const head = captured.head ?? thread.gitInfo.sha
      return {
        kind: 'local',
        location: captured.location,
        branch: captured.branch,
        ...(repository ? { repository } : {}),
        ...(head ? { head } : {}),
      }
    }
    const repository = thread.gitInfo.originUrl ?? localForPath?.repository
    return {
      kind: 'branch',
      location: localForPath?.location ?? thread.cwd,
      branch: thread.gitInfo.branch,
      ...(repository ? { repository } : {}),
      ...(thread.gitInfo.sha ? { head: thread.gitInfo.sha } : {}),
    }
  }

  return {
    kind: 'local',
    location: localForPath?.location ?? thread.cwd,
    ...(localForPath?.branch ? { branch: localForPath.branch } : {}),
    ...(localForPath?.repository ? { repository: localForPath.repository } : {}),
    ...(localForPath?.head ? { head: localForPath.head } : {}),
  }
}

export function projectThreadGitState(
  context: ThreadGitContext,
  local: GitRepositoryState | undefined,
  branch: GitBranchState | undefined,
): { state: GitRepositoryState | undefined; branchOnly: boolean } {
  const localMatches = context.kind === 'local'
    && (!context.branch || local?.branch === context.branch)
  if (localMatches || !context.branch) return { state: local, branchOnly: false }
  const remote = branch?.branch === context.branch ? branch : undefined
  return {
    branchOnly: true,
    state: {
      root: context.location,
      branch: context.branch,
      head: context.head ?? '',
      ahead: 0,
      behind: 0,
      files: [],
      pullRequests: remote?.pullRequests ?? [],
      updatedAt: remote?.updatedAt ?? '',
      ...(remote?.updatedAt ? { remoteUpdatedAt: remote.updatedAt } : {}),
    },
  }
}

export function threadGitLocation(
  thread: ThreadSummary,
  contexts: ClientWorkContextsService,
): string {
  return threadGitContext(thread, contexts).location
}

export function threadGitBranch(
  thread: ThreadSummary,
  contexts: ClientWorkContextsService,
): string | undefined {
  return threadGitContext(thread, contexts).branch
}
