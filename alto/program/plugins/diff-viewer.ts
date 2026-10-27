import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { fileChangeKind, isRecord, type JsonValue } from '../../src/shared/protocol.js'
import {
  commitRefFromDiffResource,
  DIFF_VIEWER_COMMIT_RESOURCE_PREFIX,
  DIFF_VIEWER_COMMITS_METHOD,
  DIFF_VIEWER_CREATE_METHOD,
  DIFF_VIEWER_READ_METHOD,
  type DiffCommitSummary,
  type DiffReviewDocument,
  type DiffReviewFileInput,
  type DiffReviewReference,
} from './diff-viewer-api.js'
import { validateProjectWorkspace } from './workspace-files.js'

const execFileAsync = promisify(execFile)
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const MAX_FILES = 500
const RESOURCE_PATTERN = /^review:([0-9a-f-]{36})$/u
const UNIFIED_HUNK_PATTERN = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/mu

function cleanPath(value: string): string {
  return value.replace(/[\r\n]/gu, '').trim()
}

function relativeReviewPath(filePath: string, workspace: string): string {
  const cleaned = cleanPath(filePath)
  if (!cleaned) return 'changed-file'
  if (!path.isAbsolute(cleaned)) return cleaned.replace(/^\.\//u, '')
  const relative = path.relative(workspace, cleaned)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : path.basename(cleaned)
}

function quotedGitPath(value: string): string {
  return /[\s"\\]/u.test(value) ? JSON.stringify(value) : value
}

function contentHunk(content: string, added: boolean): string[] {
  const lines = content.split('\n')
  const count = lines.length
  return [
    added ? `@@ -0,0 +1,${count} @@` : `@@ -1,${count} +0,0 @@`,
    ...lines.map((line) => `${added ? '+' : '-'}${line}`),
  ]
}

function patchForFile(file: DiffReviewFileInput, workspace: string): string {
  // Remove only the transport newline. A trailing whitespace-only line can be
  // significant context in a unified diff and must survive normalization.
  const raw = file.diff.replace(/\r\n?/gu, '\n').replace(/\n$/u, '')
  if (!raw.trim()) return ''

  const name = relativeReviewPath(file.path, workspace)
  const added = file.kind === 'add' || file.kind === 'create'
  const deleted = file.kind === 'delete' || file.kind === 'remove'
  const hasHunks = UNIFIED_HUNK_PATTERN.test(raw)
  if (!added && !deleted && /^diff --git /mu.test(raw)) return raw
  const before = added ? '/dev/null' : `a/${name}`
  const after = deleted ? '/dev/null' : `b/${name}`
  const hasFileHeaders = /^--- /mu.test(raw) && /^\+\+\+ /mu.test(raw)
  return [
    `diff --git ${quotedGitPath(`a/${name}`)} ${quotedGitPath(`b/${name}`)}`,
    ...(added ? ['new file mode 100644'] : deleted ? ['deleted file mode 100644'] : []),
    ...(!hasFileHeaders ? [
      `--- ${quotedGitPath(before)}`,
      `+++ ${quotedGitPath(after)}`,
    ] : []),
    ...(added && !hasHunks
      ? contentHunk(raw, true)
      : deleted && !hasHunks
        ? contentHunk(raw, false)
        : [raw]),
  ].join('\n')
}

/** Repairs snapshots created before App Server's structured patch kind was decoded. */
export function repairLegacyReviewPatch(patch: string): string {
  return patch.split(/(?=^diff --git )/gmu).map((section) => {
    if (!section.startsWith('diff --git ') || UNIFIED_HUNK_PATTERN.test(section)) return section
    const lines = section.replace(/\n$/u, '').split('\n')
    const beforeIndex = lines.findIndex((line) => line.startsWith('--- '))
    const afterIndex = lines.findIndex((line, index) => index > beforeIndex && line.startsWith('+++ '))
    if (beforeIndex < 0 || afterIndex < 0 || afterIndex === lines.length - 1) return section
    const body = lines.slice(afterIndex + 1)
    return [
      lines[0]!,
      'new file mode 100644',
      '--- /dev/null',
      lines[afterIndex]!,
      ...contentHunk(body.join('\n'), true),
      '',
    ].join('\n')
  }).join('')
}

export function buildReviewPatch(
  files: readonly DiffReviewFileInput[],
  workspace: string,
): string {
  return files.map((file) => patchForFile(file, workspace)).filter(Boolean).join('\n')
}

function snapshotPath(root: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error('invalid diff review id')
  return path.join(root, `${id}.json`)
}

function reviewJson(document: DiffReviewDocument): JsonValue {
  return document as unknown as JsonValue
}

export async function storeDiffReview(
  root: string,
  document: DiffReviewDocument,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<DiffReviewReference> {
  if (Buffer.byteLength(document.patch, 'utf8') > maxBytes) {
    throw new Error(`Diff review is limited to ${Math.floor(maxBytes / 1024 / 1024)} MB`)
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  const destination = snapshotPath(root, document.id)
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  return { id: document.id, resource: `review:${document.id}` }
}

export async function readDiffReview(root: string, resource: string): Promise<DiffReviewDocument> {
  const match = RESOURCE_PATTERN.exec(resource)
  if (!match?.[1]) throw new Error('invalid diff review resource')
  const value: unknown = JSON.parse(await readFile(snapshotPath(root, match[1]), 'utf8'))
  if (
    !isRecord(value)
    || value.id !== match[1]
    || typeof value.title !== 'string'
    || typeof value.workspace !== 'string'
    || typeof value.patch !== 'string'
    || typeof value.createdAt !== 'string'
    || (value.threadId !== undefined && typeof value.threadId !== 'string')
  ) throw new Error('stored diff review is invalid')
  return {
    id: value.id,
    title: value.title,
    workspace: value.workspace,
    patch: repairLegacyReviewPatch(value.patch),
    createdAt: value.createdAt,
    ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
  }
}

export async function validateDiffWorkspace(
  workspace: string,
  roots: readonly string[],
): Promise<string> {
  return validateProjectWorkspace(workspace, roots)
}

function failedCommandOutput(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('stdout' in error)) return undefined
  const stdout = error.stdout
  if (typeof stdout === 'string') return stdout
  return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : undefined
}

async function untrackedFilePatch(
  workspace: string,
  file: string,
  maxBytes: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [
      'diff',
      '--no-index',
      '--no-ext-diff',
      '--no-color',
      '--binary',
      '--',
      '/dev/null',
      file,
    ], { cwd: workspace, timeout: 10_000, maxBuffer: maxBytes })
    return stdout
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) {
      return failedCommandOutput(error) ?? ''
    }
    throw error
  }
}

