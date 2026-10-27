import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord } from '../../src/shared/protocol.js'
import { EDITOR_OPEN_FILE } from './editor-pane-api.js'
import { editorDirectory } from './editor-pane.js'
import type { ProcessRunnerService } from './process-runner-api.js'
import type { TmuxTerminalService } from './tmux-terminals-api.js'
import { terminalLaunchRequest, tmuxSessionName } from './tmux-terminals.js'

interface NeovimServer { socket: string; executable: string; pid: number }

/** Find the default RPC server belonging to this exact terminal, including Nvim's TUI child. */
export async function discoverNeovim(
  processes: ProcessRunnerService,
  terminalPid: number,
  signal?: AbortSignal,
): Promise<NeovimServer> {
  const options = { timeout: 3000, ...(signal ? { signal } : {}) }
  const { stdout } = await processes.execFile('/bin/ps', ['-ax', '-o', 'pid=,ppid=,comm='], options)
  const rows = stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line)
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), executable: match[3]! }] : []
  })
  const descendants = new Map<number, number>([[terminalPid, 0]])
  for (let changed = true; changed;) {
    changed = false
    for (const row of rows) {
      const depth = descendants.get(row.parent)
      if (depth !== undefined && !descendants.has(row.pid)) {
        descendants.set(row.pid, depth + 1)
        changed = true
      }
    }
  }
  signal?.throwIfAborted()
  const sockets = await processes.execFile('/usr/sbin/lsof', [
    '-n', '-a', '-p', [...descendants.keys()].join(','), '-U', '-Fpn',
  ], options)
  const servers: NeovimServer[] = []
  let pid = 0
  for (const field of sockets.stdout.split('\n')) {
    if (field.startsWith('p')) pid = Number(field.slice(1))
    if (!field.startsWith('n/')) continue
    const socket = field.slice(1)
    // Do not probe sockets belonging to language servers or other editor plugins.
    if (!/^nvim\.\d+\.\d+$/u.test(path.basename(socket))) continue
    const executable = rows.find((row) => row.pid === pid)?.executable
    if (descendants.has(pid) && executable && path.isAbsolute(executable)) servers.push({ pid, socket, executable })
  }
  const server = servers.sort((a, b) => descendants.get(a.pid)! - descendants.get(b.pid)!)[0]
  if (!server) throw new Error('Could not find this Neovim session’s control socket. Its default RPC server must be running.')
  return server
}

// Paths and coordinates arrive as data through luaeval's argument, never as Ex commands.
const OPEN_FILE = `(function()
  local ok, result = pcall(function()
    if vim.fn.getpid() ~= _A.pid then error('The editor process has changed. Click the file again.') end
    local buffer = vim.fn.bufadd(_A.path)
    vim.fn.bufload(buffer)
    local window
    for _, candidate in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_buf(candidate) == buffer and vim.api.nvim_win_get_config(candidate).relative == '' then
        window = candidate
        break
      end
    end
    if window then
      vim.api.nvim_set_current_win(window)
    else
      vim.cmd('tabnew')
      vim.api.nvim_win_set_buf(0, buffer)
    end
    if _A.line then
      local line = math.min(_A.line, vim.api.nvim_buf_line_count(buffer))
      local text = vim.api.nvim_buf_get_lines(buffer, line - 1, line, false)[1] or ''
      vim.api.nvim_win_set_cursor(0, {line, math.min((_A.column or 1) - 1, #text)})
      vim.cmd('normal! zv')
    end
    return true
  end)
  if not ok then return {error=tostring(result)} end
  return {opened=true}
end)()`

function vimString(value: string): string { return `'${value.replaceAll("'", "''")}'` }

export class EditorFileOpener {
  private readonly pending = new Map<string, Promise<void>>()
  constructor(
    private readonly processes: ProcessRunnerService,
    private readonly terminals: TmuxTerminalService,
    private readonly signal?: AbortSignal,
  ) {}

  open(payload: unknown): Promise<void> {
    const workspace = editorDirectory(payload)
    const { identity } = terminalLaunchRequest(payload)
    if (!isRecord(payload) || typeof payload.path !== 'string' || !payload.path.trim()
      || payload.path.includes('\0') || payload.path.length > 32768) throw new Error('Invalid editor file path.')
    const file = path.resolve(workspace, payload.path)
    const coordinates: { line?: number; column?: number } = {}
    for (const name of ['line', 'column'] as const) {
      const value = payload[name]
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid editor ${name}.`)
      coordinates[name] = value
    }
    const key = tmuxSessionName(identity)
    const result = (this.pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (!(await stat(file).catch(() => undefined))?.isFile()) throw new Error(`The file no longer exists: ${file}`)
      this.signal?.throwIfAborted()
      const pid = await this.terminals.processId(identity)
      const server = await discoverNeovim(this.processes, pid, this.signal)
      this.signal?.throwIfAborted()
      const argument = JSON.stringify({ path: file, pid: server.pid, ...coordinates })
      const expression = `json_encode(luaeval(${vimString(OPEN_FILE)}, json_decode(${vimString(argument)})))`
      const { stdout } = await this.processes.execFile(server.executable, [
        '--server', server.socket, '--remote-expr', expression,
      ], { timeout: 5000, ...(this.signal ? { signal: this.signal } : {}) })
      const response: unknown = JSON.parse(stdout)
      if (!isRecord(response) || response.opened !== true) {
        throw new Error(isRecord(response) && typeof response.error === 'string' ? response.error : 'Neovim could not open the file.')
      }
    })
    this.pending.set(key, result)
    void result.finally(() => { if (this.pending.get(key) === result) this.pending.delete(key) }).catch(() => undefined)
    return result
  }
}

const editorFileLinks: HarnessPlugin = (ctx) => {
  const abort = new AbortController()
  ctx.effect(() => () => abort.abort())
  const files = new EditorFileOpener(ctx.processRunner, ctx.tmuxTerminals, abort.signal)
  ctx.clientExtensions.registerMethod(ctx, EDITOR_OPEN_FILE, async (payload) => {
    await files.open(payload)
    return null
  })
}
editorFileLinks.inject = ['clientExtensions', 'processRunner', 'tmuxTerminals']
export default editorFileLinks
