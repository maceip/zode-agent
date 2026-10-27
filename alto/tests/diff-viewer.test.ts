import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { parsePatchFiles } from '@pierre/diffs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  branchDiffDocument,
  buildReviewPatch,
  commitDiffDocument,
  recentCommits,
  readDiffReview,
  repairLegacyReviewPatch,
  storeDiffReview,
  workingTreePatch,
} from '../program/plugins/diff-viewer.js'
import {
  commitDiffResource,
  commitRefFromDiffResource,
  type DiffReviewDocument,
} from '../program/plugins/diff-viewer-api.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('diff viewer', () => {
  it('turns app-server file hunks into a Pierre-compatible multi-file patch', () => {
    const workspace = '/tmp/project'
    const patch = buildReviewPatch([
      {
        path: '/tmp/project/src/hello world.ts',
        kind: 'update',
        diff: '@@ -1,2 +1,2 @@\n-old\n+new\n context',
      },
      {
        path: '/tmp/project/src/new.ts',
        kind: 'add',
        diff: '@@ -0,0 +1 @@\n+export {}',
      },
    ], workspace)

    const files = parsePatchFiles(patch, 'test', true).flatMap((entry) => entry.files)
    expect(files.map((file) => file.name)).toEqual(['src/hello world.ts', 'src/new.ts'])
    expect(files[0]?.hunks[0]).toMatchObject({ additionLines: 1, deletionLines: 1 })
    expect(files[1]).toMatchObject({ type: 'new' })
    expect(files[1]?.hunks[0]).toMatchObject({ additionLines: 1, deletionLines: 0 })
  })

  it('keeps file headers supplied by app-server without duplicating them', () => {
    const patch = buildReviewPatch([{
      path: '/tmp/project/src/a.ts',
      kind: 'update',
      diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
    }], '/tmp/project')

    expect(patch.match(/^--- /gmu)).toHaveLength(1)
    expect(patch.match(/^\+\+\+ /gmu)).toHaveLength(1)
    expect(parsePatchFiles(patch, 'test', true)[0]?.files[0]?.name).toBe('src/a.ts')
  })

  it('preserves a trailing blank context line in an app-server hunk', () => {
    const patch = buildReviewPatch([{
      path: '/tmp/project/src/a.ts',
      kind: 'update',
      diff: '@@ -1,2 +1,2 @@\n-old package\n+new package\n \n',
    }], '/tmp/project')

    const file = parsePatchFiles(patch, 'test', true)[0]?.files[0]
    expect(file?.hunks[0]).toMatchObject({ additionLines: 1, deletionLines: 1 })
  })

  it('turns App Server add and delete contents into unified diff hunks', () => {
    const patch = buildReviewPatch([{
      path: '/tmp/project/src/new.ts',
      kind: 'add',
      diff: 'export const value = 1\nexport default value',
    }, {
      path: '/tmp/project/src/old.ts',
      kind: 'delete',
      diff: 'export const old = true',
    }], '/tmp/project')

    const files = parsePatchFiles(patch, 'test', true).flatMap((entry) => entry.files)
    expect(files.map((file) => file.name)).toEqual(['src/new.ts', 'src/old.ts'])
    expect(files[0]).toMatchObject({ type: 'new' })
    expect(files[0]?.hunks[0]).toMatchObject({ additionLines: 2, deletionLines: 0 })
    expect(files[1]).toMatchObject({ type: 'deleted' })
    expect(files[1]?.hunks[0]).toMatchObject({ additionLines: 0, deletionLines: 1 })
  })

  it('repairs stored snapshots that treated added-file contents as an update diff', () => {
    const legacy = [
      'diff --git a/new.ts b/new.ts',
      '--- a/new.ts',
      '+++ b/new.ts',
      'export const value = 1',
      'export default value',
    ].join('\n')
    const patch = repairLegacyReviewPatch(legacy)
    const file = parsePatchFiles(patch, 'test', true)[0]?.files[0]

    expect(file).toMatchObject({ name: 'new.ts', type: 'new' })
    expect(file?.hunks[0]).toMatchObject({ additionLines: 2, deletionLines: 0 })
  })

  it('stores immutable review snapshots behind opaque resource ids', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-diff-reviews-'))
    roots.push(root)
    const document: DiffReviewDocument = {
      id: '4bdf3d32-9d83-4bb8-b836-d599e3ffc465',
      title: 'Review changes',
      workspace: '/tmp/project',
      threadId: 'thread-1',
      patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
      createdAt: '2026-08-22T20:00:00.000Z',
    }

    await expect(storeDiffReview(root, document)).resolves.toEqual({
      id: document.id,
      resource: `review:${document.id}`,
    })
    await expect(readDiffReview(root, `review:${document.id}`)).resolves.toEqual(document)
    await expect(readDiffReview(root, '../outside')).rejects.toThrow('invalid diff review resource')
  })

  it('rejects review snapshots above the configured limit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-diff-reviews-'))
    roots.push(root)
    await expect(storeDiffReview(root, {
      id: '4bdf3d32-9d83-4bb8-b836-d599e3ffc465',
      title: 'Large review',
      workspace: '/tmp/project',
      patch: 'too large',
      createdAt: '2026-08-22T20:00:00.000Z',
    }, 2)).rejects.toThrow('limited')
  })

  it('includes tracked and untracked working-tree changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-live-diff-'))
    roots.push(root)
    await execFileAsync('git', ['-C', root, 'init', '--quiet'])
    await writeFile(path.join(root, 'tracked.txt'), 'before\n')
    await execFileAsync('git', ['-C', root, 'add', 'tracked.txt'])
    await execFileAsync('git', [
      '-C', root,
      '-c', 'user.name=Alto Tests',
      '-c', 'user.email=alto@example.com',
      'commit', '--quiet', '-m', 'initial',
    ])
    await writeFile(path.join(root, 'tracked.txt'), 'after\n')
    await writeFile(path.join(root, 'new file.txt'), 'new\n')

    const patch = await workingTreePatch(root, 1024 * 1024)
    const files = parsePatchFiles(patch, 'live', true).flatMap((entry) => entry.files)

    expect(files.map((file) => file.name)).toEqual(['tracked.txt', 'new file.txt'])
    expect(files[0]?.hunks[0]).toMatchObject({ additionLines: 1, deletionLines: 1 })
    expect(files[1]).toMatchObject({ type: 'new' })
  })

  it('renders the patch introduced by a specific commit without including later working-tree changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-commit-diff-'))
    roots.push(root)
    await execFileAsync('git', ['-C', root, 'init', '--quiet'])
    await writeFile(path.join(root, 'tracked.txt'), 'before\n')
    await execFileAsync('git', ['-C', root, 'add', 'tracked.txt'])
    await execFileAsync('git', [
      '-C', root,
      '-c', 'user.name=Alto Tests',
      '-c', 'user.email=alto@example.com',
      'commit', '--quiet', '-m', 'initial',
    ])
    await writeFile(path.join(root, 'tracked.txt'), 'committed\n')
    await execFileAsync('git', ['-C', root, 'add', 'tracked.txt'])
    await execFileAsync('git', [
      '-C', root,
      '-c', 'user.name=Alto Tests',
      '-c', 'user.email=alto@example.com',
      'commit', '--quiet', '-m', 'change tracked file',
    ])
    const commit = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(path.join(root, 'tracked.txt'), 'uncommitted\n')

    const document = await commitDiffDocument(root, 'HEAD', 1024 * 1024, 'thread-1')
    const file = parsePatchFiles(document.patch, document.id, true)[0]?.files[0]

    expect(document).toMatchObject({
      id: `commit-${commit}`,
      title: expect.stringContaining('change tracked file'),
      workspace: root,
      threadId: 'thread-1',
    })
    expect(file?.name).toBe('tracked.txt')
    expect(document.patch).toContain('+committed')
    expect(document.patch).not.toContain('uncommitted')
  })

  it('renders every branch commit since the origin/main merge base', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-branch-diff-'))
    roots.push(root)
    await execFileAsync('git', ['-C', root, 'init', '--quiet'])
    await writeFile(path.join(root, 'first.txt'), 'base\n')
    await execFileAsync('git', ['-C', root, 'add', 'first.txt'])
    await execFileAsync('git', [
      '-C', root,
      '-c', 'user.name=Alto Tests',
      '-c', 'user.email=alto@example.com',
      'commit', '--quiet', '-m', 'base',
    ])
    await execFileAsync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
    await execFileAsync('git', ['-C', root, 'checkout', '--quiet', '-b', 'feature'])

    await writeFile(path.join(root, 'first.txt'), 'from first branch commit\n')
    await execFileAsync('git', ['-C', root, 'add', 'first.txt'])
    await execFileAsync('git', [
      '-C', root,
      '-c', 'user.name=Alto Tests',
      '-c', 'user.email=alto@example.com',
      'commit', '--quiet', '-m', 'change first file',
    ])
    await writeFile(path.join(root, 'second.txt'), 'from second branch commit\n')
    await execFileAsync('git', ['-C', root, 'add', 'second.txt'])
    await execFileAsync('git', [
      '-C', root,
      '-c', 'user.name=Alto Tests',
      '-c', 'user.email=alto@example.com',
      'commit', '--quiet', '-m', 'add second file',
    ])
    await writeFile(path.join(root, 'first.txt'), 'uncommitted\n')

    const document = await branchDiffDocument(root, 1024 * 1024, 'thread-1')
    const files = parsePatchFiles(document.patch, document.id, true).flatMap((entry) => entry.files)

    expect(document).toMatchObject({
      id: expect.stringMatching(/^branch-/u),
      title: 'feature against origin/main',
      workspace: root,
      threadId: 'thread-1',
    })
    expect(files.map((file) => file.name)).toEqual(['first.txt', 'second.txt'])
    expect(document.patch).toContain('from first branch commit')
    expect(document.patch).toContain('from second branch commit')
    expect(document.patch).not.toContain('uncommitted')
  })

  it('round-trips commit refs through persisted diff pane resources', () => {
    expect(commitRefFromDiffResource(commitDiffResource('HEAD~2'))).toBe('HEAD~2')
    expect(commitRefFromDiffResource('review:123')).toBeUndefined()
  })

  it('lists the 10 most recent commits for the picker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-recent-commits-'))
    roots.push(root)
    await execFileAsync('git', ['-C', root, 'init', '--quiet'])
    for (let index = 0; index < 12; index += 1) {
      await execFileAsync('git', [
        '-C', root,
        '-c', 'user.name=Alto Tests',
        '-c', 'user.email=alto@example.com',
        'commit', '--quiet', '--allow-empty', '-m', `commit ${index}`,
      ])
    }

    const commits = await recentCommits(root)

    expect(commits).toHaveLength(10)
    expect(commits.map((commit) => commit.subject)).toEqual([
      'commit 11',
      'commit 10',
      'commit 9',
      'commit 8',
      'commit 7',
      'commit 6',
      'commit 5',
      'commit 4',
      'commit 3',
      'commit 2',
    ])
    expect(commits.every((commit) => /^[0-9a-f]+$/u.test(commit.shortSha))).toBe(true)
  })
})
