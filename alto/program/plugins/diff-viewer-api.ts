import { isRecord, type JsonValue } from '../../src/shared/protocol.js'

export const DIFF_VIEWER_CREATE_METHOD = 'diff-viewer.create'
export const DIFF_VIEWER_READ_METHOD = 'diff-viewer.read'
export const DIFF_VIEWER_COMMITS_METHOD = 'diff-viewer.commits'
export const DIFF_VIEWER_PANE_KIND = 'diff-viewer'
export const DIFF_VIEWER_COMMIT_RESOURCE_PREFIX = 'commit:'

export function commitDiffResource(commit: string): string {
  const ref = commit.trim()
  if (!ref) throw new Error('A commit SHA or ref is required')
  return `${DIFF_VIEWER_COMMIT_RESOURCE_PREFIX}${encodeURIComponent(ref)}`
}

export function commitRefFromDiffResource(resource: string | undefined): string | undefined {
  if (!resource?.startsWith(DIFF_VIEWER_COMMIT_RESOURCE_PREFIX)) return undefined
  try {
    const ref = decodeURIComponent(resource.slice(DIFF_VIEWER_COMMIT_RESOURCE_PREFIX.length)).trim()
    return ref || undefined
  } catch {
    return undefined
  }
}

export interface DiffCommitSummary {
  sha: string
  shortSha: string
  subject: string
  committedAt: string
}

export function parseDiffCommitSummaries(value: JsonValue): DiffCommitSummary[] {
  if (!Array.isArray(value)) throw new Error('Alto returned an invalid commit list')
  return value.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.sha !== 'string'
      || typeof entry.shortSha !== 'string'
      || typeof entry.subject !== 'string'
      || typeof entry.committedAt !== 'string'
    ) throw new Error('Alto returned an invalid commit list')
    return {
      sha: entry.sha,
      shortSha: entry.shortSha,
      subject: entry.subject,
      committedAt: entry.committedAt,
    }
  })
}

export interface DiffReviewFileInput {
  path: string
  kind: string
  diff: string
}

export interface DiffReviewDocument {
  id: string
  title: string
  workspace: string
  threadId?: string
  patch: string
  createdAt: string
}

export interface DiffReviewReference {
  id: string
  resource: string
}

export function parseDiffReviewDocument(value: JsonValue): DiffReviewDocument {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.title !== 'string'
    || typeof value.workspace !== 'string'
    || typeof value.patch !== 'string'
    || typeof value.createdAt !== 'string'
    || (value.threadId !== undefined && typeof value.threadId !== 'string')
  ) throw new Error('Alto returned an invalid diff review')

  return {
    id: value.id,
    title: value.title,
    workspace: value.workspace,
    patch: value.patch,
    createdAt: value.createdAt,
    ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
  }
}

export function parseDiffReviewReference(value: JsonValue): DiffReviewReference {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.resource !== 'string') {
    throw new Error('Alto returned an invalid diff review reference')
  }
  return { id: value.id, resource: value.resource }
}
