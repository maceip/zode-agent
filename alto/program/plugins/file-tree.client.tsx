import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Search,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type {
  BrowserPlugin,
  ClientHostService,
} from '../../src/client/plugin-api.js'
import type { CodeExplorerProps } from './code-explorer-api.js'
import {
  FILE_TREE_LIST_METHOD,
  parseFileTreeSnapshot,
} from './file-tree-api.js'
import styles from './file-tree.css'

interface TreeRow {
  path: string
  name: string
  depth: number
  directory: boolean
}

function relativePath(workspace: string, value: string): string {
  const normalized = value.replaceAll('\\', '/')
  const root = workspace.replaceAll('\\', '/').replace(/\/$/u, '')
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized.replace(/^\.\//u, '')
}

function directoryPaths(paths: readonly string[]): Set<string> {
  const result = new Set<string>()
  for (const filePath of paths) {
    const parts = filePath.split('/').filter(Boolean)
    for (let index = 1; index < parts.length; index += 1) {
      result.add(parts.slice(0, index).join('/'))
    }
  }
  return result
}

function treeRows(paths: readonly string[], expanded: ReadonlySet<string>): TreeRow[] {
  const directories = directoryPaths(paths)
  const children = new Map<string, Set<string>>()
  const add = (entry: string): void => {
    const separator = entry.lastIndexOf('/')
    const parent = separator < 0 ? '' : entry.slice(0, separator)
    const entries = children.get(parent) ?? new Set<string>()
    entries.add(entry)
    children.set(parent, entries)
  }
  for (const directory of directories) add(directory)
  for (const filePath of paths) add(filePath)

  const rows: TreeRow[] = []
  const visit = (parent: string, depth: number): void => {
    const entries = [...(children.get(parent) ?? [])].toSorted((left, right) => {
      const leftDirectory = directories.has(left)
      const rightDirectory = directories.has(right)
      if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1
      return left.localeCompare(right)
    })
    for (const entry of entries) {
      const directory = directories.has(entry)
      rows.push({
        path: entry,
        name: entry.slice(entry.lastIndexOf('/') + 1),
        depth,
        directory,
      })
      if (directory && expanded.has(entry)) visit(entry, depth + 1)
    }
  }
  visit('', 0)
  return rows
}

function parentDirectories(filePath: string): string[] {
  const parts = filePath.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

function FileTree({
  workspace,
  paths: constrained,
  activePath,
  label,
  select,
  host,
}: CodeExplorerProps & { host: ClientHostService }): ReactNode {
  const [loaded, setLoaded] = useState<string[]>([])
  const [problem, setProblem] = useState<string>()
  const [query, setQuery] = useState('')
  const normalizedActive = activePath ? relativePath(workspace, activePath) : undefined
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(
    normalizedActive ? parentDirectories(normalizedActive) : [],
  ))

  useEffect(() => {
    if (constrained) return
    let current = true
    setProblem(undefined)
    void host.call(FILE_TREE_LIST_METHOD, { workspace }).then((value) => {
      if (current) setLoaded(parseFileTreeSnapshot(value).paths)
    }).catch((error: unknown) => {
      if (current) setProblem(error instanceof Error ? error.message : String(error))
    })
    return () => { current = false }
  }, [constrained, host, workspace])

  useEffect(() => {
    if (!normalizedActive) return
    setExpanded((current) => new Set([...current, ...parentDirectories(normalizedActive)]))
  }, [normalizedActive])

  const files = useMemo(() => (
    constrained ?? loaded
  ).map((value) => relativePath(workspace, value)).filter(Boolean), [constrained, loaded, workspace])
  const visibleFiles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return normalized ? files.filter((file) => file.toLocaleLowerCase().includes(normalized)) : files
  }, [files, query])
  const effectiveExpanded = query ? directoryPaths(visibleFiles) : expanded
  const rows = useMemo(() => treeRows(visibleFiles, effectiveExpanded), [effectiveExpanded, visibleFiles])

  const toggle = (directory: string): void => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(directory)) next.delete(directory)
    else next.add(directory)
    return next
  })

  return (
    <aside className="file-tree" aria-label={label}>
      <label className="file-tree-search">
        <Search size={12} strokeWidth={1.6} />
        <input value={query} placeholder="Filter files" aria-label="Filter files" onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="file-tree-rows" role="tree">
        {problem && <div className="file-tree-state" role="alert">{problem}</div>}
        {!problem && rows.length === 0 && <div className="file-tree-state">No files</div>}
        {rows.map((row) => {
          const active = !row.directory && row.path === normalizedActive
          const open = row.directory && effectiveExpanded.has(row.path)
          return (
            <button
              className={['file-tree-row', active ? 'is-active' : ''].filter(Boolean).join(' ')}
              type="button"
              role="treeitem"
              aria-selected={active}
              aria-expanded={row.directory ? open : undefined}
              title={row.path}
              style={{ '--file-tree-depth': row.depth } as CSSProperties}
              onClick={() => row.directory
                ? toggle(row.path)
                : select(`${workspace.replace(/[\\/]$/u, '')}/${row.path}`)}
              key={`${row.directory ? 'd' : 'f'}:${row.path}`}
            >
              {row.directory
                ? <><ChevronRight className={open ? 'is-open' : ''} size={11} /><span className="file-tree-kind">{open ? <FolderOpen size={13} /> : <Folder size={13} />}</span></>
                : <><span className="file-tree-indent" /><span className="file-tree-kind"><File size={12} /></span></>}
              <span>{row.name}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

const fileTreeClient: BrowserPlugin = (ctx) => {
  ctx.clientCodeExplorer.register(ctx, {
    id: 'file-tree',
    component: (props) => <FileTree {...props} host={ctx.clientHost} />,
  })
  ctx.clientUi.registerStyle(ctx, 'file-tree', String(styles))
}

fileTreeClient.inject = ['clientCodeExplorer', 'clientHost', 'clientUi']

export default fileTreeClient
