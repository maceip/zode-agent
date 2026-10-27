import { describe, expect, it, vi } from 'vitest'
import {
  checkDetails,
  checkState,
  parseGitPullRequest,
  readPullRequestsForRepository,
} from '../program/plugins/git-support.js'
import { parseGitSupportSnapshot } from '../program/plugins/git-support.client.js'
import type { ProcessRunnerService } from '../program/plugins/process-runner-api.js'

function rawPullRequest(number = 42, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Feature ${number}`,
    url: `https://github.com/example/repo/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    headRefName: `feature-${number}`,
    baseRefName: 'main',
    ...overrides,
  }
}

function nativeStack() {
  return {
    id: 'stack-node-id',
    number: 7,
    baseRefName: 'main',
    size: 3,
    entries: {
      nodes: [
        { position: 3, pullRequest: rawPullRequest(44) },
        { position: 1, pullRequest: rawPullRequest(42, { state: 'MERGED' }) },
        { position: 2, pullRequest: rawPullRequest(43, {
          statusCheckRollup: {
            state: 'FAILURE',
            contexts: { totalCount: 1, nodes: [
              { name: 'unit tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/run/1' },
            ] },
          },
        }) },
      ],
    },
  }
}

function processRunner(...responses: Array<unknown | Error>) {
  const execFile = vi.fn(async () => {
    const response = responses.shift()
    if (response instanceof Error) throw response
    return { stdout: JSON.stringify(response), stderr: '' }
  })
  return { runner: { execFile } as ProcessRunnerService, execFile }
}

