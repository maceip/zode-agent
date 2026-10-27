export const PR_PANE = 'pull-requests'
export const PR_TOGGLE_ACTION = 'panel.pull-requests.toggle'
export const PR_STATE = 'pull-requests.state'
export const PR_REFRESH = 'pull-requests.refresh'
export const PR_REFRESH_INTERVAL = 90_000

export interface OpenPullRequest {
  id: string
  number: number
  title: string
  url: string
  repository: string
  headRepository: string | null
  branch: string
  baseBranch: string
  draft: boolean
  updatedAt: string
  createdAt?: string | undefined
  review: string | null
  checks: string | null
  mergeable: string
  mergeState: string
  unresolvedThreads: number
  moreThreads: boolean
  description?: string | undefined
  additions?: number | undefined
  deletions?: number | undefined
  changedFiles?: number | undefined
}

export interface PullRequestData {
  viewer: string
  items: OpenPullRequest[]
  total: number
  complete: boolean
}

export interface PullRequestSnapshot extends PullRequestData {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  fetchedAt: number | null
  error: string | null
}

export const EMPTY_PR_SNAPSHOT: PullRequestSnapshot = {
  viewer: '', items: [], total: 0, complete: true,
  phase: 'idle', fetchedAt: null, error: null,
}

export const PR_GROUPS = [
  { id: 'ready', label: 'Ready to merge', tone: 'green', shortLabel: 'Ready' },
  { id: 'attention', label: 'Address feedback', tone: 'red', shortLabel: 'Feedback' },
  { id: 'stale', label: 'Stale', tone: 'yellow', shortLabel: 'Stale' },
  { id: 'waiting', label: 'Waiting', tone: 'neutral', shortLabel: 'Waiting' },
  { id: 'draft', label: 'Drafts', tone: 'neutral', shortLabel: 'Drafts' },
] as const
export type PullRequestGroup = typeof PR_GROUPS[number]['id']

export function pullRequestStatus(pr: OpenPullRequest, now = Date.now()): { group: PullRequestGroup; reason: string } {
  if (pr.draft) return { group: 'draft', reason: 'Work in progress' }
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return { group: 'attention', reason: 'Resolve merge conflicts' }
  if (pr.review === 'CHANGES_REQUESTED') return { group: 'attention', reason: 'Changes requested' }
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') return { group: 'attention', reason: 'Fix failing checks' }
  if (pr.unresolvedThreads > 0) return { group: 'attention', reason: `${pr.unresolvedThreads}${pr.moreThreads ? '+' : ''} unresolved thread${pr.unresolvedThreads === 1 && !pr.moreThreads ? '' : 's'}` }
  if (pr.mergeable === 'MERGEABLE' && pr.mergeState === 'CLEAN' && !pr.moreThreads
    && pr.review === 'APPROVED' && pr.checks === 'SUCCESS') {
    return { group: 'ready', reason: 'Approved · mergeable' }
  }
  if (now - Date.parse(pr.updatedAt) >= 7 * 86_400_000) return { group: 'stale', reason: 'No activity for 7+ days' }
  if (pr.checks === 'PENDING' || pr.checks === 'EXPECTED') return { group: 'waiting', reason: 'Checks in progress' }
  if (pr.moreThreads) return { group: 'waiting', reason: 'More review threads to check on GitHub' }
  if (pr.mergeState === 'BEHIND') return { group: 'waiting', reason: 'Branch is behind its base' }
  if (pr.mergeState === 'BLOCKED') return { group: 'waiting', reason: 'Merge requirements pending' }
  if (pr.review === 'REVIEW_REQUIRED') return { group: 'waiting', reason: 'Waiting for review' }
  return { group: 'waiting', reason: 'Merge readiness not confirmed' }
}

export function pullRequestChecks(pr: OpenPullRequest): string {
  if (pr.checks === 'SUCCESS') return 'Checks passed'
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') return 'Checks failing'
  if (pr.checks === 'PENDING' || pr.checks === 'EXPECTED') return 'Checks running'
  return pr.checks === null ? 'No checks reported' : 'Checks unknown'
}

export function pullRequestReview(pr: OpenPullRequest): string {
  if (pr.review === 'APPROVED') return 'Approved'
  if (pr.review === 'CHANGES_REQUESTED') return 'Changes requested'
  if (pr.review === 'REVIEW_REQUIRED') return 'Review needed'
  return 'No review decision'
}

export function pullRequestParent(pr: OpenPullRequest, items: readonly OpenPullRequest[]): OpenPullRequest | undefined {
  return items.find((candidate) => candidate.id !== pr.id
    && candidate.repository === pr.repository
    && candidate.headRepository === pr.repository
    && candidate.branch === pr.baseBranch)
}

export function pullRequestMatches(pr: OpenPullRequest, query: string): boolean {
  const haystack = `${pr.repository} #${pr.number} ${pr.title} ${pr.branch} ${pr.baseBranch} ${pr.description ?? ''}`.toLowerCase()
  return query.toLowerCase().trim().split(/\s+/u).every((word) => haystack.includes(word))
}

export function pullRequestAge(timestamp: string | number, now = Date.now()): string {
  const seconds = Math.max(0, (now - (typeof timestamp === 'number' ? timestamp : Date.parse(timestamp))) / 1000)
  if (!Number.isFinite(seconds)) return 'unknown'
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}
