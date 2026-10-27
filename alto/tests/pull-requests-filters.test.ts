import { readFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PR_FILTERS, PR_FILTERS_KEY, filterPullRequests, parsePullRequestFilters, readPullRequestFilters } from '../program/plugins/pull-requests-filters.js'
import { PullRequestSettings } from '../program/plugins/pull-requests.client.js'
import type { OpenPullRequest } from '../program/plugins/pull-requests-api.js'

const now = Date.parse('2026-09-04T12:00:00Z')
function pr(repository: string, days: number, id = repository): OpenPullRequest {
  return { id, repository, number: 1, title: 'Example', url: `https://github.com/${repository}/pull/1`,
    headRepository: repository, branch: 'feature', baseBranch: 'main', draft: false,
    createdAt: new Date(now - days * 86_400_000).toISOString(), updatedAt: new Date(now).toISOString(),
    review: null, checks: null, mergeable: 'UNKNOWN', mergeState: 'UNKNOWN', unresolvedThreads: 0, moreThreads: false }
}

describe('pull request exclusions', () => {
  const items = [pr('example/old', 60), pr('example/recent', 5), pr('other/recent', 1)]
  it('shows everything by default without changing the source data', () => {
    expect(filterPullRequests(items, DEFAULT_PR_FILTERS, now)).toEqual(items)
    expect(items).toHaveLength(3)
  })
  it('excludes exact owner/repo names, case-insensitively', () => {
    expect(filterPullRequests(items, { excludedRepositories: ['EXAMPLE/RECENT'], maxAgeDays: null }, now)).toEqual([items[0], items[2]])
  })
  it('uses creation age, not recent activity, and retains the exact boundary', () => {
    const filters = { excludedRepositories: [], maxAgeDays: 5 }
    expect(filterPullRequests(items, filters, now)).toEqual([items[1], items[2]])
    expect(filterPullRequests([pr('example/edge', 5 + 1 / 86_400)], filters, now)).toEqual([])
  })
  it('combines repository and age exclusions before search or grouping', () => {
    const filtered = filterPullRequests(items, { excludedRepositories: ['example/recent'], maxAgeDays: 30 }, now)
    expect(filtered).toEqual([items[2]])
  })
  it('retains cached PRs with unknown creation dates until refresh', () => {
    const old = { ...items[0]!, createdAt: undefined }
    expect(filterPullRequests([old], { excludedRepositories: [], maxAgeDays: 30 }, now)).toEqual([old])
  })
  it('normalizes saved repositories and rejects invalid ages', () => {
    expect(parsePullRequestFilters({ excludedRepositories: [' Example/Repo ', 'EXAMPLE/REPO', 5, null, 'bad'], maxAgeDays: 30 })).toEqual({ excludedRepositories: ['example/repo'], maxAgeDays: 30 })
    for (const maxAgeDays of [0, -5, 1.5, '30', NaN, Infinity]) {
      expect(parsePullRequestFilters({ maxAgeDays }).maxAgeDays).toBeNull()
    }
  })
  it('restores preferences and tolerates corrupt or unavailable storage', () => {
    const settings = { excludedRepositories: ['example/repo'], maxAgeDays: 30 }
    const getItem = vi.fn(() => JSON.stringify(settings))
    expect(readPullRequestFilters({ getItem })).toEqual(settings)
    expect(getItem).toHaveBeenCalledWith(PR_FILTERS_KEY)
    for (const getItem of [() => '{', () => 'null', () => { throw new Error('Unavailable') }]) {
      expect(readPullRequestFilters({ getItem })).toEqual(DEFAULT_PR_FILTERS)
    }
  })
})

describe('PR filter controls', () => {
  it('labels the age input and shows excluded repos checked', () => {
    const html = renderToStaticMarkup(createElement(PullRequestSettings, {
      filters: { excludedRepositories: ['example/old'], maxAgeDays: 30 },
      repositories: ['example/old', 'example/recent'], onChange: vi.fn(), close: vi.fn(),
    }))
    expect(html).toContain('aria-label="Maximum PR age in days"')
    expect(html).toContain('value="30"')
    expect(html).toContain('Since the PR was opened')
    expect(html.match(/checked=""/g)).toHaveLength(1)
    expect(html).toContain('Reset filters')
  })
  it('removes the account/sync footer and keeps buckets in a scrollable single row', async () => {
    const client = await readFile(new URL('../program/plugins/pull-requests.client.tsx', import.meta.url), 'utf8')
    const css = await readFile(new URL('../program/plugins/pull-requests.css', import.meta.url), 'utf8')
    expect(client).not.toContain('pr-dashboard-footer')
    expect(client).not.toContain('snapshot.viewer')
    expect(client).not.toContain('Synced ')
    expect(client).toContain('filterPullRequests(snapshot.items, filters)')
    expect(css).toMatch(/\.pr-dashboard-buckets \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/)
  })
})
