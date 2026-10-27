import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChatNotificationsController,
  completionNotificationTarget,
  openNotificationChat,
} from '../program/plugins/chat-notifications.client.js'
import type {
  ClientConversationService,
  ClientSessionSnapshot,
} from '../program/plugins/session-api.js'
import type {
  ClientThreadStatusService,
  ClientThreadStatusSnapshot,
} from '../program/plugins/thread-status-api.js'
import type { ClientWorkspaceLayoutService } from '../program/plugins/workspace-layout-api.js'
import type { ThreadSummary } from '../src/shared/protocol.js'
import type { AgentTask } from '../program/plugins/orchestrator-api.js'

const completedThread: ThreadSummary = {
  id: 'thread-completed',
  title: 'Completed chat',
  preview: 'Completed chat',
  cwd: '/tmp/project',
  createdAt: 1,
  updatedAt: 2,
  projectId: 'project-1',
}

const parentThread: ThreadSummary = {
  ...completedThread, id: 'parent-chat', title: 'Coordinate the work', cwd: '/tmp/parent-project',
}
const childTask: AgentTask = {
  id: 'review', title: 'Review the change',
  parentThreadId: parentThread.id, parentTitle: parentThread.title,
  threadId: completedThread.id, workspace: completedThread.cwd,
  status: 'done', activity: '', result: 'Looks good', createdAt: 1, updatedAt: 2,
}

function completionNotificationHarness(options: {
  child?: boolean
  parentInHistory?: boolean
  focusedThreadId?: string
  existingPane?: boolean
  completedInHistory?: boolean
  background?: boolean
} = {}) {
  let statusSnapshot: ClientThreadStatusSnapshot = {
    revision: 1,
    running: [completedThread.id],
    finished: [],
  }
  let statusListener = (): void => undefined
  const status = {
    snapshot: () => statusSnapshot,
    subscribe: (listener: () => void) => {
      statusListener = listener
      return () => { statusListener = () => undefined }
    },
    acknowledge: vi.fn(),
  } as ClientThreadStatusService
  let session = {
    threadId: options.focusedThreadId ?? 'different-thread',
    threads: [...(options.completedInHistory !== false ? [completedThread] : []), ...(options.parentInHistory !== false ? [parentThread] : [])],
    ...(options.child ? { harness: { extensions: { orchestrator: { revision: 1, tasks: [childTask] } } } } : {}),
  } as unknown as ClientSessionSnapshot
  const refreshHistory = vi.fn(async () => {})
  const conversation = {
    snapshot: () => session,
    refreshHistory,
  } as unknown as ClientConversationService
  const layout = {
    focusThread: vi.fn(() => options.existingPane === true),
    openPane: vi.fn(),
  }
  const notifications: NotificationOptions[] = []
  const instances: FakeNotification[] = []
  const titles: string[] = []
  const storage = new Map<string, string>()

  class FakeNotification {
    static permission: NotificationPermission = 'granted'
    static requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onclick: (() => void) | null = null

    constructor(title: string, options?: NotificationOptions) {
      notifications.push(options ?? {})
      titles.push(title)
      instances.push(this)
    }

    close(): void {}
  }

  vi.stubGlobal('window', {
    Notification: FakeNotification,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    focus: vi.fn(),
  })
  vi.stubGlobal('document', { visibilityState: options.background ? 'hidden' : 'visible', hasFocus: () => !options.background })

  const controller = new ChatNotificationsController(status, conversation, layout as unknown as ClientWorkspaceLayoutService)
  const dispose = controller.activate()
  return {
    controller,
    complete: () => {
      statusSnapshot = {
        revision: 2,
        running: [],
        finished: [completedThread.id],
      }
      statusListener()
    },
    notifications,
    instances,
    titles,
    layout,
    refreshHistory,
    setThreads: (threads: ThreadSummary[]) => { session = { ...session, threads } },
    storedPreference: () => JSON.parse(storage.get('alto.chat-notifications') ?? '{}') as Record<string, unknown>,
    dispose,
  }
}