/** Returns the complete working-tree patch, including files Git has not tracked yet. */
export async function workingTreePatch(workspace: string, maxBytes: number): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    workspace,
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--binary',
    '--find-renames',
    'HEAD',
    '--',
  ], { timeout: 10_000, maxBuffer: maxBytes })

  const { stdout: untrackedOutput } = await execFileAsync('git', [
    '-C',
    workspace,
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ], { timeout: 10_000, maxBuffer: maxBytes })
  const untracked = untrackedOutput.split('\0').filter(Boolean)
  if (untracked.length > MAX_FILES) {
    throw new Error(`Diff review is limited to ${MAX_FILES} untracked files`)
  }

  const sections = stdout.trimEnd() ? [stdout.trimEnd()] : []
  let size = Buffer.byteLength(stdout, 'utf8')
  for (const file of untracked) {
    const patch = (await untrackedFilePatch(workspace, file, maxBytes)).trimEnd()
    if (!patch) continue
    size += Buffer.byteLength(patch, 'utf8') + 1
    if (size > maxBytes) {
      throw new Error(`Diff review is limited to ${Math.floor(maxBytes / 1024 / 1024)} MB`)
    }
    sections.push(patch)
  }
  return sections.join('\n')
}

/** Returns newest-first commit choices for the diff picker. */
export async function recentCommits(
  workspace: string,
  limit = 10,
): Promise<DiffCommitSummary[]> {
  const count = Math.min(50, Math.max(1, Math.floor(limit)))
  const { stdout } = await execFileAsync('git', [
    '-C',
    workspace,
    'log',
    '-z',
    '-n',
    String(count),
    '--format=%H%x00%h%x00%cI%x00%s',
    '--',
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 })
  const fields = stdout.split('\0')
  const commits: DiffCommitSummary[] = []
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const sha = fields[index]?.trim()
    const shortSha = fields[index + 1]?.trim()
    const committedAt = fields[index + 2]?.trim()
    const subject = fields[index + 3]?.trim()
    if (!sha || !shortSha || !committedAt || subject === undefined) continue
    commits.push({ sha, shortSha, subject, committedAt })
  }
  return commits
}

function validCommitReference(value: string): string {
  const ref = value.trim()
  if (!ref || ref.length > 240 || ref.startsWith('-') || /[\0-\x1f\x7f]/u.test(ref)) {
    throw new Error('Commit must be a valid SHA or Git ref between 1 and 240 characters')
  }
  return ref
}

