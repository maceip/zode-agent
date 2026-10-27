import {
  CircleCheck,
  CircleDot,
  CircleX,
  Folder,
  GitBranch,
  GitPullRequest,
} from 'lucide-react'
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import type { ClientGitSupportService } from './git-support-client-api.js'
import {
  HISTORY_ENTRY_DECORATION_COMPONENT,
  type HistoryEntryDecorationProps,
} from './sidebar-decorations-api.js'
import type { GitBranchState, GitPullRequest as PullRequest } from './git-support-api.js'
import type { ClientWorkContextsService } from './work-contexts-client-api.js'
import {
  checkLabel,
  compactPath,
  threadGitContext,
} from './git-support-ui.js'

function CheckIcon({ state }: { state: PullRequest['checks'] }): ReactNode {
  if (state === 'passing') return <CircleCheck className="is-passing" size={12} />
  if (state === 'failing') return <CircleX className="is-failing" size={12} />
  return <CircleDot className="is-pending" size={12} />
}

function ThreadGitDetails({
  thread,
  project,
  git,
  contexts,
}: HistoryEntryDecorationProps & {
  git: ClientGitSupportService
  contexts: ClientWorkContextsService
}): ReactNode {
  const contextSnapshot = useSyncExternalStore(contexts.subscribe, contexts.snapshot)
  const context = threadGitContext(thread, contexts)
  const location = context.location
  const branch = context.branch
  const [state, setState] = useState<GitBranchState | undefined>()
  void contextSnapshot

  useEffect(() => {
    let current = true
    setState(undefined)
    const load = branch
      ? git.inspectBranch(location, branch, {
          ...(context.repository ? { repository: context.repository } : {}),
          force: context.kind === 'remote',
        })
      : git.inspect(location, { includeRemote: true }).then((repository) => repository && ({
          branch: repository.branch,
          pullRequests: repository.pullRequests,
          updatedAt: repository.remoteUpdatedAt ?? repository.updatedAt,
        }))
    void load.then((next) => {
      if (current) setState(next)
    })
    return () => {
      current = false
    }
  }, [branch, context.kind, context.repository, context.targetUpdatedAt, git, location])

  if (!state) return null
  const pullRequest = state.pullRequests[0]

  return (
    <section className="git-thread-menu-details" aria-label="Git and pull request details">
      <div><Folder size={13} /><span>{project?.name ?? compactPath(location)}</span></div>
      <div><GitBranch size={13} /><span>{state.branch}</span></div>
      {pullRequest && (
        <div><GitPullRequest size={13} /><span>#{pullRequest.number} · {pullRequest.title}</span></div>
      )}
      {pullRequest?.checks && (
        <div><CheckIcon state={pullRequest.checks} /><span>{checkLabel(pullRequest.checks)}</span></div>
      )}
    </section>
  )
}

const gitThreadDetails: BrowserPlugin = (ctx) => {
  ctx.clientUi.registerComponent<HistoryEntryDecorationProps>(
    ctx,
    HISTORY_ENTRY_DECORATION_COMPONENT,
    (props) => (
      <ThreadGitDetails
        {...props}
        git={ctx.clientGitSupport}
        contexts={ctx.clientWorkContexts}
      />
    ),
  )
}

gitThreadDetails.inject = ['clientGitSupport', 'clientUi', 'clientWorkContexts']
gitThreadDetails.resources = {
  provides: { components: [HISTORY_ENTRY_DECORATION_COMPONENT] },
}

export default gitThreadDetails
