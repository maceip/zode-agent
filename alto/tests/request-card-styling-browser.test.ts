import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)

it.skipIf(process.platform !== 'darwin')('keeps request cards readable and contained across themes and narrow widths', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron') as string, [
    path.resolve('tests/fixtures/request-card-styling.cjs'),
  ], { cwd: process.cwd(), env, timeout: 25_000 })
  expect(stdout).toContain('Request card styling checks passed: 48 theme, width, and request combinations')
}, 30_000)
