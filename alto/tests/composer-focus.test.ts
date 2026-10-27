import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)

it.skipIf(process.platform !== 'darwin')('restores the placeholder after native draft deletion without moving focus or changing height', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron') as string, [
    path.resolve('tests/fixtures/composer-placeholder.cjs'),
  ], { cwd: process.cwd(), env, timeout: 25_000 })
  expect(stdout).toContain('Composer placeholder checks passed')
}, 30_000)

// Alto's native macOS runtime is available locally; Linux CI has no display server.
it.skipIf(process.platform !== 'darwin')('preserves composer focus across refreshes without overriding newer focus choices', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron') as string, [
    path.resolve('tests/fixtures/composer-focus.cjs'),
  ], { cwd: process.cwd(), env, timeout: 25_000 })
  expect(stdout).toContain('Composer focus checks passed')
}, 30_000)

it.skipIf(process.platform !== 'darwin')('keeps typing and selections intact while conversation renderers reload', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron') as string, [
    path.resolve('tests/fixtures/composer-reload.cjs'),
  ], { cwd: process.cwd(), env, timeout: 25_000 })
  expect(stdout).toContain('Composer reload checks passed')
}, 30_000)
