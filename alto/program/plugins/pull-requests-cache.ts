import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { PullRequestSnapshot } from './pull-requests-api.js'

const repository = z.string().regex(/^[a-z\d][a-z\d-]*\/[\w.-]+$/iu).refine((value) => !['.', '..'].includes(value.split('/')[1] ?? ''))
const savedSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.number().finite(),
  viewer: z.string().min(1),
  total: z.number().int().nonnegative(),
  complete: z.boolean(),
  items: z.array(z.object({
    id: z.string(), number: z.number().int().positive(), title: z.string(), repository,
    headRepository: repository.nullable(), branch: z.string(), baseBranch: z.string(), draft: z.boolean(),
    updatedAt: z.string().datetime(), createdAt: z.string().datetime().optional(), review: z.string().nullable(), checks: z.string().nullable(),
    mergeable: z.string(), mergeState: z.string(), unresolvedThreads: z.number().int().nonnegative(), moreThreads: z.boolean(),
    description: z.string().max(8_000).optional(), additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(), changedFiles: z.number().int().nonnegative().optional(),
  })).max(2_000),
})

export async function readPullRequestCache(file: string, now = Date.now()): Promise<PullRequestSnapshot | null> {
  try {
    if ((await stat(file)).size > 20 * 1024 * 1024) return null
    const saved = savedSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    if (saved.fetchedAt > now || now - saved.fetchedAt > 86_400_000) return null
    return {
      ...saved, phase: 'ready', error: null,
      items: saved.items.map((pr) => ({ ...pr, url: `https://github.com/${pr.repository}/pull/${pr.number}` })),
    }
  } catch { return null }
}

export async function writePullRequestCache(file: string, snapshot: PullRequestSnapshot): Promise<void> {
  if (snapshot.phase !== 'ready' || snapshot.fetchedAt === null) return
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(`${file}.pending`, JSON.stringify({ ...snapshot, version: 1 }), { mode: 0o600 })
  await rename(`${file}.pending`, file)
}
