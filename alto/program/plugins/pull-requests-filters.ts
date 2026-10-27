import type { OpenPullRequest } from './pull-requests-api.js'

export const PR_FILTERS_KEY = 'alto.pr.filters'
export interface PullRequestFilters {
  excludedRepositories: string[]
  maxAgeDays: number | null
}
export const DEFAULT_PR_FILTERS: PullRequestFilters = { excludedRepositories: [], maxAgeDays: null }

export function parsePullRequestFilters(value: unknown): PullRequestFilters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_PR_FILTERS }
  const saved = value as Record<string, unknown>
  return {
    excludedRepositories: Array.isArray(saved.excludedRepositories)
      ? [...new Set(saved.excludedRepositories.filter((repo): repo is string => typeof repo === 'string' && /^[a-z\d][a-z\d-]*\/[\w.-]+$/iu.test(repo.trim())).map((repo) => repo.trim().toLowerCase()))]
      : [],
    maxAgeDays: typeof saved.maxAgeDays === 'number' && Number.isSafeInteger(saved.maxAgeDays) && saved.maxAgeDays > 0 ? saved.maxAgeDays : null,
  }
}

export function readPullRequestFilters(storage: Pick<Storage, 'getItem'>): PullRequestFilters {
  try { return parsePullRequestFilters(JSON.parse(storage.getItem(PR_FILTERS_KEY) ?? 'null')) }
  catch { return { ...DEFAULT_PR_FILTERS } }
}

export function filterPullRequests(items: readonly OpenPullRequest[], filters: PullRequestFilters, now = Date.now()): OpenPullRequest[] {
  const excluded = new Set(filters.excludedRepositories.map((repo) => repo.toLowerCase()))
  const cutoff = filters.maxAgeDays === null ? null : now - filters.maxAgeDays * 86_400_000
  return items.filter((pr) => {
    if (excluded.has(pr.repository.toLowerCase())) return false
    // Older disk caches lack creation dates. Keep those PRs until refresh supplies them;
    // last activity is not a substitute for when the PR was opened.
    const opened = pr.createdAt ? Date.parse(pr.createdAt) : NaN
    return cutoff === null || !Number.isFinite(opened) || opened >= cutoff
  })
}
