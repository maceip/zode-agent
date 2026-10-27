import {
  Folder,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  LocalProject,
  ThreadSummary,
} from '../../../src/shared/protocol.js'
import { threadRecencyAt } from '../../../src/shared/protocol.js'
import type { ThreadWorkStatus } from '../thread-status-api.js'
import type { HistoryEntryDecorationProps } from '../sidebar-decorations-api.js'
import { ThreadStatusIndicator } from './thread-status.js'

import { groupThreadsByProject, PROJECT_PREVIEW_LIMIT, threadHistoryTitle, type HistoryState } from './history-model.js'
export { activitiesFromThread, groupThreadsByProject, historyEntries, OTHER_PROJECT_ID, PROJECT_PREVIEW_LIMIT, projectForWorkspace, threadHistoryTitle, withThreadTitle, type HistoryState, type ProjectHistoryGroup } from './history-model.js'

function age(updatedAt: number): string {
  if (!updatedAt) return ''
  const elapsed = Math.max(0, Math.floor(Date.now() / 1_000) - updatedAt)
  if (elapsed < 60) return 'now'
  if (elapsed < 3_600) return `${Math.floor(elapsed / 60)}m`
  if (elapsed < 86_400) return `${Math.floor(elapsed / 3_600)}h`
  if (elapsed < 604_800) return `${Math.floor(elapsed / 86_400)}d`
  return new Date(updatedAt * 1_000).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  })
}

interface HistoryEntryMenuProps {
  anchor: HTMLButtonElement
  thread: ThreadSummary
  project?: LocalProject
  active: boolean
  EntryDecoration?: ComponentType<HistoryEntryDecorationProps>
  onRename: () => void
  onClose: () => void
}

const HISTORY_MENU_GAP = 6
const HISTORY_MENU_VIEWPORT_GUTTER = 8

function HistoryEntryMenu({
  anchor,
  thread,
  project,
  active,
  EntryDecoration,
  onRename,
  onClose,
}: HistoryEntryMenuProps): ReactNode {
  const menuRef = useRef<HTMLDivElement>(null)
  const displayTitle = threadHistoryTitle(thread)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const anchorRect = anchor.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const left = Math.max(
      HISTORY_MENU_VIEWPORT_GUTTER,
      Math.min(
        anchorRect.right - menuRect.width,
        window.innerWidth - menuRect.width - HISTORY_MENU_VIEWPORT_GUTTER,
      ),
    )
    const top = window.innerHeight - anchorRect.bottom >= menuRect.height + HISTORY_MENU_GAP
      ? anchorRect.bottom + HISTORY_MENU_GAP
      : Math.max(
          HISTORY_MENU_VIEWPORT_GUTTER,
          anchorRect.top - menuRect.height - HISTORY_MENU_GAP,
        )
    menu.style.left = String(left) + 'px'
    menu.style.top = String(top) + 'px'
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [anchor])

  useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target
      if (
        target instanceof Node
        && (menuRef.current?.contains(target) || anchor.contains(target))
      ) return
      onClose()
    }
    const closeWithKeyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      anchor.focus()
      onClose()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeWithKeyboard)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeWithKeyboard)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      className="history-entry-menu"
      ref={menuRef}
      role="menu"
      aria-label={'Actions for ' + displayTitle}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          onRename()
        }}
      >
        <Pencil size={14} strokeWidth={1.5} />
        <span>Rename</span>
      </button>
      {EntryDecoration && (
        <div className="history-entry-menu-details">
          <EntryDecoration thread={thread} {...(project ? { project } : {})} active={active} />
        </div>
      )}
    </div>,
    document.body,
  )
}

