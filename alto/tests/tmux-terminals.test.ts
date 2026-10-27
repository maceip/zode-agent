import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Context, type Plugin } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLauncher } from '../program/plugins/ghostty-terminal-api.js'
import { TerminalLaunchers } from '../program/plugins/terminal-launchers.js'
import tmuxTerminals, { TmuxTerminals, shellQuote, terminalLaunchRequest, tmuxSessionName } from '../program/plugins/tmux-terminals.js'
import { clientExtensionRegistryPlugin } from '../src/server/services/client-extension-registry.js'
import { toolRegistryPlugin } from '../src/server/services/tool-registry.js'
import { TMUX_PREPARE } from '../program/plugins/tmux-terminals-api.js'

const exec = promisify(execFile)
const identity = { workspaceId: 'workspace:one', paneId: 'pane:3', tabId: 'terminal-2' }
let executable: string | undefined
for (const candidate of ['tmux', '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']) {
  try { await exec(candidate, ['-V']); executable = candidate; break } catch { /* Optional integration dependency. */ }
}

describe('terminal launcher extension', () => {
  it('restores ordinary terminal behavior when the owner unloads', async () => {
    const owner = new Context()
    const launches = new TerminalLaunchers()
    const launcher: TerminalLauncher = {
      id: 'test', prepare: vi.fn().mockResolvedValue({ command: 'attach saved' }), close: vi.fn(),
    }
    const request = { identity, command: 'my-shell', workingDirectory: '/repo' }
    expect(await launches.prepare(request)).toEqual({ command: 'my-shell' })
    const registration = launches.register(owner, launcher)
    expect(await launches.prepare(request)).toEqual({ command: 'attach saved' })
    expect(await launches.prepare({ command: 'unmanaged' })).toEqual({ command: 'unmanaged' })
    expect(() => launches.register(owner, launcher)).toThrow('already registered')
    await launches.close(identity)
    expect(launcher.close).toHaveBeenCalledWith(identity)
    registration.dispose()
    expect(await launches.prepare(request)).toEqual({ command: 'my-shell' })
    await launches.close(identity)
    expect(launcher.close).toHaveBeenCalledTimes(1)
  })

  it('uses all three stable IDs without ambiguous delimiter concatenation', () => {
    expect(tmuxSessionName(identity)).not.toBe(tmuxSessionName({ ...identity, paneId: 'pane:4' }))
    expect(tmuxSessionName(identity)).not.toBe(tmuxSessionName({ ...identity, tabId: 'terminal-3' }))
    expect(tmuxSessionName({ workspaceId: 'a:b', paneId: 'c', tabId: 'd' }))
      .not.toBe(tmuxSessionName({ workspaceId: 'a', paneId: 'b:c', tabId: 'd' }))
    expect(() => terminalLaunchRequest({ identity: { ...identity, tabId: '' } })).toThrow('tab ID')
    expect(() => terminalLaunchRequest({ identity, command: 'bad\0command' })).toThrow('command')
  })

  it('quotes shell metacharacters without expanding them', async () => {
    const value = "path's $(printf bad) `printf bad`; * \\ \n end"
    expect((await exec('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`])).stdout).toBe(value)
  })

  it('reports a missing dependency without silently opening an unprotected shell', async () => {
    const terminals = new TmuxTerminals({ execFile: vi.fn() }, '/tmp', { executable: '/missing/alto-test-tmux' })
    await expect(terminals.prepare({ identity })).rejects.toThrow('needs tmux')
  })
})

describe.skipIf(!executable)('tmux terminal persistence integration', () => {
  it('unloads its Cordis methods without ending sessions and checks captured stop permissions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-tmux-lifecycle-'))
    const command = (await exec('/bin/sh', ['-c', `command -v ${shellQuote(executable!)}`])).stdout.trim()
    const ctx = new Context()
    let mode: 'full' | 'ask' = 'ask'
    const dependencies: Plugin = (owner) => {
      owner.provide('program', { projectRoot: root } as typeof owner.program)
      owner.provide('codex', { permissionModeForTurn: () => mode } as unknown as typeof owner.codex)
      owner.provide('processRunner', { execFile: exec })
    }
    dependencies.provide = ['program', 'codex', 'processRunner']
    const services = await ctx.plugin(dependencies)
    const extensions = await ctx.plugin(clientExtensionRegistryPlugin)
    const tools = await ctx.plugin(toolRegistryPlugin)
    const feature = await ctx.plugin(tmuxTerminals, { executable: command })
    const inspector = new TmuxTerminals({ execFile: exec }, root, { executable: command })
    try {
      await ctx.clientExtensions.call(TMUX_PREPARE, { identity: { ...identity }, command: '/bin/sh' })
      const stop = () => ctx.tools.execute({
        callId: 'stop', threadId: 'thread', turnId: 'turn', tool: 'cordis',
        arguments: { operation: 'invoke', tool: 'terminal/stop', arguments: { identity } },
      })
      expect(await stop()).toMatchObject({ success: false })
      expect(await inspector.list()).toHaveLength(1)
      await feature.dispose()
      expect(ctx.clientExtensions.describe().methods).toEqual([])
      expect(ctx.tools.list()).toEqual([])
      expect(await inspector.list()).toHaveLength(1)
      const restored = await ctx.plugin(tmuxTerminals, { executable: command })
      try {
        mode = 'full'
        expect(await stop()).toMatchObject({ success: true })
        expect(await inspector.list()).toHaveLength(0)
      } finally { await restored.dispose() }
    } finally {
      await feature.dispose()
      await inspector.close({ identity }).catch(() => undefined)
      await tools.dispose()
      await extensions.dispose()
      await services.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores the same shell, screen, and working directory, isolates panes, and closes only the selected session', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-tmux-test-'))
    const workspace = path.join(root, "space's $(not-a-command)")
    await mkdir(workspace)
    const config = { executable: (await exec('/bin/sh', ['-c', `command -v ${shellQuote(executable!)}`])).stdout.trim() }
    const terminals = new TmuxTerminals({ execFile: exec }, root, config)
    const tmux = async (...args: string[]) => (await exec(config.executable, ['-L', terminals.socketName, ...args])).stdout.trim()
    try {
      const request = { identity, workingDirectory: workspace, command: '/bin/sh' }
      const [first, duplicate] = await Promise.all([terminals.prepare(request), terminals.prepare(request)])
      expect(first.restored).toBe(false)
      expect(duplicate.restored).toBe(true)
      expect(first.sessionId).toBe(duplicate.sessionId)
      const pane = `${first.sessionId}:0.0`
      const pid = await tmux('display-message', '-p', '-t', pane, '#{pane_pid}')
      await tmux('send-keys', '-t', pane, '-l', 'SAVED=preserved; cd /tmp; printf "PERSISTENT-SCREEN\\n"')
      await tmux('send-keys', '-t', pane, 'Enter')
      const temporaryPath = await realpath('/tmp')
      await vi.waitFor(async () => {
        expect(await tmux('display-message', '-p', '-t', pane, '#{pane_current_path}')).toBe(temporaryPath)
      })

      // The plugin has no resident child process to keep alive. A new instance
      // uses the persisted pane IDs to find the original shell in tmux.
      const reloaded = new TmuxTerminals({ execFile: exec }, root, config)
      const restored = await reloaded.prepare({ ...request, workingDirectory: root })
      expect(restored.restored).toBe(true)
      expect(await tmux('display-message', '-p', '-t', pane, '#{pane_pid}')).toBe(pid)
      await tmux('send-keys', '-t', pane, '-l', 'printf "RESTORED:%s\\n" "$SAVED"')
      await tmux('send-keys', '-t', pane, 'Enter')
      await vi.waitFor(async () => expect(await tmux('capture-pane', '-p', '-t', pane)).toContain('RESTORED:preserved'))
      expect(await tmux('capture-pane', '-p', '-t', pane)).toContain('PERSISTENT-SCREEN')
      expect(await tmux('show-options', '-gv', 'status')).toBe('off')
      expect(await tmux('show-options', '-gv', 'prefix')).toBe('None')

      const secondIdentity = { ...identity, paneId: 'pane:4' }
      const second = await reloaded.prepare({ identity: secondIdentity, workingDirectory: root, command: '/bin/sh' })
      expect(second.sessionId).not.toBe(first.sessionId)
      expect(await reloaded.list()).toHaveLength(2)
      const otherInstance = new TmuxTerminals({ execFile: exec }, root + '-other', config)
      expect(otherInstance.socketName).not.toBe(terminals.socketName)
      await reloaded.close({ identity })
      expect(await reloaded.list()).toEqual([{ sessionId: second.sessionId, attached: false, identity: secondIdentity }])
      await reloaded.close({ identity })
      await reloaded.close({ identity: secondIdentity })
      expect(await reloaded.list()).toEqual([])
    } finally {
      await tmux('kill-server').catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})
