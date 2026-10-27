import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProgramPluginView } from '../src/shared/protocol.js'
import {
  filterPluginTree,
  PluginsPanel,
  pluginTree,
} from '../program/plugins/ui/plugins.js'

function plugin(
  id: string,
  name: string,
  description: string,
  parentId?: string,
): ProgramPluginView {
  return {
    id,
    name,
    description,
    protocolVersion: 1,
    ...(parentId ? { parentId } : {}),
    depth: parentId ? 1 : 0,
    enabled: true,
    effectiveEnabled: true,
    state: 'active',
    inject: [],
    provides: [],
    config: {},
    isolate: {},
    intercept: {},
  }
}

describe('Plugins settings', () => {
  it('preserves the program hierarchy while showing product metadata', () => {
    const plugins = [
      plugin('markdown', 'Markdown', 'Renders rich Markdown in conversation messages.'),
      {
        ...plugin(
          'code-blocks',
          'Code Blocks',
          'Adds syntax highlighting and copy controls.',
          'markdown',
        ),
        client: {
          module: 'plugins/code-blocks.client.tsx',
          hash: 'hash',
          url: '/code-blocks.mjs',
          loadedAt: '2026-08-19T00:00:00.000Z',
        },
      },
    ]

    const tree = pluginTree(plugins)
    expect(tree.map(({ plugin: entry, children }) => ({
      id: entry.id,
      children: children.map(({ plugin: child }) => child.id),
    }))).toEqual([{ id: 'markdown', children: ['code-blocks'] }])

    expect(filterPluginTree(tree, 'syntax highlighting').map(({ plugin: entry, children }) => ({
      id: entry.id,
      children: children.map(({ plugin: child }) => child.id),
    }))).toEqual([{ id: 'markdown', children: ['code-blocks'] }])

    const html = renderToStaticMarkup(
      <PluginsPanel plugins={plugins} tools={[]} onToggle={async () => undefined} />,
    )
    expect(html).toContain('Search plugins')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Code Blocks')
    expect(html).not.toContain('plugin-children')
    expect(html).not.toContain('code-blocks.client.tsx')
    expect(html).not.toContain('Runtime graph')
  })

  it('shows when an enabled plugin is waiting for a disabled dependency', () => {
    const entry = plugin(
      'sidebar-hotkeys',
      'Sidebar Hotkeys',
      'Toggles the conversation sidebar.',
    )
    const html = renderToStaticMarkup(
      <PluginsPanel
        plugins={[entry]}
        tools={[]}
        diagnostics={[{
          pluginId: entry.id,
          severity: 'warning',
          message: 'Browser plugin "sidebar-hotkeys" is waiting for service "clientSidebar"',
        }]}
        onToggle={async () => undefined}
      />,
    )

    expect(html).toContain('Waiting')
    expect(html).toContain('plugin-state-pending')
    expect(html).toContain('aria-checked="true"')
  })
})
