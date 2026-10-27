import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
const require = createRequire(import.meta.url)
it.skipIf(process.platform !== 'darwin')('opens Tasks without a tab and files chats at wide and narrow widths', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron') as string, [path.resolve('tests/fixtures/todo.cjs')], { cwd: process.cwd(), env, timeout: 25_000 })
  expect(stdout).toContain('Tasks browser checks passed')
}, 30_000)