async function resolveCommit(workspace: string, requested: string): Promise<string> {
  const ref = validCommitReference(requested)
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      workspace,
      'rev-parse',
      '--verify',
      `${ref}^{commit}`,
      '--',
    ], { timeout: 10_000, maxBuffer: 1024 * 1024 })
    const commit = stdout.trim()
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error('invalid resolved commit')
    return commit
  } catch {
    throw new Error(`Commit ${JSON.stringify(ref)} does not exist in this workspace`)
  }
}

async function commitPatch(
  workspace: string,
  commit: string,
  maxBytes: number,
): Promise<string> {
  const { stdout: revisionLine } = await execFileAsync('git', [
    '-C',
    workspace,
    'rev-list',
    '--parents',
    '-n',
    '1',
    commit,
    '--',
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 })
  const parent = revisionLine.trim().split(/\s+/u)[1]
  const args = parent
    ? [
        '-C',
        workspace,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--binary',
        '--find-renames',
        parent,
        commit,
        '--',
      ]
    : [
        '-C',
        workspace,
        'show',
        '--format=',
        '--no-ext-diff',
        '--no-color',
        '--binary',
        '--find-renames',
        commit,
        '--',
      ]
  try {
    const { stdout } = await execFileAsync('git', args, {
      timeout: 10_000,
      maxBuffer: maxBytes,
    })
    return stdout.trimEnd()
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ) {
      throw new Error(`Diff review is limited to ${Math.floor(maxBytes / 1024 / 1024)} MB`)
    }
    throw error
  }
}

/** Returns the immutable patch introduced by a commit relative to its first parent. */
export async function commitDiffDocument(
  workspace: string,
  requestedCommit: string,
  maxBytes: number,
  threadId?: string,
): Promise<DiffReviewDocument> {
  const ref = validCommitReference(requestedCommit)
  const commit = await resolveCommit(workspace, ref)
  const [{ stdout: metadata }, patch] = await Promise.all([
    execFileAsync('git', [
      '-C',
      workspace,
      'show',
      '-s',
      '--format=%h%x00%s%x00%cI',
      commit,
      '--',
    ], { timeout: 10_000, maxBuffer: 1024 * 1024 }),
    commitPatch(workspace, commit, maxBytes),
  ])
  const [shortCommit = commit.slice(0, 12), subject = '', committedAt = ''] = metadata
    .trimEnd()
    .split('\0')
  return {
    id: `commit-${commit}`,
    title: subject ? `${shortCommit} ${subject}` : shortCommit,
    workspace,
    patch,
    createdAt: committedAt || new Date().toISOString(),
    ...(threadId ? { threadId } : {}),
  }
}

async function branchPatch(
  workspace: string,
  mergeBase: string,
  head: string,
  maxBytes: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      workspace,
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--binary',
      '--find-renames',
      mergeBase,
      head,
      '--',
    ], { timeout: 10_000, maxBuffer: maxBytes })
    return stdout.trimEnd()
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ) {
      throw new Error(`Diff review is limited to ${Math.floor(maxBytes / 1024 / 1024)} MB`)
    }
    throw error
  }
}

/** Returns every committed change on HEAD since it diverged from origin/main. */
export async function branchDiffDocument(
  workspace: string,
  maxBytes: number,
  threadId?: string,
): Promise<DiffReviewDocument> {
  const [base, head] = await Promise.all([
    resolveCommit(workspace, 'origin/main'),
    resolveCommit(workspace, 'HEAD'),
  ])
  let mergeBase: string
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      workspace,
      'merge-base',
      base,
      head,
    ], { timeout: 10_000, maxBuffer: 1024 * 1024 })
    mergeBase = stdout.trim()
  } catch {
    throw new Error('The current branch and origin/main do not share Git history')
  }
  if (!/^[0-9a-f]{40,64}$/u.test(mergeBase)) {
    throw new Error('Git did not return a valid merge base for origin/main and HEAD')
  }

  const [patch, branchResult, timestampResult] = await Promise.all([
    branchPatch(workspace, mergeBase, head, maxBytes),
    execFileAsync('git', [
      '-C',
      workspace,
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ], { timeout: 10_000, maxBuffer: 1024 * 1024 }).catch(() => undefined),
    execFileAsync('git', [
      '-C',
      workspace,
      'show',
      '-s',
      '--format=%cI',
      head,
      '--',
    ], { timeout: 10_000, maxBuffer: 1024 * 1024 }),
  ])
  const branch = branchResult?.stdout.trim() || head.slice(0, 12)
  return {
    id: `branch-${createHash('sha256').update(`${mergeBase}\0${head}`).digest('hex').slice(0, 24)}`,
    title: `${branch} against origin/main`,
    workspace,
    patch,
    createdAt: timestampResult.stdout.trim() || new Date().toISOString(),
    ...(threadId ? { threadId } : {}),
  }
}