describe('GitHub pull request context', () => {
  it('uses native stack positions and carries member PR links and CI details', () => {
    const parsed = parseGitPullRequest(rawPullRequest(43, { stack: nativeStack() }))
    expect(parsed?.stack).toMatchObject({ id: 'stack-node-id', number: 7, baseBranch: 'main', size: 3 })
    expect(parsed?.stack?.entries.map((entry) => [entry.position, entry.pullRequest.number]))
      .toEqual([[1, 42], [2, 43], [3, 44]])
    expect(parsed?.stack?.entries[1]?.pullRequest).toMatchObject({
      url: 'https://github.com/example/repo/pull/43',
      checks: 'failing',
      checkDetails: [{ name: 'unit tests', state: 'failing', url: 'https://ci.example/run/1' }],
    })
  })

  it('does not invent stack membership from a PR targeting another feature branch', () => {
    expect(parseGitPullRequest(rawPullRequest(43, { baseRefName: 'feature-42', stack: null }))?.stack)
      .toBeUndefined()
  })

  it('uses the complete rollup for aggregate status when the detail page is partial', () => {
    const parsed = parseGitPullRequest(rawPullRequest(42, {
      statusCheckRollup: {
        state: 'FAILURE',
        contexts: { totalCount: 130, nodes: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
      },
    }))
    expect(parsed).toMatchObject({ checks: 'failing', checkCount: 130, checkDetails: [{ name: 'build', state: 'passing' }] })
  })

  it('normalizes both check runs and external commit statuses without fabricating successful checks', () => {
    expect(checkDetails([
      { name: 'build', status: 'IN_PROGRESS', detailsUrl: 'https://ci.example/build' },
      { context: 'Buildkite', state: 'ERROR', description: 'Build failed', targetUrl: 'https://ci.example/failure' },
      { name: 'optional job', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { name: 'unknown job', status: 'COMPLETED', conclusion: null },
      null,
    ])).toEqual([
      { name: 'build', state: 'pending', description: 'in progress', url: 'https://ci.example/build' },
      { name: 'Buildkite', state: 'failing', description: 'Build failed', url: 'https://ci.example/failure' },
      { name: 'optional job', state: 'passing', description: 'skipped' },
    ])
    expect(checkState([null, {}, { name: 'unknown job' }])).toBeUndefined()
    expect(checkState([{ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }])).toBe('failing')
    expect(parseGitPullRequest(rawPullRequest(42, { statusCheckRollup: null }))?.checks).toBeUndefined()
  })

  it('queries the configured GitHub host and binds branch names as GraphQL variables', async () => {
    const { runner, execFile } = processRunner({ data: { repository: { pullRequests: {
      nodes: [rawPullRequest(43, { stack: nativeStack() })],
    } } } })
    const pullRequests = await readPullRequestsForRepository(runner, 'github.example.com/team/repo', 'jm/feature', '/repo')
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile).toHaveBeenCalledWith('gh', expect.arrayContaining([
      'api', 'graphql', '--hostname', 'github.example.com',
      'owner=team', 'name=repo', 'branch=jm/feature',
    ]), expect.objectContaining({ cwd: '/repo' }))
    expect(pullRequests[0]?.stack?.size).toBe(3)
  })

  it('falls back to ordinary PR metadata and CI when the native stack API is unavailable', async () => {
    const { runner, execFile } = processRunner(new Error("Field 'stack' doesn't exist on type 'PullRequest'"), [
      rawPullRequest(42, { statusCheckRollup: [{ context: 'Buildkite', state: 'PENDING' }] }),
    ])
    const pullRequests = await readPullRequestsForRepository(runner, 'github.example.com/team/repo', 'feature-42')
    expect(execFile).toHaveBeenCalledTimes(2)
    expect(execFile).toHaveBeenLastCalledWith('gh', expect.arrayContaining(['pr', 'list', '--repo', 'github.example.com/team/repo']), expect.any(Object))
    expect(pullRequests[0]).toMatchObject({ number: 42, checks: 'pending', checkDetails: [{ name: 'Buildkite', state: 'pending' }] })
    expect(pullRequests[0]?.stack).toBeUndefined()
  })

  it('does not make a fallback request when the branch has no open PRs', async () => {
    const { runner, execFile } = processRunner({ data: { repository: { pullRequests: { nodes: [] } } } })
    expect(await readPullRequestsForRepository(runner, 'github.com/example/repo', 'main')).toEqual([])
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('leaves local state available when gh is missing, and skips detached heads', async () => {
    const { runner, execFile } = processRunner(new Error('ENOENT'), new Error('ENOENT'))
    expect(await readPullRequestsForRepository(runner, 'github.com/example/repo', 'feature')).toEqual([])
    expect(await readPullRequestsForRepository(runner, 'github.com/example/repo', 'detached@abcdef')).toEqual([])
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('preserves valid optional stack and CI data across the browser snapshot boundary', () => {
    const parsed = parseGitPullRequest(rawPullRequest(43, { stack: nativeStack() }))
    const snapshot = parseGitSupportSnapshot({
      version: 1,
      revision: 1,
      aliases: { '/repo': '/repo' },
      updatedAt: '2026-10-15T00:00:00Z',
      repositories: { '/repo': {
        root: '/repo', branch: 'feature-43', head: 'abc123', ahead: 0, behind: 0,
        files: [], pullRequests: [parsed], updatedAt: '2026-10-15T00:00:00Z',
      } },
    })
    expect(snapshot.repositories['/repo']?.pullRequests).toEqual([parsed])
  })

  it('drops malformed optional details without losing the PR or recursing through nested stacks', () => {
    const parsed = parseGitPullRequest(rawPullRequest(43, { stack: nativeStack() }))!
    const snapshot = parseGitSupportSnapshot({
      version: 1,
      revision: 1,
      aliases: {},
      updatedAt: '',
      repositories: { '/repo': {
        root: '/repo', branch: 'feature-43', head: 'abc123', ahead: 0, behind: 0,
        files: [], updatedAt: '', pullRequests: [{
          ...parsed,
          checkDetails: [null, { name: 'bad', state: 'banana' }, { name: 'good', state: 'pending' }],
          stack: { ...parsed.stack, entries: [{ position: 1, pullRequest: parsed }, { position: 0, pullRequest: parsed }] },
        }],
      } },
    })
    const result = snapshot.repositories['/repo']?.pullRequests[0]
    expect(result?.checkDetails).toEqual([{ name: 'good', state: 'pending' }])
    expect(result?.stack?.entries).toHaveLength(1)
    expect(result?.stack?.entries[0]?.pullRequest).not.toHaveProperty('stack')
  })
})
