const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, rm, writeFile, readFile, realpath } = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')
const { pathToFileURL } = require('node:url')
const exec = promisify(execFile)
// Let async cleanup and failed assertions finish after the hidden window closes.
app.on('window-all-closed', () => {})
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
async function until(predicate) {
  let error
  for (let i = 0; i < 100; i++) {
    try { const result = await predicate(); if (result) return result } catch (caught) { error = caught }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw error || new Error('Editor did not become ready')
}
async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
      export { NativeTerminalManager } from './src/desktop/native-terminal-manager';
      export { TmuxTerminals } from './program/plugins/tmux-terminals';
      export { EditorPanes } from './program/plugins/editor-pane.client';
      export { EditorFileOpener, discoverNeovim } from './program/plugins/editor-file-links';
    ` },
    bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text' },
    external: ['electron', 'cordis'], define: { 'import.meta.url': JSON.stringify(pathToFileURL(__filename).href) },
  })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, loaded, loaded.exports)
  const { NativeTerminalManager, TmuxTerminals, EditorPanes, EditorFileOpener, discoverNeovim } = loaded.exports
  const root = await realpath(await mkdtemp('/tmp/alto-editor-native-'))
  let socket
  const file = path.join(root, 'sample.txt')
  const nvim = process.env.ALTO_TEST_NVIM || '/opt/homebrew/bin/nvim'
  const tmuxBin = process.env.ALTO_TEST_TMUX || '/opt/homebrew/bin/tmux'
  const terminals = new TmuxTerminals({ execFile: exec }, root, { executable: tmuxBin })
  const tmux = async (...args) => (await exec(tmuxBin, ['-L', terminals.socketName, ...args], { timeout: 3000 })).stdout.trim()
  const rpc = async lua => JSON.parse((await exec(nvim, ['--server', socket, '--remote-expr',
    'json_encode(luaeval(' + JSON.stringify('(function() ' + lua + ' end)()') + '))'], { timeout: 3000 })).stdout)
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const editors = () => new EditorPanes({}, {}, storage)
  const window = new BrowserWindow({ show: false, width: 1100, height: 700 })
  const native = new NativeTerminalManager(window, process.env.ALTO_TEST_GHOSTTY_ROOT || process.cwd())
  try {
    await writeFile(file, 'original\n')
    await window.loadURL('about:blank')
    const firstIdentity = editors().identity(root, { workspaceId: 'first-tab', paneId: 'first-pane', tabId: 'neovim' })
    const request = { identity: firstIdentity, workingDirectory: root,
      command: [nvim, '--clean', '-n', '-i', 'NONE', file].map(quote).join(' ') }
    const first = await terminals.prepare(request)
    const surface = native.create({ ...first, workingDirectory: root, bounds: { x: 0, y: 35, width: 1000, height: 600 } })
    await until(async () => (await terminals.list())[0]?.attached)
    socket = (await until(async () => discoverNeovim({ execFile: exec }, await terminals.processId(firstIdentity)))).socket
    const pid = await until(() => rpc('return vim.fn.getpid()'))
    await rpc('vim.cmd("tabnew"); vim.api.nvim_buf_set_lines(0,0,-1,false,{"unsaved scratch buffer"}); return true')
    const wide = await rpc('return vim.o.columns')
    native.setBounds(surface.id, { x: 0, y: 35, width: 360, height: 600 })
    const narrow = await until(async () => { const columns = await rpc('return vim.o.columns'); return columns < wide && columns })
    native.destroy(surface.id)
    await until(async () => !(await terminals.list())[0]?.attached)

    // Reopen from a new pane and even a new Alto tab, after recreating the editor fiber.
    const nextIdentity = editors().identity(root, { workspaceId: 'new-tab', paneId: 'new-pane', tabId: 'neovim' })
    assert.deepEqual(nextIdentity, firstIdentity)
    const second = await terminals.prepare({ ...request, identity: nextIdentity })
    assert.equal(second.restored, true)
    const restoredSurface = native.create({ ...second, workingDirectory: root, bounds: { x: 0, y: 35, width: 1000, height: 600 } })
    await until(async () => (await terminals.list())[0]?.attached)
    const restored = await rpc('return {pid=vim.fn.getpid(),tabs=#vim.api.nvim_list_tabpages(),modified=vim.bo.modified,lines=vim.api.nvim_buf_get_lines(0,0,-1,false)}')
    assert.equal(restored.pid, pid)
    assert.equal(restored.tabs, 2)
    assert.equal(restored.modified, true)
    assert.deepEqual(restored.lines, ['unsaved scratch buffer'])
    assert.equal(await readFile(file, 'utf8'), 'original\n')
    const opener = new EditorFileOpener({ execFile: exec }, terminals)
    const linked = path.join(root, 'odd\'s " | $(touch INJECTED) [x].rs')
    await writeFile(linked, 'first line\nsecond line\nthird line\n')
    await opener.open({workspace:root,identity:nextIdentity,path:path.basename(linked),line:2,column:4})
    const opened = await rpc('return {path=vim.api.nvim_buf_get_name(0),cursor=vim.api.nvim_win_get_cursor(0),tabs=#vim.api.nvim_list_tabpages(),pid=vim.fn.getpid()}')
    assert.equal(opened.path, linked)
    assert.deepEqual(opened.cursor, [2,3])
    assert.equal(opened.tabs, 3)
    assert.equal(opened.pid, pid)
    await opener.open({workspace:root,identity:nextIdentity,path:linked,line:9999,column:9999})
    assert.deepEqual(await rpc('return vim.api.nvim_win_get_cursor(0)'), [3,9])
    assert.equal(await rpc('return #vim.api.nvim_list_tabpages()'),3,'Existing file tab is reused')
    assert.deepEqual(await rpc('for _,b in ipairs(vim.api.nvim_list_bufs()) do if vim.bo[b].modified then return vim.api.nvim_buf_get_lines(b,0,-1,false) end end'),['unsaved scratch buffer'])
    await assert.rejects(opener.open({workspace:root,identity:nextIdentity,path:'missing.rs'}),/no longer exists/)
    assert.equal(await readFile(linked,'utf8'),'first line\nsecond line\nthird line\n')
    await assert.rejects(readFile(path.join(root,'INJECTED')))
    native.destroy(restoredSurface.id)
    console.log(JSON.stringify({ editorReopenPreservesProcess: true, linkedFileOpensInSameProcess: true, lineAndColumn: opened.cursor, tabs: restored.tabs, unsavedBufferPreserved: true, columns: { wide, narrow } }))
  } finally {
    native.destroyAll()
    await tmux('kill-server').catch(() => undefined)
    window.destroy()
    await rm(root, { recursive: true, force: true })
  }
}
check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
