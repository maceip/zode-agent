import { describe, expect, it } from 'vitest'
import type {
  LocalProject,
  ThreadSummary,
} from '../src/shared/protocol.js'
import {
  groupThreadsByProject,
  OTHER_PROJECT_ID,
  projectForWorkspace,
  threadHistoryTitle,
  withThreadTitle,
} from '../program/plugins/ui/history.js'

function project(id: string, primaryRoot: string, roots = [primaryRoot]): LocalProject {
  return { id, name: id, primaryRoot, roots }
}

function thread(
  id: string,
  cwd: string,
  updatedAt: number,
  projectId?: string,
): ThreadSummary {
  return {
    id,
    title: id,
    preview: id,
    cwd,
    createdAt: updatedAt,
    updatedAt,
    ...(projectId ? { projectId } : {}),
  }
}

describe('project history groups', () => {
  it('matches workspaces under any attached project folder', () => {
    const projects = [
      project('atlas', '/work/atlas', ['/work/atlas', '/work/atlas-docs']),
      project('nested', '/work/atlas/packages/app'),
    ]

    expect(projectForWorkspace(projects, '/work/atlas-docs/guides')?.id).toBe('atlas')
    expect(projectForWorkspace(projects, '/work/atlas/packages/app/src')?.id).toBe('nested')
    expect(projectForWorkspace(projects, '/work/unrelated')).toBeUndefined()
  })

  it('keeps registry order and combines unmatched tasks', () => {
    const projects = [project('atlas', '/work/atlas'), project('beacon', '/work/beacon')]
    const groups = groupThreadsByProject([
      thread('atlas-old', '/work/atlas', 10, 'atlas'),
      thread('unmatched', '/tmp/scratch', 30),
      thread('atlas-new', '/work/atlas', 20, 'atlas'),
    ], projects)

    expect(groups.map((group) => group.id)).toEqual(['atlas', 'beacon', OTHER_PROJECT_ID])
    expect(groups.find((group) => group.id === 'atlas')?.entries.map((entry) => entry.id)).toEqual([
      'atlas-new',
      'atlas-old',
    ])
    expect(groups.find((group) => group.id === OTHER_PROJECT_ID)?.entries[0]?.id).toBe('unmatched')
    expect(groups.find((group) => group.id === OTHER_PROJECT_ID)?.label).toBe('Recents')
  })

  it('keeps registered projects visible before they have chats', () => {
    const projects = [project('new-project', '/work/new-project')]
    const groups = groupThreadsByProject([], projects)

    expect(groups).toEqual([{
      id: 'new-project',
      label: 'new-project',
      project: projects[0],
      entries: [],
      updatedAt: 0,
    }])
  })

  it('applies an app-server semantic title without rebuilding the list', () => {
    const entries = [thread('thread-1', '/work/project', 10)]

    expect(withThreadTitle(entries, 'thread-1', 'Fix sidebar hover state')).toEqual([{
      ...entries[0],
      title: 'Fix sidebar hover state',
    }])
    expect(withThreadTitle(entries, 'missing', 'Ignored')).toBe(entries)
  })

  it('uses the preview as the sidebar label only when a chat has no generated name', () => {
    expect(threadHistoryTitle({
      title: 'Untitled conversation',
      preview: 'Review the authentication changes\nwith extra context',
    })).toBe('Review the authentication changes')
    expect(threadHistoryTitle({
      title: 'Authentication review',
      preview: 'Review the authentication changes',
    })).toBe('Authentication review')
  })

  it('keeps unnamed sidebar labels compact', () => {
    const preview = 'A'.repeat(100)

    expect(threadHistoryTitle({ title: 'Untitled conversation', preview }))
      .toBe(`${'A'.repeat(71)}…`)
  })
})
