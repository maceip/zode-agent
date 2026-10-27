import { Context } from 'cordis'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import controlPlane from '../program/plugins/control-plane.js'
import { ProgramRuntime } from '../src/server/services/program-runtime.js'
import { toolRegistryPlugin } from '../src/server/services/tool-registry.js'
import type { PermissionMode } from '../src/shared/protocol.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'alto-staged-program-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const staging = path.join(root, '.codex-cordis', 'staging')
  const programRoot = path.join(root, 'program')
  await mkdir(staging, { recursive: true })
  await mkdir(path.join(programRoot, 'plugins'), { recursive: true })
  await writeFile(path.join(programRoot, 'cordis.json'), JSON.stringify({ version: 2, plugins: [
    { id: 'probe', name: 'Probe', description: 'Exercises atomic activation.', module: 'plugins/probe.ts' },
  ] }))
  const original = 'export default () => {}\n'
  await writeFile(path.join(programRoot, 'plugins/probe.ts'), original)
  const ctx = new Context()
  const tools = await ctx.plugin(toolRegistryPlugin)
  cleanup.push(() => tools.dispose())
  const runtime = new ProgramRuntime(ctx, { projectRoot: root, watch: false })
  cleanup.push(await runtime.start())
  ctx.provide('program', runtime)
  ctx.provide('codex', { permissionModeForTurn: () => undefined } as unknown as Context['codex'])
  const control = await ctx.plugin(controlPlane)
  cleanup.push(() => control.dispose())
  const call = (files: Array<Record<string, unknown>>, permissionMode: PermissionMode = 'full') => ctx.tools.execute({
    callId: 'call', threadId: 'acp-test', turnId: 'turn', permissionMode,
    tool: 'cordis', arguments: { operation: 'invoke', tool: 'cordis_reprogram', arguments: { summary: 'Update the probe.', files } },
  })
  return { root, staging, programRoot, runtime, call, original }
}

describe('staged Cordis replacements', () => {
  it('applies staged contents without including them in the tool arguments', async () => {
    const f = await fixture()
    const content = `// ${'Large existing source. '.repeat(6_000)}\nexport default () => {}\n`
    await writeFile(path.join(f.staging, 'probe.ts'), content)
    const result = await f.call([{ path: 'plugins/probe.ts', sourcePath: 'probe.ts' }])
    expect(result.success, result.contentItems[0]?.text).toBe(true)
    expect(JSON.parse(result.contentItems[0]!.text!)).toMatchObject({ status: 'applied', files: ['plugins/probe.ts'] })
    expect(await readFile(path.join(f.programRoot, 'plugins/probe.ts'), 'utf8')).toBe(content)
  })

  it('captures the proposed bytes before approval and preserves the current files until accepted', async () => {
    const f = await fixture()
    const approved = 'export default () => { /* approved */ }\n'
    await writeFile(path.join(f.staging, 'probe.ts'), approved)
    const result = await f.call([{ path: 'plugins/probe.ts', sourcePath: 'probe.ts' }], 'ask')
    expect(result.success, result.contentItems[0]?.text).toBe(true)
    const proposal = JSON.parse(result.contentItems[0]!.text!)
    expect(proposal.status).toBe('awaiting-user-approval')
    expect(await readFile(path.join(f.programRoot, 'plugins/probe.ts'), 'utf8')).toBe(f.original)
    await writeFile(path.join(f.staging, 'probe.ts'), 'throw new Error("changed after review")\n')
    await f.runtime.resolveProposal(proposal.proposalId, 'accept')
    expect(await readFile(path.join(f.programRoot, 'plugins/probe.ts'), 'utf8')).toBe(approved)
  })

  it('rolls back staged replacements when activation fails', async () => {
    const f = await fixture()
    await writeFile(path.join(f.staging, 'probe.ts'), 'export default () => { throw new Error("bad activation") }\n')
    const result = await f.call([{ path: 'plugins/probe.ts', sourcePath: 'probe.ts' }])
    expect(result.success).toBe(false)
    expect(await readFile(path.join(f.programRoot, 'plugins/probe.ts'), 'utf8')).toBe(f.original)
    expect(f.runtime.snapshot().plugins.find((plugin) => plugin.id === 'probe')?.state).toBe('active')
  })

  it('rejects missing, oversized, ambiguous, and escaping inputs before applying any file', async () => {
    const f = await fixture()
    await writeFile(path.join(f.staging, 'probe.ts'), f.original)
    await writeFile(path.join(f.root, 'outside.ts'), 'private data')
    await symlink(path.join(f.root, 'outside.ts'), path.join(f.staging, 'outside.ts'))
    await writeFile(path.join(f.staging, 'large.ts'), 'x'.repeat(500_001))
    for (const sourcePath of ['../outside.ts', path.join(f.root, 'outside.ts'), 'outside.ts', 'missing.ts', 'large.ts']) {
      const result = await f.call([
        { path: 'plugins/probe.ts', content: 'export default () => { /* must not apply */ }' },
        { path: 'plugins/second.ts', sourcePath },
      ])
      expect(result.success, sourcePath).toBe(false)
      expect(await readFile(path.join(f.programRoot, 'plugins/probe.ts'), 'utf8')).toBe(f.original)
    }
    expect((await f.call([{ path: 'plugins/probe.ts', sourcePath: 'probe.ts', content: f.original }])).success).toBe(false)
    expect((await f.call([{ path: '../outside.ts', sourcePath: 'probe.ts' }])).success).toBe(false)
    expect(await readFile(path.join(f.root, 'outside.ts'), 'utf8')).toBe('private data')
  })
})
