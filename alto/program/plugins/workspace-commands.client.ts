import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import { errorMessage, isRecord, type JsonValue } from '../../src/shared/protocol.js'
import type { ClientWorkspaceLayoutService } from './workspace-layout-api.js'
import {
  WORKSPACE_COMMAND_CLAIM_METHOD,
  WORKSPACE_COMMAND_RESULT_METHOD,
  WORKSPACE_COMMAND_STATE,
  type WorkspaceCommandSnapshot,
  type WorkspaceOpenPaneRequest,
} from './workspace-commands-api.js'

function request(value: unknown): WorkspaceOpenPaneRequest | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || value.action !== 'open-pane'
    || (value.direction !== 'horizontal' && value.direction !== 'vertical')
    || typeof value.kind !== 'string'
  ) return undefined
  return value as unknown as WorkspaceOpenPaneRequest
}

export function parseWorkspaceCommands(value: unknown): WorkspaceCommandSnapshot {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.requests)) {
    return { version: 1, revision: 0, requests: [] }
  }
  return {
    version: 1,
    revision: typeof value.revision === 'number' ? value.revision : 0,
    requests: value.requests.flatMap((candidate) => {
      const parsed = request(candidate)
      return parsed ? [parsed] : []
    }),
  }
}

class WorkspaceCommandBridge {
  private readonly completed = new Map<string, JsonValue>()
  private readonly clientId = globalThis.crypto.randomUUID()
  private readonly unsubscribes: Array<() => void>
  private draining = false
  private disposed = false

  constructor(
    private readonly host: import('../../src/client/plugin-api.js').ClientHostService,
    private readonly layout: ClientWorkspaceLayoutService,
  ) {
    const changed = (): void => { void this.drain() }
    this.unsubscribes = [host.subscribe(changed), layout.subscribe(changed)]
    changed()
  }

  dispose(): void {
    this.disposed = true
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.completed.clear()
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed || !this.layout.available()) return
    this.draining = true
    try {
      const snapshot = parseWorkspaceCommands(
        this.host.snapshot().snapshot?.extensions[WORKSPACE_COMMAND_STATE],
      )
      const live = new Set(snapshot.requests.map((item) => item.id))
      for (const id of this.completed.keys()) {
        if (!live.has(id)) this.completed.delete(id)
      }
      for (const command of snapshot.requests) {
        if (command.anchorThreadId && !this.layout.hasThread(command.anchorThreadId)) continue
        let response = this.completed.get(command.id)
        if (!response) {
          let claim: JsonValue
          try {
            claim = await this.host.call(WORKSPACE_COMMAND_CLAIM_METHOD, {
              id: command.id,
              clientId: this.clientId,
            })
          } catch {
            continue
          }
          if (!isRecord(claim) || claim.claimed !== true) continue
          try {
            const result = this.layout.openPane(command)
            response = {
              id: command.id,
              clientId: this.clientId,
              success: true,
              result: result as unknown as JsonValue,
            }
          } catch (error) {
            response = {
              id: command.id,
              clientId: this.clientId,
              success: false,
              error: errorMessage(error),
            }
          }
          this.completed.set(command.id, response)
        }
        try {
          await this.host.call(WORKSPACE_COMMAND_RESULT_METHOD, response)
        } catch {
          // Keep the completed result and retry after the transport reconnects.
        }
      }
    } finally {
      this.draining = false
    }
  }
}

const workspaceCommands: BrowserPlugin = (ctx) => {
  const bridge = new WorkspaceCommandBridge(ctx.clientHost, ctx.clientWorkspaceLayout)
  ctx.effect(() => () => bridge.dispose(), 'workspaceCommands.bridge')
}

workspaceCommands.inject = ['clientHost', 'clientWorkspaceLayout']
workspaceCommands.resources = {
  requires: { extensions: [WORKSPACE_COMMAND_STATE] },
}

export default workspaceCommands
