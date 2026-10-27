import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
const require = createRequire(import.meta.url)
it.skipIf(process.platform !== 'darwin')('opens the newest unread in its own tab with Cmd+K and Enter', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron') as string, [path.resolve('tests/fixtures/search.cjs')], { cwd: process.cwd(), env, timeout: 20_000 })
  expect(stdout).toContain('Search browser checks passed')
}, 25_000)