describe('chat notifications', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('focuses an existing pane for the completed chat', () => {
    const focusThread = vi.fn(() => true)
    const openPane = vi.fn()
    const layout = {
      focusThread,
      openPane,
    } as unknown as ClientWorkspaceLayoutService

    openNotificationChat(completedThread, layout)

    expect(focusThread).toHaveBeenCalledWith(completedThread.id)
    expect(openPane).not.toHaveBeenCalled()
  })

  it('opens an independent pane instead of replacing the focused chat', () => {
    const focusThread = vi.fn(() => false)
    const openPane = vi.fn(() => ({ workspaceId: 'workspace-current', paneId: 'pane-new' }))
    const layout = {
      focusThread,
      openPane,
    } as unknown as ClientWorkspaceLayoutService

    openNotificationChat(completedThread, layout)

    expect(focusThread).toHaveBeenCalledWith(completedThread.id)
    expect(openPane).toHaveBeenCalledWith({
      direction: 'horizontal',
      kind: 'chat',
      thread: completedThread,
      workspace: '/tmp/project',
      projectId: 'project-1',
    })
  })

  it('makes completion notifications silent by default', () => {
    const harness = completionNotificationHarness()

    expect(harness.controller.snapshot().playSound).toBe(false)
    harness.complete()

    expect(harness.notifications).toEqual([
      expect.objectContaining({ silent: true }),
    ])
    harness.dispose()
  })

  it('persists an opt-in to notification sounds', () => {
    const harness = completionNotificationHarness()

    harness.controller.setPlaySound(true)
    harness.complete()

    expect(harness.controller.snapshot().playSound).toBe(true)
    expect(harness.storedPreference()).toMatchObject({ playSound: true })
    expect(harness.notifications).toEqual([
      expect.objectContaining({ silent: false }),
    ])
    harness.dispose()
  })

  it('focuses an existing main chat on a notification click', () => {
    const h = completionNotificationHarness({ existingPane: true })
    h.complete()
    expect(h.titles).toEqual(['Agent finished'])
    expect(h.notifications[0]).toMatchObject({
      body: completedThread.title, tag: 'alto-chat-finished-thread-completed',
    })
    h.instances[0]!.onclick!()
    expect(h.layout.focusThread).toHaveBeenCalledWith(completedThread.id)
    expect(h.layout.openPane).not.toHaveBeenCalled()
    h.dispose()
  })

  it('opens a completed main chat at its own workspace if its pane is closed', () => {
    const h = completionNotificationHarness()
    h.complete()
    h.instances[0]!.onclick!()
    expect(h.layout.openPane).toHaveBeenCalledWith(expect.objectContaining({
      thread: completedThread, workspace: completedThread.cwd, projectId: completedThread.projectId,
    }))
    h.dispose()
  })

  it.each([false, true])('does not notify for subagents when Alto is in the background: %s', (background) => {
    const h = completionNotificationHarness({ child: true, background })
    h.complete()
    expect(h.instances).toHaveLength(0)
    expect(h.refreshHistory).not.toHaveBeenCalled()
    h.dispose()
  })

  it('ignores unknown subagents even without Agents metadata', async () => {
    const h = completionNotificationHarness({ completedInHistory: false })
    h.complete()
    await vi.waitFor(() => expect(h.refreshHistory).toHaveBeenCalled())
    expect(h.instances).toHaveLength(0)
    expect(h.layout.openPane).not.toHaveBeenCalled()
    h.dispose()
  })

  it('notifies for a newly completed main chat after refreshing its history entry', async () => {
    const h = completionNotificationHarness({ completedInHistory: false })
    h.refreshHistory.mockImplementation(async () => { h.setThreads([completedThread]) })
    h.complete()
    await vi.waitFor(() => expect(h.instances).toHaveLength(1))
    expect(h.titles).toEqual(['Agent finished'])
    h.dispose()
  })

  it('keeps subagents silent even with visible-chat notifications and sounds enabled', () => {
    const h = completionNotificationHarness({ child: true, focusedThreadId: parentThread.id })
    h.controller.setNotifyCurrentChat(true)
    h.controller.setPlaySound(true)
    h.complete()
    expect(h.instances).toHaveLength(0)
    h.dispose()
  })

  it('preserves the visible-chat notification preference for main chats', () => {
    const h = completionNotificationHarness({ focusedThreadId: completedThread.id })
    h.complete()
    expect(h.instances).toHaveLength(0)
    h.dispose()
    const optedIn = completionNotificationHarness({ focusedThreadId: completedThread.id })
    optedIn.controller.setNotifyCurrentChat(true)
    optedIn.complete()
    expect(optedIn.instances).toHaveLength(1)
    optedIn.dispose()
  })

  it('does not navigate from a stale notification after the plugin unloads', () => {
    const h = completionNotificationHarness()
    h.complete()
    h.dispose()
    h.instances[0]!.onclick!()
    expect(h.layout.focusThread).not.toHaveBeenCalled()
    expect(h.layout.openPane).not.toHaveBeenCalled()
  })

  it.each(['done', 'failed', 'stopped'] as const)('does not create notification targets for %s subagents', (status) => {
    const session = {
      threads: [parentThread],
      harness: { extensions: { orchestrator: { revision: 1, tasks: [{ ...childTask, status }] } } },
    } as unknown as ClientSessionSnapshot
    expect(completionNotificationTarget(completedThread.id, session)).toBeUndefined()
  })
})
