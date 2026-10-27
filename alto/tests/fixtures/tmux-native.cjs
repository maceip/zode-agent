const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { pathToFileURL } = require('node:url')
const exec = promisify(execFile)

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('The native terminal did not reach its expected state')
}

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(), loader: 'ts',
      contents: `
        export { NativeTerminalManager } from './src/desktop/native-terminal-manager';
        export { TmuxTerminals } from './program/plugins/tmux-terminals';
      `,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs',
    external: ['electron', 'cordis'],
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(__filename).href) },
  })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, loaded, loaded.exports)
  const { NativeTerminalManager, TmuxTerminals } = loaded.exports
  const root = await mkdtemp(path.join(tmpdir(), 'alto-native-tmux-'))
  const executable = process.env.ALTO_TEST_TMUX || '/opt/homebrew/bin/tmux'
  const terminals = new TmuxTerminals({ execFile: exec }, root, { executable })
  const tmux = async (...args) => (await exec(executable, ['-L', terminals.socketName, ...args])).stdout.trim()
  const window = new BrowserWindow({ show: false, width: 960, height: 640 })
  const native = new NativeTerminalManager(window, process.env.ALTO_TEST_GHOSTTY_ROOT || process.cwd())
  const request = {
    identity: { workspaceId: 'native-check', paneId: 'pane-3', tabId: 'terminal-1' },
    workingDirectory: root, command: '/bin/sh',
  }
  try {
    await window.loadURL('about:blank')
    const first = await terminals.prepare(request)
    const pane = `${first.sessionId}:0.0`
    const pid = await tmux('display-message', '-p', '-t', pane, '#{pane_pid}')
    const surface = native.create({
      command: first.command, workingDirectory: root,
      bounds: { x: 0, y: 0, width: 900, height: 500 },
    })
    await until(async () => (await terminals.list())[0]?.attached)
    const initialWidth = Number(await tmux('display-message', '-p', '-t', pane, '#{pane_width}'))
    await tmux('send-keys', '-t', pane, '-l', 'SAVED=still-here; i=0; while [ "$i" -lt 80 ]; do printf "history-%s\\n" "$i"; i=$((i+1)); done')
    await tmux('send-keys', '-t', pane, 'Enter')
    await until(async () => (await tmux('capture-pane', '-p', '-t', pane)).includes('history-79'))
    native.destroy(surface.id)
    await until(async () => !(await terminals.list())[0]?.attached)

    const restored = await terminals.prepare(request)
    assert.equal(restored.restored, true)
    assert.ok(restored.command.includes('capture-pane'), 'reattachment must restore native scrollback')
    const next = native.create({
      command: restored.command, workingDirectory: root,
      bounds: { x: 0, y: 0, width: 440, height: 500 },
    })
    await until(async () => (await terminals.list())[0]?.attached)
    assert.equal(await tmux('display-message', '-p', '-t', pane, '#{pane_pid}'), pid)
    const nextWidth = Number(await tmux('display-message', '-p', '-t', pane, '#{pane_width}'))
    assert.ok(nextWidth < initialWidth, 'tmux must follow the new Ghostty pane size')
    await tmux('send-keys', '-t', pane, '-l', 'printf "NATIVE-RESTORED:%s\\n" "$SAVED"')
    await tmux('send-keys', '-t', pane, 'Enter')
    await until(async () => (await tmux('capture-pane', '-p', '-t', pane)).includes('NATIVE-RESTORED:still-here'))
    native.destroy(next.id)
    await until(async () => !(await terminals.list())[0]?.attached)
    console.log(JSON.stringify({ nativeAttach: true, sameShellAfterDestroy: true, widths: [initialWidth, nextWidth] }))
  } finally {
    native.destroyAll()
    await tmux('kill-server').catch(() => undefined)
    window.destroy()
    await rm(root, { recursive: true, force: true })
  }
}

check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
