import { Context } from 'cordis'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { clientExtensionRegistryPlugin } from '../src/server/services/client-extension-registry.js'
import { toolRegistryPlugin } from '../src/server/services/tool-registry.js'
import sealPlugin from '../program/plugins/seal.js'
import { SEAL_CLAIM, SEAL_PRESENCE, SEAL_RESULT, SEAL_STATE } from '../program/plugins/seal-api.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SealInbox } from '../program/plugins/seal.js'
import sealBrowserPlugin, { sendToSealTarget } from '../program/plugins/seal.client.js'
import type { SealRequest, SealTarget } from '../program/plugins/seal-api.js'
import type { ClientDraft, ClientUiService } from '../src/client/plugin-api.js'
import type { ClientWorkspaceLayoutService, WorkspacePaneTarget } from '../program/plugins/workspace-layout-api.js'
import { WorkspaceLayoutRegistry, workspacePaneTargets } from '../program/plugins/workspace-layout.client.js'
import type { WorkspaceLayoutState, WorkspaceMoveDirection } from '../program/plugins/workspace-layout-state.js'
import type { ClientSessionService } from '../program/plugins/session-api.js'

const target: SealTarget = { clientId: 'window-a', workspaceId: 'workspace', paneId: 'pane-a', workspace: '/project', threadId: 'thread-a', title: 'Project chat' }
const inboxes: SealInbox[] = []
function inbox(timeout = 15_000) {
  let requests: SealRequest[] = []
  const service = new SealInbox((next) => { requests = next }, timeout)
  inboxes.push(service)
  service.presence({ clientId: target.clientId, focusedAt: 1, target })
  return { service, requests: () => requests }
}
afterEach(() => { for (const service of inboxes) service.dispose(); inboxes.length = 0; vi.useRealTimers() })

describe('Seal inbox', () => {
  it('captures the focused chat before another window or pane is selected', async () => {
    const { service, requests } = inbox()
    const result = service.send({ text: 'hello', context: 'code', mode: 'queue' })
    service.presence({ clientId: 'window-b', focusedAt: 2, target: { ...target, paneId: 'pane-b' } })
    expect(service.target()?.clientId).toBe('window-b')
    const request = requests()[0]!
    expect(request.target).toEqual(target)
    expect(service.claim({ id: request.id, clientId: 'window-b' })).toBe(false)
    expect(service.claim({ id: request.id, clientId: 'window-a' })).toBe(true)
    expect(service.claim({ id: request.id, clientId: 'window-a' })).toBe(false)
    expect(service.result({ id: request.id, clientId: 'window-b', ok: true })).toBe(false)
    expect(service.result({ id: request.id, clientId: 'window-a', ok: true })).toBe(true)
    expect(await result).toEqual({ ok: true, target })
    expect(requests()).toEqual([])
  })
  it('does not fall back to another window when the current window has no focused chat', async () => {
    const { service } = inbox()
    service.presence({ clientId: 'window-b', focusedAt: 2, target: null })
    expect(await service.send({ text: 'hello', context: '', mode: 'queue' })).toMatchObject({ ok: false })
  })
  it('expires disconnected windows and reports uncertain claimed deliveries', async () => {
    vi.useFakeTimers()
    const { service, requests } = inbox(50)
    const result = service.send({ text: 'hello', context: '', mode: 'queue' })
    service.claim({ id: requests()[0]!.id, clientId: 'window-a' })
    await vi.advanceTimersByTimeAsync(51)
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('before retrying') })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(service.target()).toBeUndefined()
  })
  it('resolves pending handoffs on disposal without publishing after teardown', async () => {
    const publish = vi.fn()
    const service = new SealInbox(publish)
    service.presence({ clientId: target.clientId, focusedAt: 1, target })
    const result = service.send({ text: 'hello', context: '', mode: 'queue' })
    service.dispose()
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('unloaded') })
    expect(publish).toHaveBeenCalledTimes(1)
  })
})

function browser(active = false) {
  let threadId = 'thread-a'
  const send = vi.fn(async (_draft: ClientDraft) => undefined)
  const steer = vi.fn(async (_draft: ClientDraft) => undefined)
  const pane = { workspaceId: 'workspace', paneId: 'pane-a', focused: false,
    session: { snapshot: () => ({ threadId, threads: [], session: { workspace: '/project' }, turn: { tag: active ? 'running' : 'idle' } }), send, steer },
  } as unknown as WorkspacePaneTarget
  const other = { ...pane, paneId: 'pane-b', focused: true }
  const layout = { paneTargets: () => [other, pane] } as unknown as ClientWorkspaceLayoutService
  const submit = vi.fn(async (draft: ClientDraft, fallback: (draft: ClientDraft) => Promise<void>) => fallback(draft))
  const ui = { submit } as unknown as ClientUiService
  const request: SealRequest = { id: 'request', text: 'explain this', context: 'local answer = 42', mode: 'queue', target }
  return { send, steer, layout, submit, ui, request, retarget: () => { threadId = 'different-thread' } }
}

