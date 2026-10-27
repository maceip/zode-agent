import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensureScratchWorkspace } from '../program/plugins/session-workspace.js'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

it('creates a private persistent scratch directory under the user home', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alto-scratch-'))
  homes.push(home)

  const workspace = await ensureScratchWorkspace(home)
  expect(workspace).toBe(path.join(await realpath(home), '.alto', 'scratch'))
  expect((await stat(workspace)).isDirectory()).toBe(true)
  expect((await stat(workspace)).mode & 0o777).toBe(0o700)

  await writeFile(path.join(workspace, 'notes.txt'), 'Keep these notes')
  expect(await ensureScratchWorkspace(home)).toBe(workspace)
  expect(await readFile(path.join(workspace, 'notes.txt'), 'utf8')).toBe('Keep these notes')
})
