import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord } from '../../src/shared/protocol.js'
import { IDE_OPTIONS, OPEN_IN_IDE, isIdeId, type IdeId } from './open-in-ide-api.js'
import type { WorkContextRegistryService } from './work-contexts-api.js'
import type {} from './process-runner-api.js'

export function ideWorkspace(payload: unknown, contexts: Pick<WorkContextRegistryService, 'targetForThread'>): { ide: IdeId; workspace: string } {
  if (!isRecord(payload) || !isIdeId(payload.ide)) throw new Error('Choose an IDE in Alto Settings.')
  const target = typeof payload.threadId === 'string' ? contexts.targetForThread(payload.threadId) : undefined
  if (payload.remote === true || (target && target.kind !== 'local')) {
    throw new Error('Opening a remote workspace in a local IDE is not supported yet.')
  }
  const workspace = target?.location ?? payload.workspace
  if (typeof workspace !== 'string' || !workspace.trim() || workspace.includes('\0') || !path.isAbsolute(workspace)) {
    throw new Error('Choose a local workspace for this chat first.')
  }
  return { ide: payload.ide, workspace }
}

async function ideExecutable(ide: typeof IDE_OPTIONS[number]): Promise<string> {
  if (process.platform === 'darwin') {
    for (const directory of [path.join(os.homedir(), 'Applications'), '/Applications']) {
      const executable = path.join(directory, ide.app, ide.cli)
      try {
        await access(executable, constants.X_OK)
        return executable
      } catch { /* Try the next installation, then the user's PATH. */ }
    }
  }
  return ide.command
}

const openInIde: HarnessPlugin = (ctx) => {
  const contexts = ctx.workContexts
  const runner = ctx.processRunner
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'openInIde.lifetime')
  ctx.clientExtensions.registerMethod(ctx, OPEN_IN_IDE, async (payload) => {
    const { ide: id, workspace } = ideWorkspace(payload, contexts)
    const ide = IDE_OPTIONS.find((option) => option.id === id)!
    const info = await stat(workspace).catch(() => undefined)
    if (!info?.isDirectory() && !(info?.isFile() && workspace.endsWith('.code-workspace') && id !== 'zed')) {
      throw new Error('This workspace no longer exists on this computer.')
    }
    const executable = await ideExecutable(ide)
    lifetime.signal.throwIfAborted()
    try {
      // Separate arguments preserve spaces and shell characters in workspace paths.
      await runner.execFile(executable, ['-n', workspace], { timeout: 15_000, signal: lifetime.signal })
    } catch (error) {
      if (lifetime.signal.aborted) throw error
      throw new Error(`Could not open ${ide.label}. Check that it is installed and its command-line launcher is available.`, { cause: error })
    }
    return { workspace }
  })
}

openInIde.inject = ['clientExtensions', 'workContexts', 'processRunner']
export default openInIde
