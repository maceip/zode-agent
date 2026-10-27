import { describe, expect, it } from 'vitest'
import {
  checkState,
  githubRepository,
  parseGitStatus,
  preserveRemoteState,
} from '../program/plugins/git-support.js'
import {
  gitFileGroups,
  projectThreadGitState,
  threadGitBranch,
  threadGitContext,
} from '../program/plugins/git-support-ui.js'
import type { GitPullRequest, GitRepositoryState } from '../program/plugins/git-support-api.js'
import type { WorkCheckout, WorkTarget } from '../program/plugins/work-contexts-api.js'
import type { ClientWorkContextsService } from '../program/plugins/work-contexts-client-api.js'
import type { ThreadSummary } from '../src/shared/protocol.js'

describe('Git support', () => {
  it('parses staged, modified, untracked, and renamed files from porcelain output', () => {
    const files = parseGitStatus([
      'M  staged.ts',
      ' M modified.ts',
      'MM both.ts',
      '?? new.ts',
      'R  renamed.ts',
      'old.ts',
      '',
    ].join('\0'))

    expect(files).toEqual([
      { path: 'both.ts', indexStatus: 'M', worktreeStatus: 'M' },
      { path: 'modified.ts', indexStatus: ' ', worktreeStatus: 'M' },
      { path: 'new.ts', indexStatus: '?', worktreeStatus: '?' },
      { path: 'renamed.ts', indexStatus: 'R', worktreeStatus: ' ', previousPath: 'old.ts' },
      { path: 'staged.ts', indexStatus: 'M', worktreeStatus: ' ' },
    ])

    const groups = gitFileGroups({
      root: '/repo',
      branch: 'main',
      head: 'abc1234',
      ahead: 0,
      behind: 0,
      files,
      pullRequests: [],
      updatedAt: new Date(0).toISOString(),
    })
    expect(groups.staged.map((file) => file.path)).toEqual(['both.ts', 'renamed.ts', 'staged.ts'])
    expect(groups.modified.map((file) => file.path)).toEqual(['both.ts', 'modified.ts'])
    expect(groups.untracked.map((file) => file.path)).toEqual(['new.ts'])
  })

  it('normalizes GitHub remotes for gh', () => {
    expect(githubRepository('git@github.com:example/alto.git')).toBe('github.com/example/alto')
    expect(githubRepository('https://github.com/example/alto.git')).toBe('github.com/example/alto')
    expect(githubRepository('github.com/example/alto')).toBe('github.com/example/alto')
    expect(githubRepository('ssh://git@github.example.com/example/alto.git'))
      .toBe('github.example.com/example/alto')
  })

  it('summarizes checks with failures taking precedence over pending work', () => {
    expect(checkState([])).toBeUndefined()
    expect(checkState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('passing')
    expect(checkState([{ status: 'IN_PROGRESS' }])).toBe('pending')
    expect(checkState([
      { status: 'IN_PROGRESS' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
    ])).toBe('failing')
  })

  it('keeps PR metadata across local refreshes only while the branch is unchanged', () => {
    const known = {
      root: '/repo',
      branch: 'feature',
      head: 'abc1234',
      ahead: 0,
      behind: 0,
      files: [],
      pullRequests: [{
        number: 42,
        title: 'Feature',
        url: 'https://github.com/example/repo/pull/42',
        state: 'OPEN',
        draft: false,
        headBranch: 'feature',
        baseBranch: 'main',
      }],
      updatedAt: new Date(0).toISOString(),
      remoteUpdatedAt: new Date(1).toISOString(),
    }
    const refreshed = { ...known, head: 'def5678', pullRequests: [], updatedAt: new Date(2).toISOString() }

    expect(preserveRemoteState(refreshed, known).pullRequests).toEqual(known.pullRequests)
    expect(preserveRemoteState({ ...refreshed, branch: 'main' }, known).pullRequests).toEqual([])
  })

  it('uses the branch captured by App Server unless Alto explicitly retargeted the chat', () => {
    const thread: ThreadSummary = {
      id: 'thread-1',
      title: 'Review supply chain security',
      preview: '',
      cwd: '/repo',
      createdAt: 1,
      updatedAt: 2,
      gitInfo: { branch: 'jm/supply-chain-security' },
    }
    const contexts = (branch?: string): ClientWorkContextsService => ({
      localCheckoutForPath: () => undefined,
      snapshot: () => ({ workstreams: [] }),
      targetForThread: () => branch ? ({ kind: 'cloud', branch } as never) : undefined,
    } as unknown as ClientWorkContextsService)

    expect(threadGitBranch(thread, contexts())).toBe('jm/supply-chain-security')
    expect(threadGitBranch(thread, contexts('jm/retargeted'))).toBe('jm/retargeted')
  })

  it('projects a remote work target without borrowing local checkout state', () => {
    const thread: ThreadSummary = {
      id: 'thread-1',
      title: 'Remote feature',
      preview: '',
      cwd: '/repo',
      createdAt: 1,
      updatedAt: 2,
      projectId: 'project-1',
      gitInfo: { branch: 'main', sha: 'local-head' },
    }
    const local: WorkCheckout = {
      id: 'local-main',
      kind: 'local',
      projectId: 'project-1',
      branch: 'main',
      label: 'repo',
      location: '/repo',
      repository: 'github.com/example/alto',
      head: 'local-head',
      dirty: true,
    }
    const target: WorkTarget = {
      id: 'cloud-feature',
      checkoutId: 'cloud-feature',
      kind: 'cloud',
      projectId: 'project-1',
      branch: 'jm/remote-feature',
      label: 'alto-jm-remote-feature',
      location: 'alto-jm-remote-feature',
      repository: 'github.com/example/alto',
      status: 'Starting',
      updatedAt: '2026-08-24T21:00:00.000Z',
    }
    const contexts = {
      localCheckoutForPath: () => local,
      snapshot: () => ({ workstreams: [] }),
      targetForThread: () => target,
    } as unknown as ClientWorkContextsService
    const context = threadGitContext(thread, contexts)
    const localState: GitRepositoryState = {
      root: '/repo',
      branch: 'main',
      head: 'local-head',
      ahead: 3,
      behind: 1,
      files: [{ path: 'local-only.ts', indexStatus: 'M', worktreeStatus: ' ' }],
      pullRequests: [],
      updatedAt: '2026-08-24T20:00:00.000Z',
    }
    const remotePullRequest: GitPullRequest = {
      number: 42,
      title: 'Remote feature',
      url: 'https://github.com/example/alto/pull/42',
      state: 'OPEN',
      draft: false,
      headBranch: 'jm/remote-feature',
      baseBranch: 'main',
    }
    const projected = projectThreadGitState(context, localState, {
      branch: 'jm/remote-feature',
      repository: 'github.com/example/alto',
      pullRequests: [remotePullRequest],
      updatedAt: '2026-08-24T21:01:00.000Z',
    })

    expect(context).toMatchObject({
      kind: 'remote',
      location: '/repo',
      branch: 'jm/remote-feature',
      repository: 'github.com/example/alto',
      provider: 'cloud',
      status: 'Starting',
    })
    expect(projected.branchOnly).toBe(true)
    expect(projected.state).toMatchObject({
      branch: 'jm/remote-feature',
      head: '',
      ahead: 0,
      behind: 0,
      files: [],
      pullRequests: [remotePullRequest],
    })
  })
})
