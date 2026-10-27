import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)

it.skipIf(process.platform !== 'darwin')('groups workspace tabs in Chromium without remounting their panes', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron') as string, [
    path.resolve('tests/fixtures/workspace-tab-groups.cjs'),
  ], { cwd: process.cwd(), env, timeout: 25_000 })
  expect(stdout).toContain('Workspace tab group browser checks passed')
}, 30_000)