export function HistoryPanel({
  label,
  state,
  activeThreadId,
  activeProjectId,
  projects,
  disabled,
  newThreadDisabled = disabled,
  newThreadProblem,
  showAge = false,
  emptyText = 'No conversations yet',
  statusFor,
  EntryDecoration,
  onNewWorkspace,
  onClose,
  onNewThread,
  onOpen,
  onRename,
  onRetry,
}: {
  label: string
  state: HistoryState
  activeThreadId?: string
  activeProjectId?: string
  projects: LocalProject[]
  disabled: boolean
  newThreadDisabled?: boolean
  newThreadProblem?: string
  showAge?: boolean
  emptyText?: string
  statusFor?: (threadId: string) => ThreadWorkStatus | undefined
  EntryDecoration?: ComponentType<HistoryEntryDecorationProps>
  onNewWorkspace?: () => void
  onClose?: () => void
  onNewThread: (project: LocalProject) => void
  onOpen: (thread: ThreadSummary) => void
  onRename: (thread: ThreadSummary, name: string) => Promise<void>
  onRetry: () => void
}): ReactNode {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [renamingThreadId, setRenamingThreadId] = useState<string>()
  const [renamingThreadName, setRenamingThreadName] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState<string>()
  const [entryMenu, setEntryMenu] = useState<{
    threadId: string
    anchor: HTMLButtonElement
  }>()
  const renameInput = useRef<HTMLInputElement>(null)
  const renameInFlight = useRef(false)
  const groups = groupThreadsByProject(state.entries, projects)
  const showHeader = Boolean(label) || state.tag === 'failed'

  useLayoutEffect(() => {
    if (!renamingThreadId) return
    renameInput.current?.focus()
    renameInput.current?.select()
  }, [renamingThreadId])

  const clearRename = (): void => {
    setRenamingThreadId(undefined)
    setRenamingThreadName('')
    setRenameSaving(false)
    setRenameError(undefined)
  }

  const beginRename = (thread: ThreadSummary): void => {
    if (renameInFlight.current) return
    setRenamingThreadId(thread.id)
    setRenamingThreadName(threadHistoryTitle(thread))
    setRenameError(undefined)
  }

  const finishRename = async (save: boolean): Promise<void> => {
    if (renameInFlight.current) return
    const thread = state.entries.find((candidate) => candidate.id === renamingThreadId)
    const name = renamingThreadName.trim()
    if (!save || !thread || !name || name === thread.title) {
      clearRename()
      return
    }
    renameInFlight.current = true
    setRenameSaving(true)
    setRenameError(undefined)
    try {
      await onRename(thread, name)
      clearRename()
    } catch (error) {
      setRenameSaving(false)
      setRenameError(error instanceof Error ? error.message : String(error))
    } finally {
      renameInFlight.current = false
    }
  }

  return (
    <section className="conversation-history shell-history shell-builtin">
      {showHeader && (
        <header className="history-header">
          {label && <span>{label}</span>}
          {onNewWorkspace && (
            <button
              className="history-new-workspace"
              type="button"
              title="New workspace"
              aria-label="New workspace"
              disabled={disabled}
              onClick={onNewWorkspace}
            >
              <Plus size={14} strokeWidth={1.7} />
            </button>
          )}
          {onClose && (
            <button
              className="history-close"
              type="button"
              title="Close sidebar"
              aria-label="Close sidebar"
              onClick={onClose}
            >
              <X size={15} strokeWidth={1.5} />
            </button>
          )}
          {state.tag === 'loading' && <LoaderCircle size={13} aria-label="Loading conversations" />}
          {state.tag === 'failed' && (
            <button type="button" aria-label="Retry conversation history" title={state.problem} onClick={onRetry}>
              <RefreshCw size={13} />
            </button>
          )}
        </header>
      )}
      {newThreadProblem && <p className="history-new-thread-error" role="alert">{newThreadProblem}</p>}
      <div className="history-list">
        {groups.map((group) => {
          const project = group.project
          const isExpanded = expanded.has(group.id)
          const isCollapsed = collapsed.has(group.id)
          const visibleEntries = isExpanded
            ? group.entries
            : group.entries.slice(0, PROJECT_PREVIEW_LIMIT)
          const hasMore = group.entries.length > PROJECT_PREVIEW_LIMIT
          return (
            <section className="history-workspace" key={group.id}>
              <div className="history-workspace-header">
                <button
                  className={`history-workspace-heading ${group.id === activeProjectId ? 'active' : ''}`}
                  type="button"
                  title={project?.primaryRoot ?? group.label}
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((current) => {
                    const next = new Set(current)
                    if (next.has(group.id)) next.delete(group.id)
                    else next.add(group.id)
                    return next
                  })}
                >
                  <Folder size={16} strokeWidth={1.5} />
                  <span>{group.label}</span>
                  {state.tag === 'loading' && group.id === activeProjectId && (
                    <LoaderCircle size={13} aria-label="Loading conversations" />
                  )}
                </button>
                {project && (
                  <button
                    className="history-workspace-new-thread"
                    type="button"
                    title={`New chat in ${group.label}`}
                    aria-label={`New chat in ${group.label}`}
                    disabled={newThreadDisabled}
                    onClick={() => onNewThread(project)}
                  >
                    <Plus size={15} strokeWidth={1.7} />
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="history-workspace-threads">
                  {visibleEntries.map((thread) => {
                    const active = thread.id === activeThreadId
                    const displayTitle = threadHistoryTitle(thread)
                    if (renamingThreadId === thread.id) {
                      return (
                        <div className="history-entry-row" key={thread.id}>
                          <div className={'history-entry is-renaming' + (active ? ' active' : '')}>
                            <input
                              ref={renameInput}
                              className="history-entry-name-input"
                              value={renamingThreadName}
                              aria-label={'Rename ' + displayTitle}
                              aria-invalid={renameError ? true : undefined}
                              disabled={renameSaving}
                              onChange={(event) => setRenamingThreadName(event.target.value)}
                              onBlur={() => void finishRename(true)}
                              onKeyDown={(event) => {
                                event.stopPropagation()
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  void finishRename(true)
                                } else if (event.key === 'Escape') {
                                  event.preventDefault()
                                  void finishRename(false)
                                }
                              }}
                            />
                            {renameError && (
                              <span className="history-entry-rename-error" role="status">
                                {renameError}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    }
                    const menuOpen = entryMenu?.threadId === thread.id
                    return (
                      <div className="history-entry-row" key={thread.id}>
                        <button
                          className={'history-entry' + (active ? ' active' : '')}
                          type="button"
                          aria-current={active ? 'page' : undefined}
                          title={thread.preview
                            ? thread.preview + '\nDouble-click to rename'
                            : 'Double-click to rename'}
                          onClick={() => onOpen(thread)}
                          onDoubleClick={(event) => {
                            event.preventDefault()
                            beginRename(thread)
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'F2') return
                            event.preventDefault()
                            beginRename(thread)
                          }}
                        >
                          <span>{displayTitle}</span>
                          <span className="history-entry-meta">
                            <ThreadStatusIndicator
                              status={active ? undefined : statusFor?.(thread.id)}
                            />
                            {showAge && <time>{age(threadRecencyAt(thread))}</time>}
                          </span>
                        </button>
                        <button
                          className="history-entry-more"
                          type="button"
                          title={'Actions for ' + displayTitle}
                          aria-label={'Actions for ' + displayTitle}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (menuOpen) {
                              setEntryMenu(undefined)
                              return
                            }
                            setEntryMenu({
                              threadId: thread.id,
                              anchor: event.currentTarget,
                            })
                          }}
                        >
                          <MoreHorizontal size={15} strokeWidth={1.5} />
                        </button>
                        {menuOpen && entryMenu && (
                          <HistoryEntryMenu
                            anchor={entryMenu.anchor}
                            thread={thread}
                            {...(project ? { project } : {})}
                            active={active}
                            {...(EntryDecoration ? { EntryDecoration } : {})}
                            onRename={() => beginRename(thread)}
                            onClose={() => setEntryMenu(undefined)}
                          />
                        )}
                      </div>
                    )
                  })}
                  {hasMore && (
                    <button
                      className="history-show-more"
                      type="button"
                      onClick={() => setExpanded((current) => {
                        const next = new Set(current)
                        if (next.has(group.id)) next.delete(group.id)
                        else next.add(group.id)
                        return next
                      })}
                    >
                      {isExpanded ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </div>
              )}
            </section>
          )
        })}
        {state.tag === 'ready' && state.entries.length === 0 && (
          <div className="history-empty">{emptyText}</div>
        )}
      </div>
    </section>
  )
}
