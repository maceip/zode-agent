import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PullRequestRow,
  relativeAge,
  workspaceOverviewModel,
} from '../program/plugins/workspace-overview.client.js'
import type { GitSupportSnapshot } from '../program/plugins/git-support-api.js'
import type { WorkContextSnapshot } from '../program/plugins/work-contexts-api.js'
import type { ThreadSummary } from '../src/shared/protocol.js'

function chat(
  id: string,
  branch: string,
  updatedAt: number,
): ThreadSummary {
  return {
    id,
    title: `Chat ${id}`,
    preview: `Working on ${branch}`,
    cwd: `/repo/${branch}`,
    createdAt: updatedAt - 10,
    updatedAt,
    projectId: 'project-one',
    gitInfo: { branch },
  }
}

describe('workspace overview', () => {
  it('groups recent work by branch and prioritizes active work', () => {
    const contexts: WorkContextSnapshot = {
      version: 1,
      revision: 1,
      updatedAt: '2026-08-31T18:00:00Z',
      providers: [{
        id: 'remote',
        label: 'Remote',
        supportsExistingTarget: true,
        supportsBranchTarget: true,
      }],
      threadTargets: {},
      workstreams: [{
        id: 'main',
        projectId: 'project-one',
        name: 'main',
        branch: 'main',
        checkouts: [{
          id: 'primary',
          kind: 'local',
          projectId: 'project-one',
          branch: 'main',
          label: 'codex-cordis',
          location: '/repo/main',
          primary: true,
        }, {
          id: 'main-worktree',
          kind: 'local',
          projectId: 'project-one',
          branch: 'main',
          label: 'main-worktree',
          location: '/repo/main-worktree',
        }, {
          id: 'remote-run',
          kind: 'remote',
          projectId: 'project-one',
          branch: 'main',
          label: 'ui-audit',
          location: 'remote://ui-audit',
          status: 'Running',
          statusTone: 'progress',
        }],
      }, {
        id: 'feature',
        projectId: 'project-one',
        name: 'feature/sidebar',
        branch: 'feature/sidebar',
        checkouts: [{
          id: 'feature-worktree',
          kind: 'local',
          projectId: 'project-one',
          branch: 'feature/sidebar',
          label: 'sidebar',
          location: '/repo/sidebar',
        }],
      }],
    }
    const git: GitSupportSnapshot = {
      version: 1,
      revision: 1,
      aliases: { '/repo/main': '/repo/main' },
      repositories: {
        '/repo/main': {
          root: '/repo/main',
          branch: 'main',
          head: 'abc123',
          ahead: 0,
          behind: 0,
          files: [],
          updatedAt: '2026-08-31T18:00:00Z',
          pullRequests: [{
            number: 10,
            title: 'Main cleanup',
            url: 'https://example.com/pr/10',
            state: 'OPEN',
            draft: false,
            headBranch: 'main',
            baseBranch: 'trunk',
          }],
        },
      },
      updatedAt: '2026-08-31T18:00:00Z',
    }

    const model = workspaceOverviewModel({
      workspace: '/repo/main',
      projectId: 'project-one',
      threads: [chat('main-chat', 'main', 1_700_000_000), chat('feature-chat', 'feature/sidebar', 1_700_000_100)],
      contexts,
      git,
      branches: {},
      providers: contexts.providers,
      threadStatus: { revision: 1, running: ['main-chat'], finished: [] },
    })

    expect(model.branches.map((branch) => branch.name)).toEqual(['main', 'feature/sidebar'])
    expect(model.branches[0]).toMatchObject({
      running: true,
      chats: [{ id: 'main-chat' }],
      pullRequests: [{ number: 10 }],
    })
    expect(model.recentChats.map(({ thread, branch, running }) => ({
      id: thread.id,
      branch,
      running,
    }))).toEqual([
      { id: 'feature-chat', branch: 'feature/sidebar', running: false },
      { id: 'main-chat', branch: 'main', running: true },
    ])
    expect(model).toMatchObject({
      branchCount: 2,
      worktreeCount: 2,
      pullRequestCount: 1,
      runCount: 1,
      chatCount: 2,
      runningCount: 1,
    })
  })

  it('formats recent activity without exposing raw timestamps', () => {
    const now = Date.parse('2026-08-31T18:00:00Z')
    expect(relativeAge(now - 20_000, now)).toBe('Just now')
    expect(relativeAge(now - 12 * 60_000, now)).toBe('12m ago')
    expect(relativeAge(now - 3 * 60 * 60_000, now)).toBe('3h ago')
  })

  it('links pull requests to their external review page', () => {
    const html = renderToStaticMarkup(PullRequestRow({
      request: {
        number: 42,
        title: 'Workspace overview',
        url: 'https://github.com/example/alto/pull/42',
        state: 'OPEN',
        draft: false,
        headBranch: 'overview',
        baseBranch: 'main',
      },
    }))

    expect(html).toContain('href="https://github.com/example/alto/pull/42"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer"')
  })
})
