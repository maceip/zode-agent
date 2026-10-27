import { ArrowUpRight, Check, CircleAlert, Clock3, GitPullRequest, RefreshCw, Search, Settings2, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clientStyles, type BrowserPlugin, type ClientHostService, type ClientUiService } from '../../src/client/plugin-api.js'
import {
  PR_GROUPS, PR_PANE as PR_PANEL, PR_REFRESH, PR_TOGGLE_ACTION,
  pullRequestAge, pullRequestChecks, pullRequestMatches, pullRequestParent, pullRequestReview, pullRequestStatus,
  type OpenPullRequest, type PullRequestGroup,
} from './pull-requests-api.js'
import { startPullRequestPolling } from './pull-requests-refresh.js'
import { DEFAULT_PR_FILTERS, PR_FILTERS_KEY, filterPullRequests, readPullRequestFilters, type PullRequestFilters } from './pull-requests-filters.js'
import { pullRequestViewStore } from './pull-requests-store.js'
import styles from './pull-requests.css'

const TOGGLE_MOUNT = '[data-ui-contribution="pull-requests-toggle"]'
type Bucket = PullRequestGroup | 'all'
const BUCKETS = [...PR_GROUPS, { id: 'all', label: 'All open', shortLabel: 'All', tone: 'neutral' }] as const
function savedBucket(): Bucket | null {
  try {
    const value = localStorage.getItem('alto.pr.bucket')
    return BUCKETS.some((bucket) => bucket.id === value) ? value as Bucket : null
  } catch { return null }
}

