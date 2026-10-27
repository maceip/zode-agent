import { describe, expect, it } from 'vitest'
import {
  diffReviewPaneRequest,
  diffReviewItems,
  openDiffReview,
  reviewPrompt,
  type DiffReviewOverlayRequest,
  type ReviewComment,
} from '../program/plugins/diff-viewer.client.js'
import { sendReviewComments } from '../program/plugins/diff-review-comments.js'
import { openGitDiffPane } from '../program/plugins/git-pane-status.client.js'
import type { DiffReviewDocument } from '../program/plugins/diff-viewer-api.js'

const document: DiffReviewDocument = {
  id: 'review-1',
  title: 'Review changes',
  workspace: '/tmp/project',
  threadId: 'thread-1',
  patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
  createdAt: '2026-08-22T20:00:00.000Z',
}

describe('diff viewer client', () => {
  it('attaches a review comment to the selected Pierre diff line', () => {
    const itemId = `${document.id}:0:0`
    const comment: ReviewComment = {
      id: 'comment-1',
      itemId,
      path: 'a.ts',
      side: 'additions',
      start: 1,
      end: 1,
      body: 'Keep the old behavior here.',
      createdAt: '2026-08-22T20:01:00.000Z',
    }

    expect(diffReviewItems(document, [comment], 1)[0]).toMatchObject({
      id: itemId,
      annotations: [{
        side: 'additions',
        lineNumber: 1,
        metadata: comment,
      }],
    })
  })

  it('shares annotations by file path across Diff Review and Code Tour item ids', () => {
    const comment: ReviewComment = {
      id: 'comment-1',
      itemId: 'tour-stop:0:a.ts',
      path: 'a.ts',
      side: 'additions',
      start: 1,
      end: 1,
      body: 'Keep the old behavior here.',
      createdAt: '2026-08-22T20:01:00.000Z',
    }

    expect(diffReviewItems(document, [comment], 1)[0]).toMatchObject({
      annotations: [{ metadata: comment }],
    })
  })

  it('turns comments into a concrete chat review request', () => {
    const comment: ReviewComment = {
      id: 'comment-1',
      itemId: `${document.id}:0:0`,
      path: 'src/a.ts',
      side: 'deletions',
      start: 4,
      end: 6,
      body: 'Preserve this validation.',
      createdAt: '2026-08-22T20:01:00.000Z',
    }

    expect(reviewPrompt([comment])).toContain('`src/a.ts:4-6` (old lines 4–6)')
    expect(reviewPrompt([comment])).toContain('Preserve this validation.')
  })

  it('opens a review snapshot over the chat without creating a pane', async () => {
    const calls: unknown[] = []
    const overlays: DiffReviewOverlayRequest[] = []
    const session = {
      snapshot: () => ({
        session: { workspace: '/tmp/project' },
        threadId: 'thread-1',
        activeProjectId: 'project-1',
      }),
    }
    const host = {
      call: async (method: string, payload: unknown) => {
        calls.push({ method, payload })
        return { id: 'review-1', resource: 'review:review-1' }
      },
    }
    const layout = {
      paneTargets: () => [{
        workspaceId: 'workspace-1',
        paneId: 'pane-1',
        focused: true,
        session,
      }],
    }
    const overlay = {
      open: (request: DiffReviewOverlayRequest) => overlays.push(request),
    }

    await openDiffReview('activity-1', [{
      path: '/tmp/project/a.ts',
      kind: 'update',
      diff: '@@ -1 +1 @@\n-old\n+new',
      additions: 1,
      deletions: 1,
    }], session as never, host as never, layout as never, overlay)

    expect(calls).toEqual([{
      method: 'diff-viewer.create',
      payload: {
        title: 'Review changes',
        workspace: '/tmp/project',
        threadId: 'thread-1',
        activityId: 'activity-1',
        files: [{
          path: '/tmp/project/a.ts',
          kind: 'update',
          diff: '@@ -1 +1 @@\n-old\n+new',
        }],
      },
    }])
    expect(overlays).toEqual([{
      activityId: 'activity-1',
      reviewId: 'review-1',
      resource: 'review:review-1',
      workspace: '/tmp/project',
      workspaceId: 'workspace-1',
      anchorPaneId: 'pane-1',
      threadId: 'thread-1',
      projectId: 'project-1',
    }])
    expect(diffReviewPaneRequest(overlays[0]!)).toEqual({
      direction: 'horizontal',
      kind: 'diff-viewer',
      resource: 'review:review-1',
      anchorThreadId: 'thread-1',
      workspace: '/tmp/project',
      projectId: 'project-1',
    })
  })

  it('sends tour comments to the thread that opened the review', async () => {
    const submitted: unknown[] = []
    const focused: string[] = []
    const sent: unknown[] = []
    const origin = {
      snapshot: () => ({ threadId: 'thread-1', turn: { tag: 'idle' } }),
      send: async (draft: unknown) => { sent.push(draft) },
      steer: async () => undefined,
    }
    const other = {
      snapshot: () => ({ threadId: 'thread-2', turn: { tag: 'idle' } }),
      send: async () => undefined,
      steer: async () => undefined,
    }
    const layout = {
      paneTargets: () => [
        { workspaceId: 'workspace-1', paneId: 'origin-pane', focused: false, session: origin },
        { workspaceId: 'workspace-1', paneId: 'tour-pane', focused: true, session: other },
      ],
      focusPane: (_workspaceId: string, paneId: string) => { focused.push(paneId); return true },
    }
    const ui = {
      submit: async (draft: unknown, next: () => Promise<void>, request: unknown) => {
        submitted.push({ draft, request })
        await next()
      },
    }
    const comment: ReviewComment = {
      id: 'comment-1',
      itemId: 'tour-stop:0:a.ts',
      path: 'a.ts',
      side: 'additions',
      start: 1,
      end: 1,
      body: 'Please keep this guard.',
      createdAt: '2026-08-22T20:01:00.000Z',
    }

    await sendReviewComments(ui as never, layout as never, document, 'workspace-1', [comment])

    expect(submitted).toEqual([expect.objectContaining({
      request: expect.objectContaining({
        mode: 'queue',
        target: expect.objectContaining({ threadId: 'thread-1' }),
      }),
    })])
    expect(sent).toHaveLength(1)
    expect(focused).toEqual(['origin-pane'])
  })

  it('opens the selected checkout diff beside its originating chat', () => {
    const panes: unknown[] = []
    const thread = {
      id: 'thread-1',
      title: 'Fix the parser',
      preview: 'Fix the parser',
      cwd: '/tmp/project-worktree',
      createdAt: 1,
      updatedAt: 2,
    }

    openGitDiffPane({
      openPane: (request: unknown) => {
        panes.push(request)
        return { workspaceId: 'workspace-1', paneId: 'pane-2' }
      },
    }, '/tmp/project-worktree', thread.id, thread, 'project-1')

    expect(panes).toEqual([{
      direction: 'horizontal',
      kind: 'diff-viewer',
      workspace: '/tmp/project-worktree',
      anchorThreadId: 'thread-1',
      thread,
      projectId: 'project-1',
    }])
  })
})
