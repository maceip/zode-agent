import { Context, type Plugin } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  BrowserRegistry,
  browserStartPagesForWorkspace,
  initialBrowserTabs,
  normalizeBrowserInput,
  parseBrowserTabs,
  reconcileBrowserTabs,
} from '../program/plugins/browser-workspace.client.js'

const docs = {
  id: 'docs',
  title: 'Project docs',
  url: 'https://example.com/docs',
}

describe('browser workspace pane', () => {
  it('normalizes local and remote addresses without allowing native schemes', () => {
    expect(normalizeBrowserInput('127.0.0.1:4317')).toBe('http://127.0.0.1:4317/')
    expect(normalizeBrowserInput('example.com/docs')).toBe('https://example.com/docs')
    expect(() => normalizeBrowserInput('file:///etc/passwd')).toThrow('only support http and https')
  })

  it('filters plugin-defined start pages by workspace', () => {
    const isAtlasWorkspace = (workspace: { name: string }): boolean => workspace.name === 'atlas'
    expect(browserStartPagesForWorkspace([
      docs,
      { ...docs, id: 'restricted', availableIn: isAtlasWorkspace },
    ], { key: 'beacon', name: 'beacon', path: '/work/beacon' }).map((page) => page.id))
      .toEqual(['docs'])
  })

  it('restores tabs, adds newly loaded start pages, and removes unloaded ones', () => {
    const initial = initialBrowserTabs([docs])
    const withBlank = {
      ...initial,
      tabs: [...initial.tabs, { id: 'browser-1', title: 'Docs', url: 'https://docs.example.com/' }],
      nextOrdinal: 2,
    }
    const added = reconcileBrowserTabs(withBlank, [docs, {
      id: 'metrics',
      title: 'Metrics',
      url: 'https://example.com/metrics',
    }])
    expect(added.tabs.map((tab) => tab.startPageId ?? tab.id))
      .toEqual(['docs', 'browser-1', 'metrics'])

    const removed = reconcileBrowserTabs(added, [])
    expect(removed.tabs).toEqual([{ id: 'browser-1', title: 'Docs', url: 'https://docs.example.com/' }])
  })

  it('repairs malformed active state while retaining valid browser tabs', () => {
    expect(parseBrowserTabs({
      version: 1,
      activeId: 'missing',
      nextOrdinal: 1,
      hiddenStartPageIds: [],
      tabs: [{ id: 'browser-4', title: 'Docs', url: 'https://example.com/' }],
    }, [])).toMatchObject({
      activeId: 'browser-4',
      nextOrdinal: 5,
    })
  })

  it('removes start pages with their owning browser fiber', async () => {
    const root = new Context()
    const registry = new BrowserRegistry()
    const plugin: Plugin = (ctx) => {
      registry.registerStartPage(ctx, docs)
    }
    const fiber = await root.plugin(plugin)

    expect(registry.snapshot().startPages.map((page) => page.id)).toEqual(['docs'])
    await fiber.dispose()
    expect(registry.snapshot().startPages).toEqual([])
  })
})