export const PullRequestRow = memo(function PullRequestRow({ pr, items }: {
  pr: OpenPullRequest; items: readonly OpenPullRequest[]
}): ReactNode {
  const status = pullRequestStatus(pr)
  const parent = pullRequestParent(pr, items)
  const StatusIcon = status.group === 'ready' ? Check : status.group === 'attention' ? CircleAlert : Clock3
  return (
    <a className="pr-dashboard-row" href={pr.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${pr.title} (${pr.repository}#${pr.number}) on GitHub — ${pr.draft ? 'Draft' : status.reason}`} title={`${pr.title}\n${pr.repository}#${pr.number} · ${pr.branch}\n${pr.draft ? 'Draft · ' : ''}${pullRequestChecks(pr)} · ${pullRequestReview(pr)}\nOpen on GitHub`}>
      <span className="pr-dashboard-row-meta">
        <span className="pr-dashboard-repository">{pr.repository} <span>#{pr.number}{parent ? ` · ↳ #${parent.number}` : ''}</span></span>
        <time dateTime={pr.updatedAt} title={`Updated ${pullRequestAge(pr.updatedAt)}`}>{pullRequestAge(pr.updatedAt).replace(' ago', '')}</time>
        <ArrowUpRight className="pr-dashboard-row-link" size={15} aria-hidden="true" />
      </span>
      <span className="pr-dashboard-pr-title">{pr.title}</span>
      {!pr.draft && <span className={`pr-dashboard-row-status is-${status.group}`}><StatusIcon size={14} aria-hidden="true" />{status.reason}</span>}
    </a>
  )
})

export function PullRequestSettings({ filters, repositories, onChange, close }: {
  filters: PullRequestFilters; repositories: readonly string[]; onChange: (next: PullRequestFilters) => void; close: () => void
}): ReactNode {
  const age = useRef<HTMLInputElement>(null)
  const [repoQuery, setRepoQuery] = useState('')
  useEffect(() => { age.current?.focus() }, [])
  const matching = repositories.filter((repo) => repo.toLowerCase().includes(repoQuery.trim().toLowerCase()))
  return (
    <section id="pr-dashboard-settings" className="pr-dashboard-settings" aria-label="Pull request filters">
      <div className="pr-dashboard-settings-heading"><h3>Filters</h3><button className={clientStyles.button} type="button" onClick={close}>Done</button></div>
      <label className="pr-dashboard-age">
        <span>Hide PRs older than</span>
        <input ref={age} type="number" min="1" step="1" inputMode="numeric" aria-label="Maximum PR age in days" aria-describedby="pr-dashboard-age-help" placeholder="Any" value={filters.maxAgeDays ?? ''} onChange={(event) => {
          const days = event.currentTarget.value === '' ? null : event.currentTarget.valueAsNumber
          if (days === null || Number.isSafeInteger(days) && days > 0) onChange({ ...filters, maxAgeDays: days })
        }} />
        <span>days</span>
      </label>
      <p id="pr-dashboard-age-help" className="pr-dashboard-settings-help">Since the PR was opened. Leave blank for any age.</p>
      <h4>Excluded repositories</h4>
      <p className="pr-dashboard-settings-help">Checked repositories are hidden from every view.</p>
      <label className="pr-dashboard-search pr-dashboard-repo-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="Find repositories to exclude" placeholder="Find a repository…" value={repoQuery} onChange={(event) => setRepoQuery(event.target.value)} /></label>
      <div className="pr-dashboard-repositories">
        {matching.map((repo) => <label className="pr-dashboard-repo-option" key={repo}>
          <input type="checkbox" checked={filters.excludedRepositories.includes(repo)} onChange={(event) => onChange({ ...filters, excludedRepositories: event.target.checked ? [...filters.excludedRepositories, repo] : filters.excludedRepositories.filter((name) => name !== repo) })} />
          <span title={repo}>{repo}</span>
        </label>)}
        {!matching.length && <p className="pr-dashboard-settings-help">{repoQuery ? 'No matching repositories.' : 'Repositories appear here when PRs load.'}</p>}
      </div>
      {(filters.maxAgeDays !== null || filters.excludedRepositories.length > 0) && <button className={`${clientStyles.button} pr-dashboard-reset`} type="button" onClick={() => onChange({ ...DEFAULT_PR_FILTERS })}>Reset filters</button>}
    </section>
  )
}

export function PullRequestsList({ host, visible, close }: { host: ClientHostService; visible: boolean; close: () => void }): ReactNode {
  const store = useMemo(() => pullRequestViewStore(host), [host])
  const { snapshot, connected } = useSyncExternalStore(store.subscribe, store.snapshot)
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [filters, setFilters] = useState<PullRequestFilters>(() => {
    try { return readPullRequestFilters(localStorage) } catch { return { ...DEFAULT_PR_FILTERS } }
  })
  const settingsButton = useRef<HTMLButtonElement>(null)
  const closeSettings = (): void => { setSettingsOpen(false); settingsButton.current?.focus() }
  useEffect(() => {
    try { localStorage.setItem(PR_FILTERS_KEY, JSON.stringify(filters)) } catch {}
  }, [filters])
  const [bucket, setBucket] = useState<Bucket | null>(savedBucket)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const polling = useRef<ReturnType<typeof startPullRequestPolling> | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const refreshing = snapshot.phase === 'loading'
  useEffect(() => {
    if (!visible) return
    const current = startPullRequestPolling(host, setConnectionError)
    polling.current = current
    return () => { current.dispose(); polling.current = null }
  }, [host, visible])
  const items = useMemo(() => filterPullRequests(snapshot.items, filters), [snapshot, filters])
  const exclusionsActive = filters.maxAgeDays !== null || filters.excludedRepositories.length > 0
  const hiddenCount = snapshot.items.length - items.length
  const repositories = useMemo(() => [...new Set([...snapshot.items.map((pr) => pr.repository.toLowerCase()), ...filters.excludedRepositories])].sort(), [snapshot.items, filters.excludedRepositories])
  const groups = useMemo(() => PR_GROUPS.map((group) => ({ ...group, items: items.filter((pr) => pullRequestStatus(pr).group === group.id) })), [items])
  const currentBucket = bucket ?? groups.find((group) => group.items.length)?.id ?? 'all'
  useEffect(() => {
    if (bucket === null && snapshot.items.length) setBucket(currentBucket)
  }, [bucket, currentBucket, snapshot.items.length])
  useEffect(() => {
    if (bucket === null) return
    try { localStorage.setItem('alto.pr.bucket', bucket) } catch {}
  }, [bucket])
  const filtered = useMemo(() => {
    const source = query.trim() || currentBucket === 'all' ? items : groups.find((group) => group.id === currentBucket)?.items ?? []
    return source.filter((pr) => pullRequestMatches(pr, query)).sort((a, b) => {
      if (currentBucket === 'attention' && a.review !== b.review) return Number(b.review === 'APPROVED') - Number(a.review === 'APPROVED')
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    })
  }, [items, query, currentBucket, groups])
  const selectBucket = (id: Bucket): void => { setBucket(id); setQuery('') }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (settingsOpen) {
      if (event.key === 'Escape') { event.preventDefault(); closeSettings() }
      return
    }
    if (event.key === 'Escape' && query) {
      event.preventDefault()
      setQuery('')
    }
    if ((event.metaKey || event.ctrlKey) && /^[1-6]$/.test(event.key)) {
      event.preventDefault()
      const next = BUCKETS[Number(event.key) - 1]
      if (next) selectBucket(next.id)
    }
    if (event.key === '/' && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); search.current?.focus() }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || event.altKey || event.metaKey) return
    const links = [...(list.current?.querySelectorAll<HTMLAnchorElement>('.pr-dashboard-row') ?? [])]
    if (!links.length) return
    event.preventDefault()
    const index = links.indexOf(document.activeElement as HTMLAnchorElement)
    const next = Math.min(links.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
    links[next]?.focus({ preventScroll: true })
    links[next]?.scrollIntoView({ block: 'nearest' })
  }
  return (
    <section className="pr-dashboard" aria-label="My pull requests" onKeyDown={onKeyDown}>
      <header className={`${clientStyles.toolbar} pr-dashboard-header`}>
        <span className="pr-dashboard-heading">Pull requests{exclusionsActive
          ? <button type="button" className="pr-dashboard-total pr-dashboard-filter-summary" title={`${hiddenCount} pull requests hidden by your filters`} aria-label={`${items.length} of ${snapshot.items.length} pull requests shown. Configure filters.`} onClick={() => setSettingsOpen(true)}>{items.length}<span>of {snapshot.items.length}</span></button>
          : <span className="pr-dashboard-total">{snapshot.fetchedAt !== null || snapshot.items.length ? items.length : ''}</span>}</span>
        <div className={clientStyles.toolbarActions}>
          <button ref={settingsButton} className={clientStyles.iconButton} type="button" aria-label={exclusionsActive ? 'Configure pull request filters (active)' : 'Configure pull request filters'} aria-expanded={settingsOpen} aria-controls="pr-dashboard-settings" title={exclusionsActive ? 'Filters active' : 'Configure filters'} onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={15} /></button>
          <button className={clientStyles.iconButton} type="button" disabled={refreshing || !connected} aria-label="Refresh pull requests" title="Refresh pull requests" onClick={() => polling.current?.refresh(true)}><RefreshCw size={15} /></button>
          <button className={clientStyles.iconButton} type="button" aria-label="Close pull requests" title="Close pull requests" onClick={close}><X size={16} /></button>
        </div>
      </header>
      {settingsOpen ? <PullRequestSettings filters={filters} repositories={repositories} onChange={setFilters} close={closeSettings} /> : <>
      <label className="pr-dashboard-search"><Search size={15} aria-hidden="true" /><input ref={search} aria-label="Search pull requests" type="search" value={query} placeholder="Search all pull requests…" onChange={(event) => setQuery(event.target.value)} /><kbd>/</kbd></label>
      <div className="pr-dashboard-buckets" aria-label="Filter pull requests">
        {BUCKETS.map((group, index) => <button type="button" key={group.id} className="pr-dashboard-bucket" aria-pressed={!query.trim() && currentBucket === group.id} title={`${group.label} · ⌘${index + 1}`} onClick={() => selectBucket(group.id)}>{group.shortLabel}<span>{group.id === 'all' ? items.length : groups.find((item) => item.id === group.id)?.items.length ?? 0}</span></button>)}
      </div>
      {(snapshot.error || connectionError) && <p className="pr-dashboard-notice" role="alert">{connectionError ?? snapshot.error}</p>}
      {!connected && <p className="pr-dashboard-notice" role="status">Reconnecting…</p>}
      {!snapshot.complete && !refreshing && <p className="pr-dashboard-notice" role="status">Some pull requests could not be loaded.</p>}
      <div className="pr-dashboard-scroll" ref={list} aria-label={`${filtered.length} pull requests`} aria-busy={refreshing}>
        {snapshot.items.length === 0 && snapshot.fetchedAt === null && !snapshot.error && !connectionError
          ? <p className="pr-dashboard-empty">Fetching your pull requests…<br />They’ll be ready here next time.</p>
          : filtered.length === 0 && <p className="pr-dashboard-empty">{query.trim() ? 'No matching pull requests.' : exclusionsActive && items.length === 0 ? 'No pull requests match your filters.' : 'No pull requests in this view.'}</p>}
        {filtered.map((pr) => <PullRequestRow key={pr.id} pr={pr} items={snapshot.items} />)}
      </div>
      </>}
    </section>
  )
}

