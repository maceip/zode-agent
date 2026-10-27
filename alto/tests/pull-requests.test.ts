import { readFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PullRequestRow } from '../program/plugins/pull-requests.client.js'
import { Contribution } from '../program/plugins/ui/contribution.js'
import {
  PR_REFRESH_INTERVAL,
  pullRequestMatches,
  pullRequestParent,
  pullRequestStatus,
  type OpenPullRequest,
  type PullRequestData,
} from '../program/plugins/pull-requests-api.js'
import { fetchOpenPullRequests, PullRequestCache } from '../program/plugins/pull-requests.js'

const now = Date.parse('2026-09-04T12:00:00Z')

function pr(overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    id: 'PR_1', number: 1, title: 'Improve the sidebar', repository: 'example/alto',
    headRepository: 'example/alto', url: 'https://github.com/example/alto/pull/1',
    branch: 'sidebar', baseBranch: 'main', draft: false,
    createdAt: '2026-09-01T11:00:00Z', updatedAt: '2026-09-04T11:00:00Z', review: 'APPROVED', checks: 'SUCCESS',
    mergeable: 'MERGEABLE', mergeState: 'CLEAN', unresolvedThreads: 0, moreThreads: false,
    ...overrides,
  }
}

function page(items: OpenPullRequest[], hasNextPage = false, endCursor: string | null = null) {
  return { data: { viewer: { login: 'example-user', pullRequests: {
    totalCount: 2, pageInfo: { hasNextPage, endCursor },
    nodes: items.map((item) => ({
      id: item.id, number: item.number, title: item.title, isDraft: item.draft,
      createdAt: item.createdAt, updatedAt: item.updatedAt, headRefName: item.branch, baseRefName: item.baseBranch,
      mergeable: item.mergeable, mergeStateStatus: item.mergeState, reviewDecision: item.review,
      repository: { nameWithOwner: item.repository },
      headRepository: item.headRepository ? { nameWithOwner: item.headRepository } : null,
      commits: { nodes: [{ commit: { statusCheckRollup: item.checks ? { state: item.checks } : null } }] },
      reviewThreads: {
        nodes: Array.from({ length: item.unresolvedThreads }, () => ({ isResolved: false })),
        pageInfo: { hasNextPage: item.moreThreads },
      },
    })),
  } } } }
}

function data(items = [pr()]): PullRequestData {
  return { viewer: 'example-user', items, total: items.length, complete: true }
}

describe('pull request triage', () => {
  it('only marks confirmed mergeable PRs ready', () => {
    expect(pullRequestStatus(pr(), now).group).toBe('ready')
    expect(pullRequestStatus(pr({ checks: null, review: null }), now).group).toBe('waiting')
    for (const overrides of [
      { mergeable: 'UNKNOWN' }, { mergeState: 'UNKNOWN' }, { mergeState: 'BLOCKED' },
      { mergeState: 'BEHIND' }, { checks: 'PENDING' }, { checks: 'UNRECOGNIZED' },
      { review: 'REVIEW_REQUIRED' }, { moreThreads: true },
    ]) expect(pullRequestStatus(pr(overrides), now).group).toBe('waiting')
  })

  it.each([
    { checks: 'FAILURE' }, { checks: 'ERROR' }, { review: 'CHANGES_REQUESTED' },
    { unresolvedThreads: 2 }, { mergeable: 'CONFLICTING' }, { mergeState: 'DIRTY' },
  ])('surfaces actionable problems: %j', (overrides) => {
    expect(pullRequestStatus(pr(overrides), now).group).toBe('attention')
  })

  it('keeps drafts out of the actionable groups, including old failing drafts', () => {
    expect(pullRequestStatus(pr({ draft: true, checks: 'FAILURE', updatedAt: '2026-08-01T00:00:00Z' }), now).group).toBe('draft')
  })

  it('marks inactivity without hiding feedback or a ready PR', () => {
    const old = { updatedAt: '2026-08-01T00:00:00Z' }
    expect(pullRequestStatus(pr({ ...old, review: 'REVIEW_REQUIRED' }), now).group).toBe('stale')
    expect(pullRequestStatus(pr({ ...old, checks: 'FAILURE' }), now).group).toBe('attention')
    expect(pullRequestStatus(pr(old), now).group).toBe('ready')
  })

  it('does not pretend a partial review-thread count is complete', () => {
    expect(pullRequestStatus(pr({ unresolvedThreads: 1, moreThreads: true }), now).reason).toBe('1+ unresolved threads')
  })

  it('filters by number, repository, title, and branches', () => {
    expect(pullRequestMatches(pr(), 'ALTO sidebar #1')).toBe(true)
    expect(pullRequestMatches(pr(), 'main')).toBe(true)
    expect(pullRequestMatches(pr(), 'does-not-exist')).toBe(false)
  })

  it('recognizes a stack base without confusing fork or repository branch names', () => {
    const child = pr({ id: 'PR_2', number: 2, branch: 'sidebar-tests', baseBranch: 'sidebar' })
    expect(pullRequestParent(child, [pr(), child])?.number).toBe(1)
    expect(pullRequestParent(child, [pr({ headRepository: 'fork/alto' }), child])).toBeUndefined()
    expect(pullRequestParent(child, [pr({ repository: 'other/alto' }), child])).toBeUndefined()
  })
})

