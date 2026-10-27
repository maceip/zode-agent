import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isRecord } from '../../src/shared/protocol.js'
import { modelDefaults, type ModelDefaultsPreferences } from './model-defaults-api.js'

export async function readModelDefaults(file: string): Promise<ModelDefaultsPreferences> {
  try {
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'))
    const parsed = isRecord(saved) && saved.version === 1 ? modelDefaults(saved) : undefined
    if (parsed) return parsed
  } catch {
    // Unreadable or invalid preference data must not prevent any chat from opening.
  }
  return { providerId: 'codex', choices: {} }
}

export async function writeModelDefaults(file: string, preferences: ModelDefaultsPreferences): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, ...preferences })}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