async function liveDiffDocument(
  workspace: string,
  maxBytes: number,
  threadId?: string,
): Promise<DiffReviewDocument> {
  return {
    id: `live-${createHash('sha256').update(workspace).digest('hex').slice(0, 20)}`,
    title: 'Working tree changes',
    workspace,
    patch: await workingTreePatch(workspace, maxBytes),
    createdAt: new Date().toISOString(),
    ...(threadId ? { threadId } : {}),
  }
}

function filesFrom(payload: Record<string, unknown>): DiffReviewFileInput[] {
  if (!Array.isArray(payload.files) || payload.files.length > MAX_FILES) {
    throw new Error(`diff-viewer.create needs at most ${MAX_FILES} files`)
  }
  return payload.files.map((file) => {
    if (
      !isRecord(file)
      || typeof file.path !== 'string'
      || typeof file.diff !== 'string'
    ) throw new Error('diff-viewer.create received an invalid file change')
    return { path: file.path, kind: fileChangeKind(file.kind), diff: file.diff }
  })
}

const diffViewer: HarnessPlugin<{ maxBytes?: number }> = (ctx, config) => {
  const configuredMax = config?.maxBytes
  const maxBytes = typeof configuredMax === 'number' && Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : DEFAULT_MAX_BYTES
  const root = path.join(homedir(), '.codex', 'attachments', 'alto', 'reviews')

  ctx.clientExtensions.registerMethod(ctx, DIFF_VIEWER_CREATE_METHOD, async (payload) => {
    if (!isRecord(payload) || typeof payload.workspace !== 'string') {
      throw new Error('diff-viewer.create needs a workspace')
    }
    const workspace = path.resolve(payload.workspace)
    const files = filesFrom(payload)
    const document: DiffReviewDocument = {
      id: randomUUID(),
      title: typeof payload.title === 'string' && payload.title.trim()
        ? payload.title.trim().slice(0, 160)
        : 'Code review',
      workspace,
      patch: buildReviewPatch(files, workspace),
      createdAt: new Date().toISOString(),
      ...(typeof payload.threadId === 'string' ? { threadId: payload.threadId } : {}),
    }
    if (!document.patch.trim()) throw new Error('There is no diff to review')
    return await storeDiffReview(root, document, maxBytes) as unknown as JsonValue
  })

  ctx.clientExtensions.registerMethod(ctx, DIFF_VIEWER_COMMITS_METHOD, async (payload) => {
    if (!isRecord(payload) || typeof payload.workspace !== 'string') {
      throw new Error('diff-viewer.commits needs a workspace')
    }
    const roots = ctx.projects.snapshot().projects.flatMap((project) => project.roots)
    const workspace = await validateDiffWorkspace(payload.workspace, roots)
    return await recentCommits(workspace, 10) as unknown as JsonValue
  })

  ctx.clientExtensions.registerMethod(ctx, DIFF_VIEWER_READ_METHOD, async (payload) => {
    if (!isRecord(payload)) throw new Error('diff-viewer.read needs a review or workspace')
    const resourceCommit = typeof payload.resource === 'string'
      ? commitRefFromDiffResource(payload.resource)
      : undefined
    if (
      typeof payload.resource === 'string'
      && payload.resource.startsWith(DIFF_VIEWER_COMMIT_RESOURCE_PREFIX)
      && !resourceCommit
    ) throw new Error('invalid commit diff resource')
    if (typeof payload.resource === 'string' && resourceCommit === undefined) {
      return reviewJson(await readDiffReview(root, payload.resource))
    }
    if (typeof payload.workspace !== 'string') {
      throw new Error('diff-viewer.read needs a review resource or workspace')
    }
    const roots = ctx.projects.snapshot().projects.flatMap((project) => project.roots)
    const workspace = await validateDiffWorkspace(payload.workspace, roots)
    if (payload.comparison !== undefined && payload.comparison !== 'branch') {
      throw new Error('diff-viewer.read received an invalid comparison')
    }
    if (payload.comparison === 'branch') {
      return reviewJson(await branchDiffDocument(
        workspace,
        maxBytes,
        typeof payload.threadId === 'string' ? payload.threadId : undefined,
      ))
    }
    const requestedCommit = typeof payload.commit === 'string'
      ? payload.commit
      : resourceCommit
    if (requestedCommit !== undefined) {
      return reviewJson(await commitDiffDocument(
        workspace,
        requestedCommit,
        maxBytes,
        typeof payload.threadId === 'string' ? payload.threadId : undefined,
      ))
    }
    return reviewJson(await liveDiffDocument(
      workspace,
      maxBytes,
      typeof payload.threadId === 'string' ? payload.threadId : undefined,
    ))
  })
}

diffViewer.inject = ['clientExtensions', 'projects']

export default diffViewer
