import { ChevronRight, Search } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type {
  DynamicToolSpec,
  ProgramPluginView,
} from '../../../src/shared/protocol.js'
import type { ClientProgramDiagnostic } from '../../../src/client/plugin-api.js'

export interface PluginTreeNode {
  plugin: ProgramPluginView
  children: PluginTreeNode[]
}

export function pluginTree(plugins: ProgramPluginView[]): PluginTreeNode[] {
  const nodes = new Map<string, PluginTreeNode>(plugins.map((plugin) => [
    plugin.id,
    { plugin, children: [] },
  ]))
  const roots: PluginTreeNode[] = []

  for (const plugin of plugins) {
    const node = nodes.get(plugin.id)!
    const parent = plugin.parentId ? nodes.get(plugin.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

export function filterPluginTree(
  nodes: PluginTreeNode[],
  query: string,
): PluginTreeNode[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return nodes

  return nodes.flatMap((node) => {
    const matches = [
      node.plugin.name,
      node.plugin.description,
      node.plugin.id,
    ].join(' ').toLocaleLowerCase().includes(normalized)
    const children = filterPluginTree(node.children, normalized)
    if (!matches && children.length === 0) return []
    return [{
      plugin: node.plugin,
      children: matches ? node.children : children,
    }]
  })
}

export function PluginsPanel({
  plugins,
  diagnostics,
  onToggle,
}: {
  plugins: ProgramPluginView[]
  tools: DynamicToolSpec[]
  diagnostics?: ClientProgramDiagnostic[]
  onToggle: (id: string, enabled: boolean) => Promise<unknown>
}): ReactNode {
  const [pending, setPending] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const roots = useMemo(() => pluginTree(plugins), [plugins])
  const selectedRoots = category === 'all'
    ? roots
    : roots.filter(({ plugin }) => plugin.id === category)
  const visibleTree = filterPluginTree(selectedRoots, query)
  const searching = query.trim().length > 0

  const toggle = async (plugin: ProgramPluginView): Promise<void> => {
    setPending(plugin.id)
    setProblem(undefined)
    try {
      await onToggle(plugin.id, !plugin.enabled)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(undefined)
    }
  }

  const toggleExpanded = (pluginId: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(pluginId)) next.delete(pluginId)
      else next.add(pluginId)
      return next
    })
  }

  const selectCategory = (pluginId: string): void => {
    setCategory(pluginId)
    if (pluginId === 'all') return
    setExpanded((current) => new Set(current).add(pluginId))
  }

  const renderNode = (
    { plugin, children }: PluginTreeNode,
    depth = 0,
  ): ReactNode => {
    const inheritedOff = plugin.enabled && !plugin.effectiveEnabled
    const waiting = diagnostics?.some((diagnostic) => (
      diagnostic.pluginId === plugin.id
      && diagnostic.severity === 'warning'
      && diagnostic.message.includes(' is waiting for ')
    )) ?? false
    const visibleState = waiting ? 'pending' : plugin.state
    const stateLabel = waiting
      ? 'Waiting'
      : plugin.state === 'active'
      ? undefined
      : inheritedOff
        ? 'Parent disabled'
        : plugin.state === 'disabled'
          ? 'Off'
          : plugin.state
    const expandable = children.length > 0
    const isExpanded = expandable && (searching || expanded.has(plugin.id))

    return (
      <div
        className={`plugin-tree-node ${expandable ? 'has-children' : ''} ${depth === 0 ? 'is-root' : ''}`}
        key={plugin.id}
      >
        <div className={`plugin-row ${inheritedOff ? 'inherited-off' : ''}`}>
          {expandable ? (
            <button
              className={`plugin-disclosure ${isExpanded ? 'is-expanded' : ''}`}
              type="button"
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${plugin.name}`}
              onClick={() => toggleExpanded(plugin.id)}
            >
              <ChevronRight size={14} />
            </button>
          ) : (
            <span className="plugin-disclosure-spacer" aria-hidden="true" />
          )}
          <div className="plugin-identity">
            <div className="plugin-name-line">
              <strong>{plugin.name}</strong>
              {stateLabel && <span className={`plugin-state plugin-state-${visibleState}`}>{stateLabel}</span>}
            </div>
            <span>{plugin.description}</span>
          </div>
          <button
            className={`plugin-switch ${plugin.enabled ? 'on' : ''}`}
            type="button"
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={`${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
            title={inheritedOff
              ? 'Enabled here, but inactive because a parent plugin is off'
              : `${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
            disabled={pending !== undefined}
            onClick={() => void toggle(plugin)}
          >
            <span />
          </button>
        </div>
        {isExpanded && (
          <div className="plugin-children" role="group">
            {children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  return (
    <section className="plugins-workspace" aria-label="Plugins">
      <div className="plugins-controls">
        <label className="plugins-search">
          <Search size={14} />
          <input
            type="search"
            value={query}
            aria-label="Search plugins"
            placeholder="Search plugins…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="plugin-category-filters" role="group" aria-label="Plugin categories">
          <button
            className={category === 'all' ? 'is-selected' : ''}
            type="button"
            aria-pressed={category === 'all'}
            onClick={() => selectCategory('all')}
          >
            All
          </button>
          {roots.map(({ plugin }) => (
            <button
              className={category === plugin.id ? 'is-selected' : ''}
              type="button"
              aria-pressed={category === plugin.id}
              onClick={() => selectCategory(plugin.id)}
              key={plugin.id}
            >
              {plugin.name}
            </button>
          ))}
        </div>
      </div>

      <div className="plugin-list" aria-label="Plugin tree">
        {visibleTree.map((node) => renderNode(node))}
        {!visibleTree.length && (
          <div className="plugins-empty">
            {plugins.length ? 'No plugins match this search.' : 'No program entries'}
          </div>
        )}
      </div>

      {(diagnostics?.length ?? 0) > 0 && (
        <section className="plugin-diagnostics" aria-label="Plugin diagnostics">
          <div className="plugin-section-label">Diagnostics</div>
          {diagnostics?.map((diagnostic, index) => (
            <div className={`plugin-diagnostic plugin-diagnostic-${diagnostic.severity}`} key={`${diagnostic.pluginId ?? 'program'}:${index}`}>
              {diagnostic.message}
            </div>
          ))}
        </section>
      )}

      {problem && <div className="plugin-problem" role="alert">{problem}</div>}
    </section>
  )
}
