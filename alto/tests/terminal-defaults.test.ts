import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { defaultTerminalDirectory } from '../program/plugins/ghostty-terminal.js'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))) })
async function homeDirectory(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'alto-terminal-home-'))
  homes.push(home)
  return home
}

it('starts in development when it exists and otherwise uses home', async () => {
  const home = await homeDirectory()
  expect(await defaultTerminalDirectory(undefined, home)).toBe(home)
  const development = path.join(home, 'development')
  await mkdir(development)
  expect(await defaultTerminalDirectory(undefined, home)).toBe(development)
})

it('honors a configured directory and expands home without invoking a shell', async () => {
  const home = await homeDirectory()
  const project = path.join(home, "space's $(literal)")
  await mkdir(project)
  expect(await defaultTerminalDirectory("~/space's $(literal)", home)).toBe(project)
  expect(await defaultTerminalDirectory(project, home)).toBe(project)
  expect(await defaultTerminalDirectory('~', home)).toBe(home)
})

it('does not launch into a file or a missing preferred directory', async () => {
  const home = await homeDirectory()
  await writeFile(path.join(home, 'development'), 'not a directory')
  expect(await defaultTerminalDirectory(undefined, home)).toBe(home)
  expect(await defaultTerminalDirectory('~/missing', home)).toBe(home)
})
