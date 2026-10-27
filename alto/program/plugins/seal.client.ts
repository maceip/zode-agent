import { sealMessageText } from './seal-context.js'
import type { BrowserPlugin, ClientDraft, ClientHostService, ClientUiService } from '../../src/client/plugin-api.js'
import { errorMessage, isRecord, type JsonValue } from '../../src/shared/protocol.js'
import type { ClientWorkspaceLayoutService, WorkspacePaneTarget } from './workspace-layout-api.js'
import { SEAL_CLAIM, SEAL_PRESENCE, SEAL_RESULT, SEAL_STATE, type SealRequest, type SealTarget } from './seal-api.js'

function matches(pane: WorkspacePaneTarget, target: SealTarget): boolean {
  return pane.workspaceId === target.workspaceId && pane.paneId === target.paneId
    && pane.session.snapshot().threadId === target.threadId
    && pane.session.snapshot().session.workspace === target.workspace
}

export async function sendToSealTarget(ui: ClientUiService, layout: ClientWorkspaceLayoutService, request: SealRequest): Promise<void> {
  const pane = layout.paneTargets().find((candidate) => matches(candidate, request.target))
  if (!pane) throw new Error('The Alto chat changed before delivery; check the intended chat and send again')
  const draft: ClientDraft = {
    text: sealMessageText(request.text, request.context),
    images: [], attachments: [], skills: [],
  }
  const send = (forwarded: ClientDraft): Promise<void> => {
    if (!matches(pane, request.target)) throw new Error('The Alto chat changed before delivery')
    return pane.session.send(forwarded)
  }
  await ui.submit(draft, send, { mode: request.mode, target: {
    id: `${pane.workspaceId}:${pane.paneId}`,
    ...(request.target.threadId ? { threadId: request.target.threadId } : {}),
    activeTurn: pane.session.snapshot().turn.tag !== 'idle',
    send,
    steer: (forwarded) => {
      if (!matches(pane, request.target)) throw new Error('The Alto chat changed before delivery')
      return pane.session.steer(forwarded)
    },
  } })
}

class SealBrowserBridge {
  private readonly clientId = crypto.randomUUID()
  private readonly completed = new Map<string, JsonValue>()
  private focusedAt = document.hasFocus() ? Date.now() : 0
  private disposed = false
  private draining = false
  private reporting = false
  private reportAgain = false
  private readonly unsubscribes: Array<() => void>
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly focused = (): void => { this.focusedAt = Date.now(); void this.report() }

  constructor(private readonly host: ClientHostService, private readonly ui: ClientUiService, private readonly layout: ClientWorkspaceLayoutService) {
    this.unsubscribes = [host.subscribe(() => { void this.drain() }), layout.subscribe(() => { void this.report(); void this.drain() })]
    window.addEventListener('focus', this.focused)
    this.heartbeat = setInterval(() => { void this.report(); void this.drain() }, 3000)
    void this.report()
    void this.drain()
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.heartbeat)
    window.removeEventListener('focus', this.focused)
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.completed.clear()
  }

  private async report(): Promise<void> {
    if (this.disposed) return
    if (this.reporting) { this.reportAgain = true; return }
    this.reporting = true
    try {
      do {
        this.reportAgain = false
        const pane = this.layout.paneTargets().find((candidate) => candidate.focused)
          ?? this.layout.paneTargets('left')[0]
        const state = pane?.session.snapshot()
        const target = pane && state ? {
          workspaceId: pane.workspaceId, paneId: pane.paneId, workspace: state.session.workspace,
          ...(state.threadId ? { threadId: state.threadId } : {}),
          title: state.threads.find((thread) => thread.id === state.threadId)?.title ?? 'New chat',
        } : null
        await this.host.call(SEAL_PRESENCE, { clientId: this.clientId, focusedAt: this.focusedAt, target })
      } while (this.reportAgain && !this.disposed)
    } catch { /* Retry presence when the browser connection recovers. */ }
    finally { this.reporting = false }
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.draining) return
    this.draining = true
    try {
      const state = this.host.snapshot().snapshot?.extensions[SEAL_STATE]
      if (!isRecord(state) || !Array.isArray(state.requests)) return
      const requests = state.requests as unknown as SealRequest[]
      const live = new Set(requests.map((request) => request.id))
      for (const id of this.completed.keys()) if (!live.has(id)) this.completed.delete(id)
      for (const request of requests) {
        if (this.disposed) return
        if (request.target.clientId !== this.clientId) continue
        let response = this.completed.get(request.id)
        if (!response) {
          const claim = await this.host.call(SEAL_CLAIM, { id: request.id, clientId: this.clientId })
          if (this.disposed) return
          if (!isRecord(claim) || claim.claimed !== true) continue
          try {
            await sendToSealTarget(this.ui, this.layout, request)
            response = { id: request.id, clientId: this.clientId, ok: true }
          } catch (error) {
            response = { id: request.id, clientId: this.clientId, ok: false, error: errorMessage(error) }
          }
          if (this.disposed) return
          this.completed.set(request.id, response)
        }
        await this.host.call(SEAL_RESULT, response)
      }
    } catch { /* Retain completed results so reconnecting cannot send twice. */ }
    finally { this.draining = false }
  }
}

const seal: BrowserPlugin = (ctx) => {
  ctx.effect(() => {
    const bridge = new SealBrowserBridge(ctx.clientHost, ctx.clientUi, ctx.clientWorkspaceLayout)
    return () => bridge.dispose()
  }, 'seal.browserBridge')
}
seal.inject = ['clientHost', 'clientUi', 'clientWorkspaceLayout']
seal.resources = { requires: { extensions: [SEAL_STATE] } }
export default seal
