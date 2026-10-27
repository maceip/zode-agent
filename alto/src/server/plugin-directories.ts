import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const ALTO_PLUGIN_DIRECTORIES_ENV = 'ALTO_PLUGIN_DIRS'
export const ALTO_PLUGIN_DIRECTORIES_FILE = path.join(
  '.codex-cordis',
  'plugin-directories.json',
)

function normalizePluginDirectories(projectRoot: string, entries: string[]): string[] {
  return [...new Set(entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(projectRoot, entry)))]
}

export function pluginDirectoriesFromEnvironment(
  projectRoot: string,
  value = process.env[ALTO_PLUGIN_DIRECTORIES_ENV],
): string[] {
  if (!value?.trim()) return []
  return normalizePluginDirectories(projectRoot, value.split(path.delimiter))
}

async function pluginDirectoriesFromFile(projectRoot: string): Promise<string[]> {
  const configPath = path.join(projectRoot, ALTO_PLUGIN_DIRECTORIES_FILE)
  let source: string
  try {
    source = await readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const value: unknown = JSON.parse(source)
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (value as { version?: unknown }).version !== 1
    || !Array.isArray((value as { directories?: unknown }).directories)
    || !(value as { directories: unknown[] }).directories.every((entry) => (
      typeof entry === 'string' && entry.trim()
    ))
  ) {
    throw new Error(`${ALTO_PLUGIN_DIRECTORIES_FILE} must contain version 1 and a directories array`)
  }
  return normalizePluginDirectories(
    projectRoot,
    (value as { directories: string[] }).directories,
  )
}

export async function configuredPluginDirectories(
  projectRoot: string,
  explicit?: string[],
): Promise<string[]> {
  if (explicit) return normalizePluginDirectories(projectRoot, explicit)
  return normalizePluginDirectories(projectRoot, [
    ...await pluginDirectoriesFromFile(projectRoot),
    ...pluginDirectoriesFromEnvironment(projectRoot),
  ])
}