function useToggleMount(ui: ClientUiService): HTMLElement | null {
  const revision = useSyncExternalStore(ui.subscribe, ui.snapshot)
  const [mount, setMount] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const sync = (): boolean => {
      const target = document.querySelector<HTMLElement>(TOGGLE_MOUNT)
      setMount((current) => current === target ? current : target)
      return target !== null
    }
    if (sync()) return
    const observer = new MutationObserver(() => { if (sync()) observer.disconnect() })
    observer.observe(document.querySelector('.shell-kernel') ?? document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [revision])
  return mount
}

export function PullRequestsChrome({ host, ui }: { host: ClientHostService; ui: ClientUiService }): ReactNode {
  const mount = useToggleMount(ui)
  const activeOverlay = useSyncExternalStore(ui.overlays.subscribe, ui.overlays.snapshot)
  const open = activeOverlay === PR_PANEL
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const close = useCallback(() => { ui.overlays.close(PR_PANEL); buttonRef.current?.focus() }, [ui])
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector('input')?.focus())
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      close()
    }
    const outside = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && !panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) ui.overlays.close(PR_PANEL)
    }
    document.addEventListener('keydown', escape)
    document.addEventListener('pointerdown', outside, true)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside, true) }
  }, [close, open, ui])
  return (
    <>
      {mount && createPortal(<button ref={buttonRef} className={`${clientStyles.iconButton} icon-button shell-control pr-dashboard-toggle${open ? ' active' : ''}`} type="button" data-hotkey-action={PR_TOGGLE_ACTION} aria-label="Pull requests" title="Pull requests" aria-haspopup="dialog" aria-controls="pull-requests-panel" aria-expanded={open} onClick={() => ui.overlays.toggle(PR_PANEL)}><GitPullRequest size={15} /></button>, mount)}
      {createPortal(
        <aside id="pull-requests-panel" ref={panelRef} className={`${clientStyles.floatingPanel} pr-dashboard-flyout${open ? ' is-open' : ''}`} role="dialog" aria-label="My pull requests" aria-modal="false" aria-hidden={!open} inert={!open}>
          <PullRequestsList host={host} visible={open} close={close} />
        </aside>, document.querySelector('.shell-kernel') ?? document.body,
      )}
    </>
  )
}

const pullRequestsClient: BrowserPlugin = (ctx) => {
  ctx.clientUi.registerRoot(ctx, 'pull-requests-chrome', () => <PullRequestsChrome host={ctx.clientHost} ui={ctx.clientUi} />)
  ctx.clientUi.registerStyle(ctx, 'pull-requests', String(styles))
  return () => ctx.clientUi.overlays.close(PR_PANEL)
}
pullRequestsClient.inject = ['clientHost', 'clientUi']
pullRequestsClient.resources = { requires: { extensions: [PR_REFRESH] }, provides: { roots: ['pull-requests-chrome'] } }
export default pullRequestsClient
