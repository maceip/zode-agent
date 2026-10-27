import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clientStyles, type BrowserPlugin } from '../../src/client/plugin-api.js'
import type {} from './hotkeys-api.js'
import { OptionalThreadStatusService, aggregateThreadWorkStatus, type ClientThreadStatusService } from './thread-status-api.js'
import { ThreadStatusIndicator } from './ui/thread-status.js'
import { TAB_SWITCHER_ID, WorkspaceTabSwitcher, releasesTabSwitcher, type TabSwitcherSnapshot } from './workspace-tab-switcher.js'
import styles from './workspace-tab-switcher.css'

export function TabSwitcherPopup({ controller, state, threadStatus }: {
  controller: WorkspaceTabSwitcher
  state: TabSwitcherSnapshot
  threadStatus: ClientThreadStatusService
}): ReactNode {
  const status = useSyncExternalStore(threadStatus.subscribe, threadStatus.snapshot)
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement
    const element = list.current
    element?.focus({ preventScroll: true })
    return () => {
      if (controller.restoreFocus && previous instanceof HTMLElement && previous.isConnected
        && (document.activeElement === document.body || element?.contains(document.activeElement))) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [controller])
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [state.selectedId])

  return <div className={clientStyles.overlayLayer + ' workspace-tab-switcher-layer'} onPointerDown={() => controller.cancel()}>
    <section className={clientStyles.floatingPanel + ' workspace-tab-switcher'} role="dialog" aria-modal="true" aria-label="Recent tabs" data-native-overlay={TAB_SWITCHER_ID} onPointerDown={(event) => event.stopPropagation()}>
      <div ref={list} className="workspace-tab-switcher-list" role="listbox" tabIndex={0} aria-label="Workspace tabs, most recent first" aria-activedescendant={'recent-tab-' + state.selectedId}>
        {state.tabs.map((tab) => <button key={tab.id} id={'recent-tab-' + tab.id} type="button" role="option" tabIndex={-1} className={tab.active ? 'is-current' : undefined} aria-current={tab.active ? 'page' : undefined} aria-selected={tab.id === state.selectedId} title={tab.title} onClick={() => controller.commit(tab.id)}>
          <span className="workspace-tab-switcher-status"><ThreadStatusIndicator status={aggregateThreadWorkStatus(status, tab.threadIds)} /></span>
          <span className="workspace-tab-switcher-title">{tab.title}</span>
        </button>)}
      </div>
    </section>
  </div>
}

function TabSwitcherRoot({ controller, threadStatus }: { controller: WorkspaceTabSwitcher; threadStatus: ClientThreadStatusService }): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  return state.selectedId ? createPortal(<TabSwitcherPopup controller={controller} state={state} threadStatus={threadStatus} />, document.querySelector('.shell-kernel') ?? document.body) : null
}

const workspaceTabSwitcher: BrowserPlugin = (ctx) => {
  let storage: Storage | undefined
  try { storage = window.localStorage } catch {}
  const threadStatus = new OptionalThreadStatusService(ctx)
  ctx.effect(() => () => threadStatus.dispose(), 'workspace-tab-switcher.status')
  const controller = new WorkspaceTabSwitcher(ctx.clientWorkspaceLayout, ctx.clientUi.overlays, storage)
  ctx.effect(() => controller.activate(), 'workspace-tab-switcher.lifecycle')
  ctx.effect(() => {
    const keyup = (event: KeyboardEvent): void => {
      if (controller.snapshot().selectedId && releasesTabSwitcher(event)) controller.commit()
    }
    const keydown = (event: KeyboardEvent): void => {
      if (!controller.snapshot().selectedId || event.isComposing || event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        controller.cancel()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        controller.commit()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        controller.cycle(event.key === 'ArrowDown' ? 1 : -1)
      }
    }
    const blur = (): void => controller.cancel()
    const visibility = (): void => { if (document.visibilityState === 'hidden') controller.cancel() }
    window.addEventListener('keyup', keyup, true)
    window.addEventListener('keydown', keydown, true)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('keyup', keyup, true)
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, 'workspace-tab-switcher.keys')
  for (const direction of [1, -1] as const) {
    ctx.clientHotkeys.registerAction(ctx, {
      id: direction === 1 ? 'workspace.tab.recent-next' : 'workspace.tab.recent-previous',
      label: direction === 1 ? 'Next recently used tab' : 'Previous recently used tab',
      category: 'Workspace',
      binding: { kind: 'global', key: 'Tab', alt: true, ...(direction === -1 ? { shift: true } : {}) },
      repeat: true,
      enabled: controller.canCycle,
      run: () => controller.cycle(direction),
    })
  }
  ctx.clientUi.registerRoot(ctx, 'workspace-tab-switcher', () => <TabSwitcherRoot controller={controller} threadStatus={threadStatus} />)
  ctx.clientUi.registerStyle(ctx, 'workspace-tab-switcher', String(styles))
}
workspaceTabSwitcher.inject = ['clientWorkspaceLayout', 'clientUi', 'clientHotkeys']
export default workspaceTabSwitcher
