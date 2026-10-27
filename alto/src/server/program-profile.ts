import { z } from 'zod'
import type { JsonValue } from '../shared/protocol.js'

export type Isolation = true | string

export interface ProgramEntry {
  id: string
  name: string
  description: string
  protocolVersion?: number
  module?: string | undefined
  client?: string | undefined
  enabled: boolean
  config: JsonValue
  isolate: Record<string, Isolation>
  intercept: Record<string, JsonValue>
  children: ProgramEntry[]
}

export interface ProgramProfile {
  version: 1 | 2
  plugins: ProgramEntry[]
}

export interface ProgramMount {
  parent?: string | undefined
  plugins: ProgramEntry[]
}

export interface ProgramExtension {
  version: 1
  mounts: ProgramMount[]
}

export interface EntryLocation {
  entry: ProgramEntry
  parentId?: string
  depth: number
  active: boolean
}

const EntrySchema: z.ZodType<ProgramEntry> = z.lazy(() => z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  protocolVersion: z.number().int().positive().default(1),
  module: z.string().min(1).optional(),
  client: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  config: z.unknown().default({}) as z.ZodType<JsonValue>,
  isolate: z.record(
    z.string().min(1).max(128),
    z.union([z.literal(true), z.string().min(1).max(128)]),
  ).default({}),
  intercept: z.record(
    z.string().min(1).max(128),
    z.unknown() as z.ZodType<JsonValue>,
  ).default({}),
  children: z.array(EntrySchema).max(128).default([]),
}))

const ProfileSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  plugins: z.array(EntrySchema).max(128),
})

const ExtensionSchema: z.ZodType<ProgramExtension> = z.object({
  version: z.literal(1),
  mounts: z.array(z.object({
    parent: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
    plugins: z.array(EntrySchema).min(1).max(128),
  })).min(1).max(128),
})

export function entriesOf(profile: ProgramProfile): EntryLocation[] {
  const result: EntryLocation[] = []
  const visit = (
    entries: ProgramEntry[],
    depth: number,
    parentActive: boolean,
    parentId?: string,
  ): void => {
    for (const entry of entries) {
      const active = parentActive && entry.enabled
      result.push({ entry, depth, active, ...(parentId ? { parentId } : {}) })
      visit(entry.children, depth + 1, active, entry.id)
    }
  }
  visit(profile.plugins, 0, true)
  return result
}

export function parseProgramProfile(source: string): ProgramProfile {
  const profile = ProfileSchema.parse(JSON.parse(source))
  const locations = entriesOf(profile)
  if (locations.length > 256) throw new Error('a Cordis program may contain at most 256 entries')

  const ids = new Set<string>()
  for (const { entry } of locations) {
    if (ids.has(entry.id)) throw new Error(`duplicate program entry id "${entry.id}"`)
    ids.add(entry.id)
  }
  return profile
}

export function parseProgramExtension(source: string): ProgramExtension {
  return ExtensionSchema.parse(JSON.parse(source))
}

export function mountProgramExtension(
  profile: ProgramProfile,
  extension: ProgramExtension,
): ProgramProfile {
  const mounted = structuredClone(profile)
  for (const mount of extension.mounts) {
    if (!mount.parent) {
      mounted.plugins.push(...structuredClone(mount.plugins))
      continue
    }
    const parent = entriesOf(mounted).find(({ entry }) => entry.id === mount.parent)?.entry
    if (!parent) throw new Error(`external plugin mount references unknown parent "${mount.parent}"`)
    parent.children.push(...structuredClone(mount.plugins))
  }
  return parseProgramProfile(JSON.stringify(mounted))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function setProgramEntryEnabled(
  source: string,
  id: string,
  enabled: boolean,
): string {
  parseProgramProfile(source)
  const document: unknown = JSON.parse(source)
  if (!isRecord(document) || !Array.isArray(document.plugins)) {
    throw new Error('invalid Cordis program document')
  }

  let target: Record<string, unknown> | undefined
  const visit = (entries: unknown[]): void => {
    for (const value of entries) {
      if (!isRecord(value)) continue
      if (value.id === id) target = value
      if (Array.isArray(value.children)) visit(value.children)
    }
  }
  visit(document.plugins)

  if (!target) throw new Error(`unknown program entry: ${id}`)
  const current = target.enabled !== false
  if (current === enabled) return source
  target.enabled = enabled
  return `${JSON.stringify(document, null, 2)}\n`
}

export function scopeKey(entry: ProgramEntry): string {
  return JSON.stringify({
    isolate: Object.entries(entry.isolate).sort(([left], [right]) => left.localeCompare(right)),
    intercept: Object.entries(entry.intercept).sort(([left], [right]) => left.localeCompare(right)),
  })
}
