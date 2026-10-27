import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord } from '../../src/shared/protocol.js'
import type { TerminalIdentity, TerminalLaunchRequest } from './ghostty-terminal-api.js'
import type { ProcessRunnerService } from './process-runner-api.js'
import { TMUX_CLOSE, TMUX_PREPARE } from './tmux-terminals-api.js'

interface TmuxConfig { executable?: string }

export const TMUX_CONFIGURATION = `
set -g status off
set -g prefix None
set -g prefix2 None
set -g mouse off
set -as terminal-overrides ",*:smcup@:rmcup@"
set -g destroy-unattached off
set -s exit-unattached off
set -s escape-time 0
set -g focus-events on
set -g history-limit 50000
set -g default-terminal tmux-256color
set -g window-size latest
set -g allow-passthrough on
set -s set-clipboard on
`.trim() + '\n'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

export function tmuxSessionName(identity: TerminalIdentity): string {
  return `alto-${hash(JSON.stringify([identity.workspaceId, identity.paneId, identity.tabId]))}`
}

function requiredString(value: unknown, name: string, limit = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > limit) {
    throw new Error(`Invalid terminal ${name}`)
  }
  return value
}

export function terminalLaunchRequest(value: unknown): TerminalLaunchRequest & { identity: TerminalIdentity } {
  if (!isRecord(value) || !isRecord(value.identity)) throw new Error('A terminal identity is required')
  const identity = value.identity
  return {
    identity: {
      workspaceId: requiredString(identity.workspaceId, 'workspace ID', 512),
      paneId: requiredString(identity.paneId, 'pane ID', 512),
      tabId: requiredString(identity.tabId, 'tab ID', 512),
    },
    ...(value.workingDirectory !== undefined
      ? { workingDirectory: requiredString(value.workingDirectory, 'working directory') } : {}),
    ...(value.command !== undefined ? { command: requiredString(value.command, 'command', 32768) } : {}),
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function absentSession(error: unknown): boolean {
  return isRecord(error) && typeof error.stderr === 'string'
    && /no server running|no sessions|no such session:|can't find session:|error connecting to .*No such file or directory/u.test(error.stderr)
}

export class TmuxTerminals {
  readonly socketName: string
  private readonly directory: string
  private readonly configFile: string
  private ready: Promise<string> | undefined
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(
    private readonly processes: ProcessRunnerService,
    private readonly projectRoot: string,
    private readonly config: TmuxConfig = {},
    private readonly signal?: AbortSignal,
  ) {
    this.socketName = `alto-${hash(path.resolve(projectRoot))}`
    this.directory = path.join(projectRoot, '.codex-cordis', 'tmux-terminals')
    this.configFile = path.join(this.directory, 'tmux.conf')
  }

  private async executable(): Promise<string> {
    if (!this.ready) {
      this.ready = (async () => {
        const candidates = this.config.executable
          ? [this.config.executable]
          : [...new Set((process.env.PATH ?? '').split(path.delimiter)
            .filter(Boolean).concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']))]
            .map((directory) => path.join(directory, 'tmux'))
        for (const executable of candidates) {
          try { await access(executable, constants.X_OK) } catch { continue }
          this.signal?.throwIfAborted()
          await mkdir(this.directory, { recursive: true, mode: 0o700 })
          const temporary = `${this.configFile}.${process.pid}.tmp`
          await writeFile(temporary, TMUX_CONFIGURATION, { mode: 0o600 })
          await rename(temporary, this.configFile)
          return executable
        }
        throw new Error('Terminal Persistence needs tmux. Install it, or disable the extension to use ordinary terminals.')
      })().catch((error: unknown) => { this.ready = undefined; throw error })
    }
    return this.ready
  }

  private args(...command: string[]): string[] {
    return ['-L', this.socketName, '-f', this.configFile, ...command]
  }

  private async run(...command: string[]): Promise<string> {
    const executable = await this.executable()
    this.signal?.throwIfAborted()
    const { stdout } = await this.processes.execFile(executable, this.args(...command), {
      timeout: 5_000,
      env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
      ...(this.signal ? { signal: this.signal } : {}),
    })
    return stdout.trim()
  }

  private async exists(id: string): Promise<boolean> {
    try { await this.run('has-session', '-t', `=${id}`); return true }
    catch (error) { if (absentSession(error)) return false; throw error }
  }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation)
    this.pending.set(id, result)
    void result.finally(() => {
      if (this.pending.get(id) === result) this.pending.delete(id)
    }).catch(() => undefined)
    return result
  }

  prepare(value: unknown): Promise<{ command: string; sessionId: string; restored: boolean }> {
    const request = terminalLaunchRequest(value)
    const id = tmuxSessionName(request.identity)
    return this.serial(id, async () => {
      const executable = await this.executable()
      const restored = await this.exists(id)
      if (!restored) {
        const command = ['new-session', '-d', '-s', id, '-c', request.workingDirectory ?? this.projectRoot]
        if (request.command) command.push(request.command)
        try { await this.run(...command) }
        catch (error) {
          // Two Alto windows can restore the same pane concurrently.
          if (!await this.exists(id)) throw error
        }
      }
      await this.run('set-option', '-t', id, '@alto-identity', JSON.stringify(request.identity))
      const invoke = (...args: string[]) => ['/usr/bin/env', '-u', 'TMUX', '-u', 'TMUX_PANE', executable,
        ...this.args(...args)].map(shellQuote).join(' ')
      const attach = invoke('attach-session', '-t', `=${id}`)
      // Keep Ghostty in its normal screen so native selection and scrolling still
      // work. Refill its scrollback before tmux redraws the current screen.
      const history = restored ? Number(await this.run('display-message', '-p', '-t', `${id}:0.0`, '#{history_size}')) : 0
      const command = history > 0
        ? `${invoke('capture-pane', '-p', '-e', '-J', '-S', '-', '-E', '-1', '-t', `${id}:0.0`)}; exec ${attach}`
        : `exec ${attach}`
      return {
        command: ['/bin/sh', '-c', command].map(shellQuote).join(' '),
        sessionId: id,
        restored,
      }
    })
  }

  async list(): Promise<Array<{ sessionId: string; attached: boolean; identity: TerminalIdentity }>> {
    let output: string
    try { output = await this.run('list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{@alto-identity}') }
    catch (error) { if (absentSession(error)) return []; throw error }
    return output.split('\n').flatMap((line) => {
      const [sessionId, attached, identity] = line.split('\t')
      try {
        const request = terminalLaunchRequest({ identity: JSON.parse(identity ?? '') })
        return sessionId === tmuxSessionName(request.identity)
          ? [{ sessionId, attached: Number(attached) > 0, identity: request.identity }] : []
      } catch { return [] }
    })
  }

  async processId(identity: TerminalIdentity): Promise<number> {
    const request = terminalLaunchRequest({ identity })
    const id = tmuxSessionName(request.identity)
    const pid = Number(await this.run('display-message', '-p', '-t', `${id}:0.0`, '#{pane_pid}'))
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('The terminal process is no longer running.')
    return pid
  }

  close(value: unknown): Promise<void> {
    const request = terminalLaunchRequest(value)
    const id = tmuxSessionName(request.identity)
    return this.serial(id, async () => {
      try { await this.run('kill-session', '-t', `=${id}`) }
      catch (error) { if (!absentSession(error)) throw error }
    })
  }
}

const tmuxTerminals: HarnessPlugin<TmuxConfig> = (ctx, config) => {
  const abort = new AbortController()
  ctx.effect(() => () => abort.abort())
  // tmux owns the shells. Unloading this fiber cancels management commands,
  // but deliberately leaves sessions available for the next Alto connection.
  const terminals = new TmuxTerminals(ctx.processRunner, ctx.program.projectRoot, config, abort.signal)
  ctx.provide('tmuxTerminals', terminals)
  ctx.clientExtensions.registerMethod(ctx, TMUX_PREPARE, (value) => terminals.prepare(value))
  ctx.clientExtensions.registerMethod(ctx, TMUX_CLOSE, async (value) => { await terminals.close(value); return null })
  ctx.tools.register(ctx, {
    namespace: 'terminal', name: 'list',
    description: 'List persistent Alto terminals, including detached terminals from closed panes. Returns exact workspace, pane, and terminal-tab identities.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }, async () => ({ terminals: await terminals.list() }))
  ctx.tools.register(ctx, {
    namespace: 'terminal', name: 'stop',
    description: 'End one persistent Alto terminal and its running processes. Use an exact identity from terminal/list. Requires Full access.',
    inputSchema: {
      type: 'object', required: ['identity'], additionalProperties: false,
      properties: { identity: {
        type: 'object', required: ['workspaceId', 'paneId', 'tabId'], additionalProperties: false,
        properties: { workspaceId: { type: 'string' }, paneId: { type: 'string' }, tabId: { type: 'string' } },
      } },
    },
  }, async (call) => {
    const permissionMode = ctx.codex.permissionModeForTurn(call.threadId, call.turnId) ?? call.permissionMode
    if (permissionMode !== 'full') throw new Error('Ending a terminal requires Full access')
    await terminals.close(call.arguments)
    return { stopped: true }
  })
}

tmuxTerminals.inject = ['processRunner', 'program', 'clientExtensions', 'tools', 'codex']
tmuxTerminals.provide = 'tmuxTerminals'
export default tmuxTerminals