describe('Seal chat routing', () => {
  it('publishes the chat to the left immediately when focus moves to a terminal', async () => {
    const f = browser()
    const pane = f.layout.paneTargets()[1]!
    const right = { ...pane, paneId: 'pane-right' }
    const sessions = new Map<string, ClientSessionService>([[pane.paneId, pane.session], [right.paneId, right.session]])
    const state: WorkspaceLayoutState = {
      version: 2, activeViewId: 'workspace', views: [{
        id: 'workspace', name: 'Project', workspace: '/project', focusedPaneId: right.paneId,
        root: { type: 'split', id: 'outer', direction: 'horizontal', ratio: 0.7,
          first: { type: 'split', id: 'inner', direction: 'horizontal', ratio: 0.5,
            first: { type: 'pane', id: pane.paneId, workspace: '/project' },
            second: { type: 'pane', id: 'terminal', kind: 'terminal', workspace: '/project' } },
          second: { type: 'pane', id: right.paneId, workspace: '/project' } },
      }],
    }
    const layout = new WorkspaceLayoutRegistry()
    const bind = () => layout.bindController({ tabs: () => [],
      paneTargets: (direction?: WorkspaceMoveDirection) => workspacePaneTargets(state, sessions, direction),
    } as unknown as Parameters<typeof layout.bindController>[0])
    let unbind = bind()
    const call = vi.fn(async () => ({ ok: true }))
    const ctx = new Context()
    ctx.provide('clientHost', { call, subscribe: () => () => {}, snapshot: () => ({}) } as unknown as Context['clientHost'])
    ctx.provide('clientUi', f.ui)
    ctx.provide('clientWorkspaceLayout', layout)
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('document', { hasFocus: () => true })
    const feature = await ctx.plugin(sealBrowserPlugin, {})
    try {
      await vi.waitFor(() => expect(call).toHaveBeenLastCalledWith(SEAL_PRESENCE, expect.objectContaining({ target: expect.objectContaining({ paneId: right.paneId }) })))
      call.mockClear()
      state.views[0]!.focusedPaneId = 'terminal'
      unbind()
      unbind = bind()
      // No heartbeat or window-focus event: the layout change must report the new destination.
      expect(call).toHaveBeenLastCalledWith(SEAL_PRESENCE, expect.objectContaining({ target: expect.objectContaining({ paneId: pane.paneId }) }))
      expect(state.views[0]!.focusedPaneId).toBe('terminal')
      call.mockClear()
      unbind()
      unbind = bind()
      expect(call).not.toHaveBeenCalled()
    } finally {
      await feature.dispose()
      unbind()
      layout.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('sends editor context to the captured pane through normal submit middleware', async () => {
    const f = browser()
    await sendToSealTarget(f.ui, f.layout, f.request)
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('local answer = 42') })
    expect(f.send.mock.calls[0]?.[0].text).toContain('```seal-context\n')
    const submission = f.submit.mock.calls[0] as unknown as [ClientDraft, unknown, { mode: string; target: { id: string; threadId: string; activeTurn: boolean } }]
    expect(submission[2]).toMatchObject({ mode: 'queue', target: { id: 'workspace:pane-a', threadId: 'thread-a', activeTurn: false } })
  })
  it('lets the existing queue consume messages during an active turn', async () => {
    const f = browser(true)
    f.submit.mockImplementation(async () => undefined)
    await sendToSealTarget(f.ui, f.layout, f.request)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.submit.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ target: expect.objectContaining({ activeTurn: true }) })]))
  })
  it('refuses to redirect a handoff after the pane opens another thread', async () => {
    const f = browser()
    f.retarget()
    await expect(sendToSealTarget(f.ui, f.layout, f.request)).rejects.toThrow('changed before delivery')
    expect(f.send).not.toHaveBeenCalled()
  })
  it('rechecks the target if middleware delays the actual send', async () => {
    const f = browser()
    f.submit.mockImplementation(async (draft, fallback) => { f.retarget(); await fallback(draft) })
    await expect(sendToSealTarget(f.ui, f.layout, f.request)).rejects.toThrow('changed before delivery')
    expect(f.send).not.toHaveBeenCalled()
  })
})


describe('Seal local socket', () => {
  it('delivers a handoff through owned extension state and removes the socket on unload', async () => {
    const directory = await mkdtemp('/tmp/alto-seal-test-')
    const socketPath = directory + '/seal.sock'
    const ctx = new Context()
    const registry = await ctx.plugin(clientExtensionRegistryPlugin)
    const tools = await ctx.plugin(toolRegistryPlugin)
    const feature = await ctx.plugin(sealPlugin, { socketPath })
    try {
      await vi.waitFor(async () => expect((await stat(socketPath)).isSocket()).toBe(true))
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      await ctx.clientExtensions.call(SEAL_PRESENCE, { clientId: target.clientId, focusedAt: 1, target: { ...target } })
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        const client = createConnection(socketPath)
        let data = ''
        client.once('error', reject)
        client.once('connect', () => client.write(JSON.stringify({ version: 1, action: 'send', text: 'hello from Neovim', context: 'code', mode: 'queue' }) + '\n'))
        client.on('data', (chunk) => {
          data += chunk.toString()
          if (data.includes('\n')) { client.end(); resolve(JSON.parse(data)) }
        })
        client.setTimeout(2000, () => { client.destroy(); reject(new Error('socket timeout')) })
      })
      const requests = () => (ctx.clientExtensions.snapshot()[SEAL_STATE] as unknown as { requests: SealRequest[] }).requests
      await vi.waitFor(() => expect(requests()).toHaveLength(1))
      const request = requests()[0]!
      expect(request.text).toBe('hello from Neovim')
      expect(request.target).toEqual(target)
      await expect(ctx.clientExtensions.call(SEAL_CLAIM, { id: request.id, clientId: target.clientId })).resolves.toEqual({ claimed: true })
      await ctx.clientExtensions.call(SEAL_RESULT, { id: request.id, clientId: target.clientId, ok: true })
      await expect(response).resolves.toEqual({ ok: true, target })
    } finally {
      await feature.dispose()
      await registry.dispose()
      await tools.dispose()
      await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await rm(directory, { recursive: true, force: true })
    }
  })
})
