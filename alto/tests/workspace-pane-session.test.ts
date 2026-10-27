import { expect, it, vi } from 'vitest'
import { AgentSessionService } from '../program/plugins/agent-session.client.js'
import type { AgentChat } from '../program/plugins/agent-chats-api.js'
import type { ClientSessionService, ClientSessionSnapshot } from '../program/plugins/session-api.js'
import { restoreWorkspacePaneSession } from '../program/plugins/workspace-layout.client.js'
import type { WorkspacePaneNode } from '../program/plugins/workspace-layout-state.js'
import type { ClientHostService } from '../src/client/plugin-api.js'
import type { HarnessSnapshot, LocalProject } from '../src/shared/protocol.js'

function fixture() {
  const listeners = new Set<() => void>()
  const project: LocalProject = { id: 'project', name: 'Project', primaryRoot: '/repo', roots: ['/repo'], source: 'manual' }
  const harness = { codex: { status: 'failed' }, extensions: {}, pendingRequests: [] } as unknown as HarnessSnapshot
  const state: ClientSessionSnapshot = {
    revision: 0, connected: false, harness, session: { workspace: '/repo', permissionMode: 'ask' },
    turn: { tag: 'idle' }, agentStatus: { state: 'idle', label: 'Ready' }, activities: [],
    hasEarlierActivities: false, loadingEarlierActivities: false, history: { tag: 'ready', entries: [] },
    threads: [], projects: [project], skills: [],
  }
  const openThread = vi.fn(async () => {})
  const selectProject = vi.fn()
  const session = {
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    openThread, selectProject,
  } as unknown as ClientSessionService
  const pane: WorkspacePaneNode = { type: 'pane', id: 'pane', workspace: '/repo', projectId: project.id }
  return { session, state, harness, pane, project, openThread, selectProject, listeners,
    changed: () => { state.revision++; for (const listener of listeners) listener() },
  }
}

it('restores a Claude pane on connection even when Codex has failed, without reopening it on later updates', async () => {
  const f = fixture()
  const chat: AgentChat = {
    summary: { id: 'acp-11111111-1111-1111-1111-111111111111', providerId: 'claude', providerSessionId: 'claude-session', cwd: '/repo',
      title: 'Saved Claude chat', preview: '', createdAt: 1, updatedAt: 1 },
    permissionMode: 'ask', turn: 'idle', activities: [], requests: [],
  }
  const call = vi.fn(async () => chat)
  const host = { call, snapshot: () => ({ connected: f.state.connected, snapshot: f.harness }), subscribe: () => () => {} } as unknown as ClientHostService
  const session = new AgentSessionService(f.session, host)
  const stop = restoreWorkspacePaneSession(session, { ...f.pane, thread: chat.summary })
  try {
    expect(call).not.toHaveBeenCalled()
    f.state.connected = true
    f.changed()
    await vi.waitFor(() => expect(session.snapshot().threadId).toBe(chat.summary.id))
    expect(call).toHaveBeenCalledExactlyOnceWith('agent-chats.open', { id: chat.summary.id })
    expect(f.openThread).not.toHaveBeenCalled()
    f.changed()
    f.state.connected = false
    f.changed()
    f.state.connected = true
    f.changed()
    expect(call).toHaveBeenCalledTimes(1)
  } finally { stop(); session.dispose() }
  expect(f.listeners.size).toBe(0)
})

it('opens a saved native thread on connection so it can start Codex on demand', () => {
  const f = fixture()
  const thread = { id: 'native-thread', cwd: '/repo', title: 'Native', preview: '', createdAt: 1, updatedAt: 1 }
  const stop = restoreWorkspacePaneSession(f.session, { ...f.pane, thread })
  try {
    f.state.connected = true
    f.changed()
    expect(f.openThread).toHaveBeenCalledExactlyOnceWith(thread)
    f.harness.codex.status = 'ready'
    f.changed()
    f.changed()
    expect(f.openThread).toHaveBeenCalledExactlyOnceWith(thread)
    expect(f.selectProject).not.toHaveBeenCalled()
  } finally { stop() }
})

it('restores an empty pane project and leaves explicitly unscoped panes alone', () => {
  const f = fixture()
  f.state.connected = true
  const stop = restoreWorkspacePaneSession(f.session, f.pane)
  expect(f.selectProject).toHaveBeenCalledExactlyOnceWith(f.project)
  stop()
  f.selectProject.mockClear()
  const stopUnscoped = restoreWorkspacePaneSession(f.session, { ...f.pane, unscoped: true })
  expect(f.selectProject).not.toHaveBeenCalled()
  stopUnscoped()
})

it('does not restore a pane after it closes while disconnected', () => {
  const f = fixture()
  const stop = restoreWorkspacePaneSession(f.session, f.pane)
  stop()
  f.state.connected = true
  f.harness.codex.status = 'ready'
  f.changed()
  expect(f.listeners.size).toBe(0)
  expect(f.openThread).not.toHaveBeenCalled()
  expect(f.selectProject).not.toHaveBeenCalled()
})
