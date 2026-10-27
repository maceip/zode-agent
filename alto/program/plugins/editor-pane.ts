import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord } from '../../src/shared/protocol.js'
import { EDITOR_PREPARE, type EditorLaunch } from './editor-pane-api.js'

export function editorDirectory(payload: unknown): string {
  const workspace = isRecord(payload) ? payload.workspace : undefined
  if (typeof workspace !== 'string' || !workspace.trim() || workspace.includes('\0') || !path.isAbsolute(workspace)) {
    throw new Error('Choose a local workspace for the editor first.')
  }
  return workspace
}

export async function prepareEditor(payload: unknown, executable?: string): Promise<EditorLaunch> {
  const workspace = editorDirectory(payload)
  if (!(await stat(workspace).catch(() => undefined))?.isDirectory()) {
    throw new Error('The editor’s workspace folder no longer exists on this computer.')
  }
  const workingDirectory = await realpath(workspace)
  const candidates = executable ? [executable] : [...new Set([
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
  ])].map((directory) => path.join(directory, 'nvim'))
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || candidate.includes('\0')) continue
    try { await access(candidate, constants.X_OK) } catch { continue }
    // Ghostty/tmux accept a command string. Quote the executable as one literal argument.
    return { workingDirectory, command: `'${candidate.replaceAll("'", "'\\''")}' .` }
  }
  throw new Error('Neovim is not installed. Install nvim, then retry opening the editor.')
}

const editorPane: HarnessPlugin<{ executable?: string }> = (ctx, config) => {
  ctx.clientExtensions.registerMethod(ctx, EDITOR_PREPARE, async (payload) => (
    { ...await prepareEditor(payload, config.executable) }
  ))
}
editorPane.inject = ['clientExtensions']
export default editorPane
