import { useLayoutEffect, type RefObject } from 'react'
import { agentsPanelTop } from './orchestrator-panel.js'

/** Measure pane chrome so tabbed and split layouts cannot cover their controls. */
export function useAgentsPanelLayout(panel: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = document.documentElement
    let frame = 0
    let observed = new Set<Element>()
    const measure = (): void => {
      frame = 0
      const views = document.querySelector<HTMLElement>('.workspace-views')
      const headers = [...document.querySelectorAll<HTMLElement>('.workspace-view:not([hidden]) .workspace-pane-header')]
      const tabbar = document.querySelector<HTMLElement>('.workspace-tabbar')
      const targets = new Set<Element>([...headers, ...(views ? [views] : []), ...(tabbar ? [tabbar] : []), ...document.querySelectorAll('.workspace-view:not([hidden])'), ...(panel.current ? [panel.current] : [])])
      for (const element of observed) if (!targets.has(element)) resize.unobserve(element)
      for (const element of targets) if (!observed.has(element)) resize.observe(element)
      observed = targets
      const top = agentsPanelTop(headers.map((header) => header.getBoundingClientRect()), tabbar?.getBoundingClientRect().bottom ?? 52)
      const value = Math.round(top) + 'px'
      if (root.style.getPropertyValue('--agents-controls-bottom') !== value) root.style.setProperty('--agents-controls-bottom', value)
    }
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(measure) }
    const resize = new ResizeObserver(schedule)
    const mutation = new MutationObserver((records) => {
      if (records.some((record) => {
        if (record.type === 'attributes') return record.target instanceof Element && (record.target === root || record.target.matches('.workspace-view, .workspace-chat-pane, .workspace-split'))
        return [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches('.workspace-view, .workspace-pane-header, .workspace-layout-root') || node.querySelector('.workspace-pane-header')))
      })) schedule()
    })
    mutation.observe(document.querySelector('.shell-kernel') ?? document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] })
    // Sidebar pinning can change which pane headers are visible.
    mutation.observe(root, { attributes: true, attributeFilter: ['data-sidebar-mode'] })
    window.addEventListener('resize', schedule)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutation.disconnect()
      window.removeEventListener('resize', schedule)
      root.style.removeProperty('--agents-controls-bottom')
      delete root.dataset.agentsDocked
    }
  }, [panel])
}
