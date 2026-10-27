import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
const require = createRequire(import.meta.url)

it.skipIf(process.platform !== 'darwin')('offers selected Markdown as a chat draft or preserves the selection for editing', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron') as string, [path.resolve('tests/fixtures/markdown-selection.cjs')], {
    cwd: process.cwd(), env, timeout: 35_000,
  })
  expect(stdout).toContain('Markdown selection browser checks passed')
}, 40_000)
