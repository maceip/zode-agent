import { mkdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export async function ensureScratchWorkspace(homeDirectory = os.homedir()): Promise<string> {
  // Keep projectless chat files outside the checkout and the desktop runtime,
  // whose program files are loaded as executable plugins.
  const directory = path.join(homeDirectory, '.alto', 'scratch')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return realpath(directory)
}
