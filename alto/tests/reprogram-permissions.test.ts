import { Context, type Plugin } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import controlPlane from '../program/plugins/control-plane.js'
import type { CodexService } from '../src/server/services/codex-service.js'
import type { ProgramRuntime } from '../src/server/services/program-runtime.js'
import { toolRegistryPlugin } from '../src/server/services/tool-registry.js'
import type { PermissionMode } from '../src/shared/protocol.js'

function resultValue(result: Awaited<ReturnType<Context['tools']['execute']>>): Record<string, unknown> {
  const text = result.contentItems[0]?.text
  if (!text) throw new Error('tool returned no text result')
  return JSON.parse(text) as Record<string, unknown>
}

describe('agent reprogramming permissions', () => {
  it('applies only for the exact full-access turn and proposes every other request', async () => {
    const ctx = new Context()
    let permission: PermissionMode | undefined = 'ask'
    const applyChange = vi.fn().mockResolvedValue({ revision: 7 })
    const stageProposal = vi.fn((summary: string, files: Array<{ path: string; content: string }>) => ({
      id: `proposal-${stageProposal.mock.calls.length}`,
      summary,
      files,
      source: 'agent' as const,
      createdAt: new Date(0).toISOString(),
    }))
    const codex = {
      permissionModeForTurn: vi.fn((threadId: string, turnId: string) => (
        threadId === 'thread-1' && turnId === 'turn-1' ? permission : undefined
      )),
    } as unknown as CodexService
    const program = {
      projectRoot: '/tmp/alto-permissions',
      applyChange,
      stageProposal,
      runtimeSummary: vi.fn(() => ({})),
    } as unknown as ProgramRuntime
    const codexProvider: Plugin = (owner) => owner.provide('codex', codex)
    codexProvider.provide = 'codex'
    const programProvider: Plugin = (owner) => owner.provide('program', program)
    programProvider.provide = 'program'

    const toolsFiber = await ctx.plugin(toolRegistryPlugin)
    const codexFiber = await ctx.plugin(codexProvider)
    const programFiber = await ctx.plugin(programProvider)
    const controlFiber = await ctx.plugin(controlPlane)
    const call = (transportPermission?: PermissionMode, argumentsPermission?: PermissionMode) => ctx.tools.execute({
      ...(transportPermission ? { permissionMode: transportPermission } : {}),
      callId: 'call-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      tool: 'cordis_reprogram',
      arguments: {
        ...(argumentsPermission ? { permissionMode: argumentsPermission } : {}),
        summary: 'Install a test plugin.',
        files: [{ path: 'plugins/test.ts', content: 'export default () => {}\n' }],
      },
    })

    for (const mode of ['ask', 'auto', undefined] as const) {
      permission = mode
      const result = resultValue(await call())
      expect(result).toMatchObject({
        status: 'awaiting-user-approval',
        permissionMode: mode ?? 'unverified',
      })
    }
    expect(stageProposal).toHaveBeenCalledTimes(3)
    expect(applyChange).not.toHaveBeenCalled()

    permission = 'full'
    expect(resultValue(await call())).toMatchObject({ status: 'applied', revision: 7 })
    expect(applyChange).toHaveBeenCalledTimes(1)
    expect(codex.permissionModeForTurn).toHaveBeenCalledWith('thread-1', 'turn-1')

    permission = undefined
    expect(resultValue(await call(undefined, 'full'))).toMatchObject({ status: 'awaiting-user-approval' })
    expect(resultValue(await call('full'))).toMatchObject({ status: 'applied' })
    permission = 'ask'
    expect(resultValue(await call('full'))).toMatchObject({ status: 'awaiting-user-approval', permissionMode: 'ask' })

    await controlFiber.dispose()
    await programFiber.dispose()
    await codexFiber.dispose()
    await toolsFiber.dispose()
  })
})
