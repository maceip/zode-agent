import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)

it.skipIf(process.platform !== 'darwin')('keeps working text aligned, selectable, and quiet between sweeps', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron') as string, [path.resolve('tests/fixtures/working-shimmer.cjs')], {
    cwd: process.cwd(), env, timeout: 30_000,
  })
  expect(stdout).toContain('Working shimmer browser checks passed')
}, 35_000)
