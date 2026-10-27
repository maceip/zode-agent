import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'darwin')('expands actual Mermaid diagrams with zoom, keyboard controls, and responsive layout', async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(createRequire(import.meta.url)('electron') as string,
    [path.resolve('tests/fixtures/mermaid-expand.cjs')], { cwd: process.cwd(), env, timeout: 40_000 })
  expect(stdout).toContain('Mermaid expansion browser checks passed at 1100 and 360 pixels')
}, 45_000)
