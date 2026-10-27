import { isAgentChatId } from './agent-chats-api.js'
import { requireAgentChats } from './agent-chats-access.js'
import { ensureScratchWorkspace } from './session-workspace.js'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import type {
  HarnessPlugin,
  UiShellRegion,
  UiSurface,
} from '../../src/server/plugin-api.js'
import {
  isRecord,
  type JsonValue,
  type ThreadSummary,
} from '../../src/shared/protocol.js'
import {
  WORKSPACE_COMMAND_CLAIM_METHOD,
  WORKSPACE_COMMAND_RESULT_METHOD,
  WORKSPACE_COMMAND_STATE,
  type WorkspaceCommandService,
  type WorkspaceCommandSnapshot,
  type WorkspaceOpenPaneRequest,
  type WorkspaceOpenPaneResult,
} from './workspace-commands-api.js'
import {
  parseWorkspaceLayout,
  WORKSPACE_LAYOUT_READ_METHOD,
  WORKSPACE_LAYOUT_WRITE_METHOD,
  type WorkspaceLayoutState,
} from './workspace-layout-state.js'

const RECENTS_SOURCE_ID = 'workspace-layout-recents'
const UNASSIGN_METHOD = 'workspace-layout.unassign-thread'
const RECENTS_FILE_VERSION = 1
const COMMAND_TIMEOUT_MS = 15_000

interface PendingWorkspaceCommand {
  request: WorkspaceOpenPaneRequest
  claimedBy?: string
  resolve(result: WorkspaceOpenPaneResult): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

function commandJson(snapshot: WorkspaceCommandSnapshot): JsonValue {
  return snapshot as unknown as JsonValue
}

class WorkspaceCommands implements WorkspaceCommandService {
  private readonly pending = new Map<string, PendingWorkspaceCommand>()
  private state: ReturnType<Context['clientExtensions']['registerState']> | undefined
  private revision = 0

  constructor(private readonly ctx: Context) {}

  start(owner: Context): void {
    this.state = this.ctx.clientExtensions.registerState(owner, WORKSPACE_COMMAND_STATE, commandJson(this.snapshot()))
    this.ctx.clientExtensions.registerMethod(owner, WORKSPACE_COMMAND_CLAIM_METHOD, (payload) => {
      if (!isRecord(payload) || typeof payload.id !== 'string' || typeof payload.clientId !== 'string') {
        throw new Error('workspace command claim needs id and clientId')
      }
      const pending = this.pending.get(payload.id)
      if (!pending) return { claimed: false }
      if (pending.claimedBy && pending.claimedBy !== payload.clientId) return { claimed: false }
      pending.claimedBy = payload.clientId
      return { claimed: true }
    })
    this.ctx.clientExtensions.registerMethod(owner, WORKSPACE_COMMAND_RESULT_METHOD, (payload) => {
      if (
        !isRecord(payload)
        || typeof payload.id !== 'string'
        || typeof payload.clientId !== 'string'
        || typeof payload.success !== 'boolean'
      ) {
        throw new Error('workspace command result needs id, clientId, and success')
      }
      const pending = this.pending.get(payload.id)
      if (!pending) return { accepted: false }
      if (pending.claimedBy !== payload.clientId) return { accepted: false }
      this.pending.delete(payload.id)
      clearTimeout(pending.timeout)
      this.publish()
      if (!payload.success) {
        pending.reject(new Error(typeof payload.error === 'string' ? payload.error : 'workspace command failed'))
        return { accepted: true }
      }
      if (!isRecord(payload.result)
        || typeof payload.result.workspaceId !== 'string'
        || typeof payload.result.paneId !== 'string') {
        pending.reject(new Error('workspace command returned an invalid pane result'))
        return { accepted: true }
      }
      pending.resolve({
        workspaceId: payload.result.workspaceId,
        paneId: payload.result.paneId,
        ...(typeof payload.result.threadId === 'string' ? { threadId: payload.result.threadId } : {}),
      })
      return { accepted: true }
    })
    owner.effect(() => () => {
      for (const command of this.pending.values()) {
        clearTimeout(command.timeout)
        command.reject(new Error('workspace layout was unloaded'))
      }
      this.pending.clear()
    }, 'workspaceCommands.lifecycle')
  }

  openPane(
    input: Omit<WorkspaceOpenPaneRequest, 'id' | 'action'>,
  ): Promise<WorkspaceOpenPaneResult> {
    const id = randomUUID()
    const request: WorkspaceOpenPaneRequest = {
      ...structuredClone(input),
      id,
      action: 'open-pane',
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return
        this.publish()
        reject(new Error('the browser did not apply the workspace command in time'))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(id, { request, resolve, reject, timeout })
      this.publish()
    })
  }

  private snapshot(): WorkspaceCommandSnapshot {
    return {
      version: 1,
      revision: this.revision,
      requests: [...this.pending.values()].map(({ request }) => structuredClone(request)),
    }
  }

  private publish(): void {
    this.revision += 1
    this.state?.update(commandJson(this.snapshot()))
  }
}

export function recentThreadIds(value: unknown): string[] {
  if (!isRecord(value) || value.version !== RECENTS_FILE_VERSION || !Array.isArray(value.threadIds)) {
    return []
  }
  return [...new Set(value.threadIds.flatMap((threadId) => (
    typeof threadId === 'string' && threadId.trim() ? [threadId.trim()] : []
  )))].sort()
}

export function recentsStatePath(projectRoot: string): string {
  return path.join(projectRoot, '.codex-cordis', 'workspace-layout-recents.json')
}

export function workspaceLayoutStatePath(projectRoot: string): string {
  return path.join(projectRoot, '.codex-cordis', 'workspace-layout.json')
}