describe('GitHub pull request loading', () => {
  it('paginates all authored open PRs and deduplicates moving pages', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(page([pr()], true, 'next'))
      .mockResolvedValueOnce(page([pr(), pr({ id: 'PR_2', number: 2 })]))
    const signal = new AbortController().signal
    const result = await fetchOpenPullRequests(signal, query)
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toEqual(pr())
    expect(result.complete).toBe(true)
    expect(query).toHaveBeenNthCalledWith(2, 'next', signal)
  })

  it('rejects partial GraphQL errors and malformed responses', async () => {
    for (const response of [{ ...page([pr()]), errors: [{ message: 'Unavailable' }] }, {}, page([pr({ repository: '../bad' })])]) {
      await expect(fetchOpenPullRequests(new AbortController().signal, async () => response)).rejects.toThrow()
    }
  })

  it('rejects stuck cursors instead of polling forever', async () => {
    await expect(fetchOpenPullRequests(new AbortController().signal, async () => page([pr()], true, 'same'))).rejects.toThrow('pagination did not advance')
  })

  it('aborts before fetching or between pages', async () => {
    const controller = new AbortController()
    const query = vi.fn(async () => {
      controller.abort()
      return page([pr()], true, 'next')
    })
    await expect(fetchOpenPullRequests(controller.signal, query)).rejects.toThrow()
    expect(query).toHaveBeenCalledTimes(1)
    await expect(fetchOpenPullRequests(controller.signal, query)).rejects.toThrow()
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('shared pull request cache', () => {
  it('coalesces refreshes, uses a TTL, and permits manual refresh', async () => {
    let clock = now
    const load = vi.fn(async () => data())
    const cache = new PullRequestCache(vi.fn(), load, () => clock)
    const initial = cache.refresh()
    expect(cache.refresh(true)).toBe(initial)
    await initial
    await cache.refresh()
    expect(load).toHaveBeenCalledTimes(1)
    clock += PR_REFRESH_INTERVAL
    await cache.refresh()
    await cache.refresh(true)
    expect(load).toHaveBeenCalledTimes(3)
    cache.dispose()
  })

  it('keeps stale data on errors but clears it on an empty successful refresh', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(data())
      .mockRejectedValueOnce(new Error('private server error'))
      .mockResolvedValueOnce(data([]))
    const cache = new PullRequestCache(vi.fn(), load, () => now)
    await cache.refresh()
    await cache.refresh(true)
    expect(cache.snapshot()).toMatchObject({ phase: 'error', fetchedAt: now, items: [pr()] })
    expect(cache.snapshot().error).not.toContain('private server error')
    await cache.refresh(true)
    expect(cache.snapshot()).toMatchObject({ phase: 'ready', items: [], total: 0, error: null })
    cache.dispose()
  })

  it('aborts in-flight work and never publishes after disposal', async () => {
    let resolvePending: ((value: PullRequestData) => void) | undefined
    const pending = new Promise<PullRequestData>((resolve) => { resolvePending = resolve })
    const publish = vi.fn()
    const load = vi.fn((_signal: AbortSignal) => pending)
    const cache = new PullRequestCache(publish, load)
    const refresh = cache.refresh()
    await Promise.resolve()
    cache.dispose()
    const count = publish.mock.calls.length
    resolvePending?.(data())
    await refresh
    expect(load.mock.calls[0]?.[0].aborted).toBe(true)
    expect(publish).toHaveBeenCalledTimes(count)
    await cache.refresh(true)
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('pull request pane presentation', () => {
  it('omits the redundant draft status row while retaining draft context for hover and screen readers', () => {
    const item = pr({ draft: true })
    const html = renderToStaticMarkup(createElement(PullRequestRow, { pr: item, items: [item] }))
    expect(html).not.toContain('Work in progress')
    expect(html).not.toContain('pr-dashboard-row-status')
    expect(html).toContain('on GitHub — Draft')
    expect(html).toContain('Draft · Checks passed')
    expect(html).toContain('pr-dashboard-pr-title')
    expect(html).toContain('href="https://github.com/example/alto/pull/1"')
  })

  it('shows the action needed on the row and keeps branch and CI detail in its tooltip', () => {
    const item = pr({ mergeable: 'CONFLICTING', branch: 'feature/example' })
    const html = renderToStaticMarkup(createElement(PullRequestRow, { pr: item, items: [item] }))
    expect(html).toContain('pr-dashboard-row-status is-attention')
    expect(html).toContain('Resolve merge conflicts')
    expect(html).toContain('feature/example')
    expect(html).toContain('Checks passed')
    expect(html).toContain('example/alto')
    expect(html).not.toContain('pr-dashboard-row-check')
  })

  it('links to GitHub and escapes untrusted PR titles', () => {
    const item = pr({ title: '<script>not markup</script>' })
    const html = renderToStaticMarkup(createElement(PullRequestRow, { pr: item, items: [item] }))
    expect(html).toContain('href="https://github.com/example/alto/pull/1"')
    expect(html).toContain('target="_blank" rel="noopener noreferrer"')
    expect(html).toContain('&lt;script&gt;not markup&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toMatch(/^<a class="pr-dashboard-row" href="https:\/\/github.com\/example\/alto\/pull\/1"/)
    expect(html.match(/<a\b/g)).toHaveLength(1)
    expect(html).not.toContain('<button')
    expect(html).not.toContain('aria-pressed')
  })

  it('uses a floating panel and shared controls, without registering a workspace pane', async () => {
    const css = await readFile(new URL('../program/plugins/pull-requests.css', import.meta.url), 'utf8')
    const client = await readFile(new URL('../program/plugins/pull-requests.client.tsx', import.meta.url), 'utf8')
    expect(client).toContain('clientStyles.floatingPanel')
    expect(client).toContain('clientStyles.iconButton')
    expect(client).toContain('registerRoot')
    expect(client).not.toContain('registerPaneKind')
    expect(client).not.toContain('PullRequestDetails')
    expect(client).not.toContain('pr-dashboard-dot')
    expect(client).not.toContain('pr-dashboard-list-label')
    expect(client).toContain("querySelectorAll<HTMLAnchorElement>('.pr-dashboard-row')")
    expect(client).toContain('aria-controls="pull-requests-panel"')
    expect(client).toContain('aria-expanded={open}')
    expect(client).toContain('inert={!open}')
    expect(client).toContain("event.key !== 'Escape'")
    expect(css).toContain('position: fixed;')
    expect(css).toContain('right: var(--space-3);')
    expect(css).toContain('.pr-dashboard-toggle[aria-expanded="true"] { color: var(--muted);')
    expect(css).toContain('.pr-dashboard-toggle { color: var(--muted); }')
    expect(css).toMatch(/\.pr-dashboard-flyout \{[^}]*height: auto;[^}]*max-height:/)
    expect(css).toMatch(/\.pr-dashboard-scroll \{[^}]*flex: 0 1 auto;[^}]*overflow: auto;/)
    expect(css).toContain('-webkit-line-clamp: 2;')
    expect(css).toMatch(/\.pr-dashboard-row \{[^}]*gap: var\(--space-1\);[^}]*padding: var\(--space-2\) var\(--space-3\);/)
    expect(css).toContain('--alto-floating-panel-background: var(--sidebar-material);')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('font-size: var(--type-body)')
    expect(css).toContain('border-radius: var(--radius-row)')
    expect(css).toContain('@container (max-width: 340px)')
    expect(css).not.toMatch(/font-size:\s*\d|border-radius:\s*\d|#[\da-f]{3,8}\b/iu)
  })

  it('exposes an owned mount for the header button beside Plugins', () => {
    const html = renderToStaticMarkup(createElement(Contribution, {
      contribution: { id: 'pull-requests-toggle', slot: 'header-right', nodes: [] },
      command: vi.fn(),
    }))
    expect(html).toContain('data-ui-contribution="pull-requests-toggle"')
  })
})