export async function readWorkspaceLayoutState(
  file: string,
): Promise<WorkspaceLayoutState | undefined> {
  try {
    return parseWorkspaceLayout(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

export async function writeWorkspaceLayoutState(
  file: string,
  layout: WorkspaceLayoutState,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(layout, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function readRecents(file: string): Promise<string[]> {
  try {
    return recentThreadIds(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return []
    throw error
  }
}

async function writeRecents(file: string, threadIds: readonly string[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify({
      version: RECENTS_FILE_VERSION,
      threadIds,
    }, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

const surface: UiSurface = {
  id: 'workspace-layout',
  kind: 'workspace-layout',
}

const region: UiShellRegion = {
  id: 'workspace-layout-region',
  outlet: 'workspace-primary',
  root: {
    type: 'box',
    id: 'workspace-layout-main',
    role: 'main',
    direction: 'column',
    grow: true,
    surface: 'canvas',
    scroll: 'none',
    children: [{ type: 'surface', id: surface.id }],
  },
}

const workspaceLayout: HarnessPlugin = async (ctx) => {
  const file = recentsStatePath(ctx.program.projectRoot)
  const layoutFile = workspaceLayoutStatePath(ctx.program.projectRoot)
  let layoutWrite = Promise.resolve()
  let threadIds = await readRecents(file)
  const recents = ctx.projects.registerSource(ctx, RECENTS_SOURCE_ID, {
    projects: [],
    unassignedThreadIds: threadIds,
  })

  const commands = new WorkspaceCommands(ctx)
  ctx.provide('workspaceCommands', commands)
  commands.start(ctx)

  ctx.clientExtensions.registerMethod(ctx, WORKSPACE_LAYOUT_READ_METHOD, async () => {
    await layoutWrite.catch(() => undefined)
    return (await readWorkspaceLayoutState(layoutFile) ?? null) as unknown as JsonValue
  })

  ctx.clientExtensions.registerMethod(ctx, WORKSPACE_LAYOUT_WRITE_METHOD, async (payload) => {
    const layout = parseWorkspaceLayout(payload)
    if (!layout) throw new Error('workspace layout state is invalid')
    const pending = layoutWrite
      .catch(() => undefined)
      .then(() => writeWorkspaceLayoutState(layoutFile, layout))
    layoutWrite = pending
    await pending
    return layout as unknown as JsonValue
  })

  ctx.clientExtensions.registerMethod(ctx, UNASSIGN_METHOD, async (payload) => {
    const threadId = isRecord(payload) && typeof payload.threadId === 'string'
      ? payload.threadId.trim()
      : ''
    if (!threadId) throw new Error('a thread id is required')
    if (!threadIds.includes(threadId)) {
      const next = [...threadIds, threadId].sort()
      await writeRecents(file, next)
      threadIds = next
      recents.update({ projects: [], unassignedThreadIds: threadIds })
    }
    return { threadId } satisfies JsonValue
  })

  ctx.ui.registerSurface(ctx, surface)
  ctx.ui.registerShellRegion(ctx, region)

  ctx.tools.register(ctx, {
    namespace: 'workspace',
    name: 'open_pane',
    description: 'Open and focus a new Alto pane beside the chat that invoked this tool. Chat panes are independent conversations using the current agent; terminal, browser, and canvas panes are plugin-owned views.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Pane kind. Use chat, terminal, browser, or canvas unless a live plugin advertises another kind.',
          default: 'chat',
        },
        placement: {
          type: 'string',
          enum: ['right', 'below'],
          default: 'right',
        },
      },
      additionalProperties: false,
    },
  }, async (call) => {
    const args = isRecord(call.arguments) ? call.arguments : {}
    const kind = typeof args.kind === 'string' && args.kind.trim() ? args.kind.trim() : 'chat'
    const direction = args.placement === 'below' ? 'vertical' : 'horizontal'
    const chats = isAgentChatId(call.threadId) ? requireAgentChats(ctx) : undefined
    const agentChat = await chats?.open(call.threadId)
    const anchor = agentChat?.summary ?? await ctx.codex.threadSummary(call.threadId)
    let thread: ThreadSummary | undefined
    if (kind === 'chat') {
      const workspace = anchor?.cwd || await ensureScratchWorkspace()
      const permissionMode = ctx.codex.permissionModeForTurn(call.threadId, call.turnId) ?? call.permissionMode ?? 'ask'
      if (chats && agentChat) {
        thread = (await chats.create(agentChat.summary.providerId, workspace, permissionMode)).summary
      } else {
        const response = await ctx.codex.startThread({ workspace, permissionMode })
        const id = response.thread?.id
        if (!id) throw new Error('Codex did not create a thread for the new pane')
        const timestamp = Math.floor(Date.now() / 1_000)
        thread = {
          id,
          title: 'New chat',
          preview: '',
          cwd: workspace,
          createdAt: timestamp,
          updatedAt: timestamp,
          recencyAt: timestamp,
          ...(anchor?.projectId ? { projectId: anchor.projectId } : {}),
          ...(anchor?.projectRef ? { projectRef: anchor.projectRef } : {}),
        }
      }
    }
    const pane = await commands.openPane({
      anchorThreadId: call.threadId,
      direction,
      kind,
      ...(thread ? { thread, workspace: thread.cwd, ...(thread.projectId ? { projectId: thread.projectId } : {}) } : {}),
    })
    return { ...pane }
  })
}

workspaceLayout.inject = ['clientExtensions', 'codex', 'program', 'projects', 'tools', 'ui']
workspaceLayout.provide = 'workspaceCommands'

export default workspaceLayout
