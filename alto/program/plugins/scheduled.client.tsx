import {
  CalendarClock,
  Cloud,
  ExternalLink,
  Laptop,
  MessageSquarePlus,
  Pause,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  clientStyles,
  type BrowserPlugin,
  type ClientHostService,
} from '../../src/client/plugin-api.js'
import type { JsonValue, LocalProject, ThreadSummary } from '../../src/shared/protocol.js'
import type { WorkContextSnapshot } from './work-contexts-api.js'
import type { ClientSidebarService } from './sidebar-api.js'
import type { ClientSessionService, ClientSessionSnapshot } from './session-api.js'
import {
  LOCAL_SCHEDULED_TARGET,
  SCHEDULED_IMPORT,
  SCHEDULED_REMOVE,
  SCHEDULED_REFRESH,
  SCHEDULED_RUN,
  SCHEDULED_SAVE,
  SCHEDULED_STATE,
  SCHEDULED_TOGGLE,
  type ScheduledSnapshot,
  type ScheduledTask,
  type ScheduledTarget,
  type ScheduledTargetDescriptor,
} from './scheduled-api.js'
import styles from './scheduled.css'

type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'custom'

interface WorkspaceOption {
  id: string
  label: string
  project: LocalProject
}

interface TaskDraft {
  id?: string
  name: string
  prompt: string
  target: ScheduledTarget
  projectId: string
  preset: SchedulePreset
  time: string
  weekday: string
  cron: string
  timezone: string
  permissionMode: 'auto' | 'full'
  enabled: boolean
}

const EMPTY_SNAPSHOT: ScheduledSnapshot = {
  version: 1,
  revision: 0,
  tasks: [],
  targets: [LOCAL_SCHEDULED_TARGET],
  updatedAt: new Date(0).toISOString(),
}

const SEEN_COMPLETIONS_KEY = 'alto.scheduled.seen-completions'
type SeenCompletions = Record<string, string>

function completedRunStamp(task: ScheduledTask): string | undefined {
  return task.lastRun?.status === 'running' ? undefined : task.lastRun?.finishedAt
}

function completionMap(tasks: readonly ScheduledTask[]): SeenCompletions {
  return Object.fromEntries(tasks.flatMap((task) => {
    const stamp = completedRunStamp(task)
    return stamp ? [[task.id, stamp]] : []
  }))
}

export function unseenCompletedTaskCount(
  tasks: readonly ScheduledTask[],
  seen: Readonly<SeenCompletions>,
): number {
  return tasks.filter((task) => {
    const stamp = completedRunStamp(task)
    return stamp !== undefined && seen[task.id] !== stamp
  }).length
}

function storedSeenCompletions(): SeenCompletions | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem(SEEN_COMPLETIONS_KEY) ?? 'null') as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )))
  } catch {
    return undefined
  }
}

function storeSeenCompletions(value: SeenCompletions): void {
  try {
    window.localStorage.setItem(SEEN_COMPLETIONS_KEY, JSON.stringify(value))
  } catch {
    // The in-memory indicator still works when browser storage is unavailable.
  }
}

const WEEKDAYS = [
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday'],
  ['0', 'Sunday'],
] as const

function extensionSnapshot(host: ClientHostService): ScheduledSnapshot {
  const value = host.snapshot().snapshot?.extensions[SCHEDULED_STATE]
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.version !== 1
    || typeof value.revision !== 'number'
    || !Array.isArray(value.tasks)
    || typeof value.updatedAt !== 'string'
  ) return EMPTY_SNAPSHOT
  const snapshot = value as unknown as ScheduledSnapshot
  return {
    ...snapshot,
    targets: Array.isArray(snapshot.targets) ? snapshot.targets : [LOCAL_SCHEDULED_TARGET],
  }
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

interface TimezoneOption {
  value: string
  label: string
}

const PST_TIMEZONE = 'Etc/GMT+8'

function timezoneOptions(target: ScheduledTargetDescriptor | undefined): TimezoneOption[] {
  const fixed: TimezoneOption[] = [
    { value: PST_TIMEZONE, label: 'Pacific Standard Time (PST, UTC−08:00)' },
    { value: 'UTC', label: 'UTC' },
  ]
  if (target?.timezoneMode === 'utc') return fixed.slice(1)
  if (target?.timezoneMode === 'fixed-offset') return fixed
  const local = localTimezone()
  return [
    { value: local, label: `Local — ${local}` },
    ...fixed.filter((option) => option.value !== local),
  ]
}

function timeParts(minute: string, hour: string): string {
  const parsedMinute = Number(minute)
  const parsedHour = Number(hour)
  if (
    !Number.isInteger(parsedMinute)
    || parsedMinute < 0
    || parsedMinute > 59
    || !Number.isInteger(parsedHour)
    || parsedHour < 0
    || parsedHour > 23
  ) return '09:00'
  return `${String(parsedHour).padStart(2, '0')}:${String(parsedMinute).padStart(2, '0')}`
}

function scheduleFields(cron: string): Pick<TaskDraft, 'preset' | 'time' | 'weekday' | 'cron'> {
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/u.exec(cron)
  if (daily) return { preset: 'daily', time: timeParts(daily[1] ?? '', daily[2] ?? ''), weekday: '1', cron }
  const weekdays = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/u.exec(cron)
  if (weekdays) return { preset: 'weekdays', time: timeParts(weekdays[1] ?? '', weekdays[2] ?? ''), weekday: '1', cron }
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/u.exec(cron)
  if (weekly) {
    return {
      preset: 'weekly',
      time: timeParts(weekly[1] ?? '', weekly[2] ?? ''),
      weekday: weekly[3] ?? '1',
      cron,
    }
  }
  return { preset: 'custom', time: '09:00', weekday: '1', cron }
}

function cronFor(draft: TaskDraft): string {
  if (draft.preset === 'custom') return draft.cron.trim()
  const [hour = '9', minute = '0'] = draft.time.split(':')
  const prefix = `${Number(minute)} ${Number(hour)}`
  if (draft.preset === 'weekdays') return `${prefix} * * 1-5`
  if (draft.preset === 'weekly') return `${prefix} * * ${draft.weekday}`
  return `${prefix} * * *`
}

function freshDraft(): TaskDraft {
  return {
    name: '',
    prompt: '',
    target: 'local',
    projectId: '',
    preset: 'weekdays',
    time: '09:00',
    weekday: '1',
    cron: '0 9 * * 1-5',
    timezone: localTimezone(),
    permissionMode: 'auto',
    enabled: true,
  }
}

function taskDraft(
  task: ScheduledTask,
  _targets: readonly ScheduledTargetDescriptor[],
): TaskDraft {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    target: task.target,
    projectId: task.projectId ?? '',
    ...scheduleFields(task.cron),
    timezone: task.timezone,
    permissionMode: task.permissionMode,
    enabled: task.enabled,
  }
}

function targetDescriptor(
  targets: readonly ScheduledTargetDescriptor[],
  target: ScheduledTarget,
): ScheduledTargetDescriptor | undefined {
  return targets.find((candidate) => candidate.id === target)
}

function targetAvailable(
  target: ScheduledTargetDescriptor,
  contexts: WorkContextSnapshot,
): boolean {
  return target.available !== false && (
    !target.requiredWorkProvider
    || contexts.providers.some((provider) => provider.id === target.requiredWorkProvider)
  )
}

function TargetIcon({ target, size = 14 }: {
  target: ScheduledTargetDescriptor | undefined
  size?: number
}): ReactNode {
  return target?.icon === 'cloud' ? <Cloud size={size} /> : <Laptop size={size} />
}

function workspaceOptions(projects: LocalProject[]): WorkspaceOption[] {
  return projects.map((project) => ({
    id: project.id,
    label: project.name,
    project,
  })).toSorted((left, right) => left.label.localeCompare(right.label))
}

function projectData(state: ClientSessionSnapshot): LocalProject[] {
  return state.projects
}

function importedThread(value: JsonValue): ThreadSummary | undefined {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof value.id !== 'string'
    || typeof value.title !== 'string'
    || typeof value.preview !== 'string'
    || typeof value.cwd !== 'string'
    || typeof value.createdAt !== 'number'
    || typeof value.updatedAt !== 'number'
  ) return undefined
  return value as unknown as ThreadSummary
}

function scheduleLabel(task: ScheduledTask): string {
  const fields = scheduleFields(task.cron)
  const time = new Date(`2000-01-01T${fields.time}:00`)
  const displayTime = Number.isNaN(time.valueOf())
    ? fields.time
    : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(time)
  if (fields.preset === 'daily') return `Daily at ${displayTime}`
  if (fields.preset === 'weekdays') return `Weekdays at ${displayTime}`
  if (fields.preset === 'weekly') {
    const day = WEEKDAYS.find(([value]) => value === fields.weekday)?.[1] ?? 'Weekly'
    return `${day}s at ${displayTime}`
  }
  return task.cron
}

function relativeNext(value: string | undefined): string {
  if (!value) return 'Paused'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return 'Next run unavailable'
  return `Next ${new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)}`
}

function lastRunLabel(task: ScheduledTask): string | undefined {
  const run = task.lastRun
  if (!run) return undefined
  if (run.status === 'running') return 'Running now'
  const date = new Date(run.finishedAt ?? run.startedAt)
  const when = Number.isNaN(date.valueOf()) ? '' : ` · ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)}`
  return `${run.status === 'succeeded' ? 'Completed' : 'Failed'}${when}`
}

function TaskList({
  tasks,
  targets,
  selectedId,
  onSelect,
  onNew,
}: {
  tasks: ScheduledTask[]
  targets: readonly ScheduledTargetDescriptor[]
  selectedId: string | undefined
  onSelect(task: ScheduledTask): void
  onNew(): void
}): ReactNode {
  return (
    <aside className="scheduled-list">
      <button className="scheduled-new" type="button" onClick={onNew}>
        <Plus size={15} />
        New task
      </button>
      <div className="scheduled-list-scroll">
        {!tasks.length && (
          <div className="scheduled-empty">
            <CalendarClock size={30} strokeWidth={1.3} />
            <strong>No scheduled tasks</strong>
            <span>Create one to run Codex on a recurring schedule.</span>
          </div>
        )}
        {tasks.map((task) => (
          <button
            className={`scheduled-list-item${selectedId === task.id ? ' is-selected' : ''}`}
            type="button"
            key={task.id}
            onClick={() => onSelect(task)}
          >
            <span className="scheduled-list-title">
              <TargetIcon target={targetDescriptor(targets, task.target)} />
              <strong>{task.name}</strong>
              <i data-status={task.enabled ? 'enabled' : 'paused'} />
            </span>
            <span>{scheduleLabel(task)}</span>
            {lastRunLabel(task) && (
              <small className="scheduled-list-run" data-status={task.lastRun?.status}>
                {lastRunLabel(task)}
              </small>
            )}
            <small>{relativeNext(task.nextRunAt)}</small>
          </button>
        ))}
      </div>
    </aside>
  )
}

function TaskEditor({
  draft,
  setDraft,
  workspaces,
  targets,
  contexts,
  pending,
  problem,
  task,
  canManageTask,
  canImport,
  onSave,
  onRun,
  onToggle,
  onRemove,
  onImport,
}: {
  draft: TaskDraft
  setDraft: (update: (current: TaskDraft) => TaskDraft) => void
  workspaces: WorkspaceOption[]
  targets: readonly ScheduledTargetDescriptor[]
  contexts: WorkContextSnapshot
  pending: string | undefined
  problem: string | undefined
  task: ScheduledTask | undefined
  canManageTask: boolean
  canImport: boolean
  onSave(): void
  onRun(): void
  onToggle(): void
  onRemove(): void
  onImport(): void
}): ReactNode {
  const busy = pending !== undefined
  const selectedTarget = targetDescriptor(targets, draft.target)
  const unavailable = !selectedTarget || !targetAvailable(selectedTarget, contexts)
  const targetTimezoneOptions = timezoneOptions(selectedTarget)
  const visibleTimezoneOptions = targetTimezoneOptions.some((option) => option.value === draft.timezone)
    ? targetTimezoneOptions
    : [{ value: draft.timezone, label: draft.timezone }, ...targetTimezoneOptions]
  const valid = Boolean(
    draft.name.trim()
    && draft.prompt.trim()
    && cronFor(draft)
    && !unavailable,
  )
  return (
    <div className="scheduled-editor">
      <div className="scheduled-editor-scroll">
        <label className="scheduled-field">
          <span>Name</span>
          <input
            autoFocus
            value={draft.name}
            placeholder="Review open pull requests"
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </label>

        <label className="scheduled-field">
          <span>Instructions</span>
          <textarea
            value={draft.prompt}
            placeholder="Tell Codex what to do each time this task runs…"
            onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
          />
        </label>

        <div className="scheduled-form-grid">
          <label className="scheduled-field scheduled-field-wide">
            <span>Workspace</span>
            <select
              value={draft.projectId}
              onChange={(event) => setDraft((current) => ({ ...current, projectId: event.target.value }))}
            >
              <option value="">No workspace</option>
              {workspaces.map((workspace) => (
                <option value={workspace.id} key={workspace.id}>{workspace.label}</option>
              ))}
            </select>
          </label>

          <label className="scheduled-field">
            <span>Run on</span>
            <select
              value={draft.target}
              onChange={(event) => setDraft((current) => {
                const target = event.target.value
                const descriptor = targetDescriptor(targets, target)
                const availableTimezones = timezoneOptions(descriptor)
                return {
                  ...current,
                  target,
                  preset: descriptor?.supportsCustomCron === false && current.preset === 'custom'
                    ? 'weekdays'
                    : current.preset,
                  timezone: availableTimezones.some((option) => option.value === current.timezone)
                    ? current.timezone
                    : availableTimezones[0]?.value ?? 'UTC',
                }
              })}
            >
              {!selectedTarget && (
                <option value={draft.target} disabled>{draft.target} (unavailable)</option>
              )}
              {targets.map((target) => (
                <option
                  value={target.id}
                  disabled={!targetAvailable(target, contexts)}
                  key={target.id}
                >
                  {target.label}
                </option>
              ))}
            </select>
          </label>

          <label className="scheduled-field">
            <span>Repeats</span>
            <select
              value={draft.preset}
              onChange={(event) => setDraft((current) => ({
                ...current,
                preset: event.target.value as SchedulePreset,
              }))}
            >
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Every week</option>
              <option value="custom" disabled={selectedTarget?.supportsCustomCron === false}>Custom cron</option>
            </select>
          </label>

          {draft.preset !== 'custom' && (
            <label className="scheduled-field">
              <span>Time</span>
              <input
                type="time"
                value={draft.time}
                onChange={(event) => setDraft((current) => ({ ...current, time: event.target.value }))}
              />
            </label>
          )}

          {draft.preset === 'weekly' && (
            <label className="scheduled-field">
              <span>Day</span>
              <select
                value={draft.weekday}
                onChange={(event) => setDraft((current) => ({ ...current, weekday: event.target.value }))}
              >
                {WEEKDAYS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
          )}

          {draft.preset === 'custom' && (
            <label className="scheduled-field scheduled-field-wide">
              <span>Cron expression</span>
              <input
                className="scheduled-mono"
                value={draft.cron}
                placeholder="0 9 * * 1-5"
                onChange={(event) => setDraft((current) => ({ ...current, cron: event.target.value }))}
              />
            </label>
          )}

          <label className="scheduled-field">
            <span>Timezone</span>
            <select
              value={draft.timezone}
              onChange={(event) => setDraft((current) => ({
                ...current,
                timezone: event.target.value,
              }))}
            >
              {visibleTimezoneOptions.map((option) => (
                <option value={option.value} key={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          {selectedTarget?.supportsPermissionMode && (
            <label className="scheduled-field">
              <span>Access</span>
              <select
                value={draft.permissionMode}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  permissionMode: event.target.value === 'full' ? 'full' : 'auto',
                }))}
              >
                <option value="auto">Workspace only</option>
                <option value="full">Full access</option>
              </select>
            </label>
          )}
        </div>

        <div className="scheduled-note">
          <TargetIcon target={selectedTarget} size={16} />
          <span>{selectedTarget?.description ?? 'The selected task target is unavailable.'}</span>
        </div>

        {task?.lastRun && (
          <div className={`scheduled-run-status is-${task.lastRun.status}`}>
            <strong>{task.lastRun.status === 'running' ? 'Running now' : `Last run ${task.lastRun.status}`}</strong>
            <span>{task.lastRun.message}</span>
            {task.lastRun.url && (
              <a href={task.lastRun.url} target="_blank" rel="noreferrer">
                View in {selectedTarget?.documentation?.label ?? 'run details'}
                <ExternalLink size={12} />
              </a>
            )}
          </div>
        )}
        {problem && <div className="scheduled-problem">{problem}</div>}
      </div>

      <footer className="scheduled-editor-footer">
        <div className="scheduled-secondary-actions">
          {task && (
            <>
              <button
                type="button"
                className={`${clientStyles.button} ghost`}
                disabled={busy || !canManageTask}
                title={canManageTask ? undefined : 'The scheduling provider is unavailable'}
                onClick={onRun}
              >
                <Play size={14} />
                {pending === 'run' ? 'Starting…' : 'Run now'}
              </button>
              {canImport && (
                <button
                  type="button"
                  className={`${clientStyles.button} ghost`}
                  disabled={busy}
                  onClick={onImport}
                >
                  <MessageSquarePlus size={14} />
                  {pending === 'import' ? 'Opening…' : 'Continue in Alto'}
                </button>
              )}
              <button
                type="button"
                className={`${clientStyles.button} ghost`}
                disabled={busy || !canManageTask}
                title={canManageTask ? undefined : 'The scheduling provider is unavailable'}
                onClick={onToggle}
              >
                {task.enabled ? <Pause size={14} /> : <Play size={14} />}
                {task.enabled ? 'Pause' : 'Resume'}
              </button>
              <button
                type="button"
                className={`${clientStyles.button} ghost scheduled-delete`}
                aria-label="Delete task"
                disabled={busy}
                onClick={onRemove}
              >
                <Trash2 size={15} />
              </button>
            </>
          )}
        </div>
        <button type="button" className={`${clientStyles.button} primary`} disabled={busy || !valid} onClick={onSave}>
          {pending === 'save' ? 'Saving…' : task ? 'Save changes' : 'Create task'}
        </button>
      </footer>
    </div>
  )
}

function ScheduledDialog({
  host,
  session,
  contexts,
  projects,
  onClose,
}: {
  host: ClientHostService
  session: ClientSessionService
  contexts: WorkContextSnapshot
  projects: LocalProject[]
  onClose(): void
}): ReactNode {
  const hostState = useSyncExternalStore(host.subscribe, host.snapshot)
  const snapshot = useMemo(() => extensionSnapshot(host), [host, hostState])
  const workspaces = useMemo(() => workspaceOptions(projects), [projects])
  const [selectedId, setSelectedId] = useState<string | undefined>(snapshot.tasks[0]?.id)
  const selected = snapshot.tasks.find((task) => task.id === selectedId)
  const selectedTarget = selected
    ? targetDescriptor(snapshot.targets, selected.target)
    : undefined
  const canManageSelected = !selected
    || selected.target === LOCAL_SCHEDULED_TARGET.id
    || selectedTarget?.available !== false
    || selectedTarget?.canManageExisting === true
  const canImportSelected = Boolean(
    selected
    && selected.lastRun?.status === 'succeeded'
    && selectedTarget?.supportsImport,
  )
  const [draft, setDraftState] = useState<TaskDraft>(() => (
    selected ? taskDraft(selected, snapshot.targets) : freshDraft()
  ))
  const [pending, setPending] = useState<string>()
  const [problem, setProblem] = useState<string>()

  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  useEffect(() => {
    if (selectedId && !snapshot.tasks.some((task) => task.id === selectedId)) {
      const next = snapshot.tasks[0]
      setSelectedId(next?.id)
      setDraftState(next ? taskDraft(next, snapshot.targets) : freshDraft())
    }
  }, [selectedId, snapshot.targets, snapshot.tasks])

  const setDraft = (update: (current: TaskDraft) => TaskDraft): void => {
    setDraftState(update)
    setProblem(undefined)
  }

  const call = async (
    kind: string,
    method: string,
    payload: Record<string, unknown>,
  ): Promise<JsonValue> => {
    setPending(kind)
    setProblem(undefined)
    try {
      return await host.call(method, payload as JsonValue)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      setPending(undefined)
    }
  }

  const save = async (): Promise<void> => {
    let detachUnavailableTarget = false
    if (
      selected
      && selected.target !== draft.target
      && selected.target !== LOCAL_SCHEDULED_TARGET.id
      && selectedTarget?.available === false
      && selectedTarget.canManageExisting !== true
    ) {
      detachUnavailableTarget = window.confirm(
        'This provider is unavailable, so Alto cannot remove the external schedule. Detach it and save the new target anyway?',
      )
      if (!detachUnavailableTarget) return
    }
    try {
      const saved = await call('save', SCHEDULED_SAVE, {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        prompt: draft.prompt,
        target: draft.target,
        projectId: draft.projectId,
        cron: cronFor(draft),
        timezone: draft.timezone,
        permissionMode: draft.permissionMode,
        enabled: draft.enabled,
        ...(detachUnavailableTarget ? { detachUnavailableTarget: true } : {}),
      })
      if (saved && typeof saved === 'object' && !Array.isArray(saved) && typeof saved.id === 'string') {
        const next = saved as unknown as ScheduledTask
        setSelectedId(next.id)
        setDraftState(taskDraft(next, snapshot.targets))
      }
    } catch {
      // The call helper keeps the server error visible in the editor.
    }
  }

  const run = async (): Promise<void> => {
    if (!selected) return
    try {
      await call('run', SCHEDULED_RUN, { id: selected.id })
    } catch {
      // The call helper keeps the server error visible in the editor.
    }
  }

  const toggle = async (): Promise<void> => {
    if (!selected) return
    try {
      await call('toggle', SCHEDULED_TOGGLE, { id: selected.id, enabled: !selected.enabled })
      setDraftState((current) => ({ ...current, enabled: !selected.enabled }))
    } catch {
      // The call helper keeps the server error visible in the editor.
    }
  }

  const remove = async (): Promise<void> => {
    if (!selected) return
    const detachUnavailableTarget = selected.target !== LOCAL_SCHEDULED_TARGET.id
      && selectedTarget?.available === false
      && selectedTarget.canManageExisting !== true
    const message = detachUnavailableTarget
      ? `Delete “${selected.name}” from Alto? Its provider is unavailable, so its external schedule may continue running.`
      : `Delete “${selected.name}”?`
    if (!window.confirm(message)) return
    try {
      await call('remove', SCHEDULED_REMOVE, {
        id: selected.id,
        ...(detachUnavailableTarget ? { detachUnavailableTarget: true } : {}),
      })
    } catch {
      // The call helper keeps the server error visible in the editor.
    }
  }

  const importRun = async (): Promise<void> => {
    if (!selected) return
    try {
      const thread = importedThread(await call('import', SCHEDULED_IMPORT, { id: selected.id }))
      if (!thread) throw new Error('Alto did not return the imported chat')
      if (!selected.projectId) {
        await host.call('workspace-layout.unassign-thread', { threadId: thread.id }).catch(() => undefined)
      }
      await session.openThread(thread)
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className={`${clientStyles.overlayLayer} scheduled-backdrop`} onMouseDown={onClose}>
      <section
        className={`${clientStyles.floatingPanel} scheduled-dialog`}
        role="dialog"
        aria-modal="true"
        aria-label="Scheduled tasks"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="scheduled-header">
          <div>
            <CalendarClock size={20} />
            <h2>Scheduled</h2>
            <span>{snapshot.tasks.length || ''}</span>
          </div>
          <div className="scheduled-header-actions">
            {snapshot.targets.flatMap((target) => target.documentation ? [
              <a
                href={target.documentation.url}
                target="_blank"
                rel="noreferrer"
                title={`Open ${target.documentation.label}`}
                key={target.id}
              >
                {target.documentation.label}
                <ExternalLink size={13} />
              </a>,
            ] : [])}
            <button type="button" className={`${clientStyles.iconButton} icon-button`} aria-label="Close" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="scheduled-body">
          <TaskList
            tasks={snapshot.tasks}
            targets={snapshot.targets}
            selectedId={selectedId}
            onSelect={(task) => {
              setSelectedId(task.id)
              setDraftState(taskDraft(task, snapshot.targets))
              setProblem(undefined)
            }}
            onNew={() => {
              setSelectedId(undefined)
              setDraftState(freshDraft())
              setProblem(undefined)
            }}
          />
          <TaskEditor
            draft={draft}
            setDraft={setDraft}
            workspaces={workspaces}
            targets={snapshot.targets}
            contexts={contexts}
            pending={pending}
            problem={problem}
            task={selected}
            canManageTask={canManageSelected}
            canImport={canImportSelected}
            onSave={() => void save()}
            onRun={() => void run()}
            onToggle={() => void toggle()}
            onRemove={() => void remove()}
            onImport={() => void importRun()}
          />
        </div>
      </section>
    </div>
  )
}

const scheduledClient: BrowserPlugin = (ctx) => {
  function ScheduledAction(): ReactNode {
    const hostState = useSyncExternalStore(ctx.clientHost.subscribe, ctx.clientHost.snapshot)
    const snapshot = useMemo(() => extensionSnapshot(ctx.clientHost), [hostState])
    const activeOverlay = useSyncExternalStore(ctx.clientUi.overlays.subscribe, ctx.clientUi.overlays.snapshot)
    const open = activeOverlay === 'scheduled'
    const [seen, setSeen] = useState<SeenCompletions | undefined>(() => storedSeenCompletions())

    useEffect(() => {
      if (seen !== undefined || !ctx.clientHost.snapshot().snapshot?.extensions[SCHEDULED_STATE]) return
      const baseline = completionMap(snapshot.tasks)
      storeSeenCompletions(baseline)
      setSeen(baseline)
    }, [seen, snapshot])

    useEffect(() => {
      let active = true
      let refreshing = false
      const refresh = (): void => {
        if (
          !active
          || refreshing
          || document.visibilityState === 'hidden'
          || !document.hasFocus()
        ) return
        refreshing = true
        void ctx.clientHost.call(SCHEDULED_REFRESH, {}).catch(() => undefined).finally(() => {
          refreshing = false
        })
      }
      const visibilityChanged = (): void => {
        if (document.visibilityState === 'visible') refresh()
      }
      refresh()
      const interval = window.setInterval(refresh, 60_000)
      window.addEventListener('focus', refresh)
      document.addEventListener('visibilitychange', visibilityChanged)
      return () => {
        active = false
        window.clearInterval(interval)
        window.removeEventListener('focus', refresh)
        document.removeEventListener('visibilitychange', visibilityChanged)
      }
    }, [])

    useEffect(() => {
      if (!open || seen === undefined) return
      const next = { ...seen, ...completionMap(snapshot.tasks) }
      if (JSON.stringify(next) === JSON.stringify(seen)) return
      storeSeenCompletions(next)
      setSeen(next)
    }, [open, seen, snapshot.tasks])

    const unseen = seen === undefined ? 0 : unseenCompletedTaskCount(snapshot.tasks, seen)
    return (
      <button
        className={`${clientStyles.button} ghost small shell-control shell-control-labeled shell-sidebar-action`}
        type="button"
        title="Scheduled tasks"
        aria-label="Scheduled tasks"
        aria-expanded={open}
        onClick={() => ctx.clientUi.overlays.open('scheduled')}
      >
        <CalendarClock size={18} strokeWidth={1.5} />
        <span>Scheduled</span>
        {unseen > 0 && (
          <span
            className="scheduled-sidebar-notice"
            title={`${unseen} new completed scheduled ${unseen === 1 ? 'run' : 'runs'}`}
          >
            {unseen}
          </span>
        )}
      </button>
    )
  }

  function ScheduledOverlay(): ReactNode {
    const contexts = useSyncExternalStore(
      ctx.clientWorkContexts.subscribe,
      ctx.clientWorkContexts.snapshot,
    )
    const projects = useSyncExternalStore(
      ctx.clientSession.subscribe,
      () => projectData(ctx.clientSession.snapshot()),
    )
    const activeOverlay = useSyncExternalStore(
      ctx.clientUi.overlays.subscribe,
      ctx.clientUi.overlays.snapshot,
    )
    if (activeOverlay !== 'scheduled') return null
    return (
      <ScheduledDialog
        host={ctx.clientHost}
        session={ctx.clientSession}
        contexts={contexts}
        projects={projects}
        onClose={() => ctx.clientUi.overlays.close('scheduled')}
      />
    )
  }

  ctx.inject(['clientSidebar'], (child) => {
    child.clientSidebar.registerAction(child, {
      id: 'scheduled',
      order: 100,
      renderer: ScheduledAction,
    })
  })
  ctx.clientUi.registerRoot(ctx, 'scheduled-overlay', ScheduledOverlay)
  ctx.clientUi.registerStyle(ctx, 'scheduled', String(styles))
}

scheduledClient.inject = [
  'clientHost',
  'clientSession',
  'clientUi',
  'clientWorkContexts',
]
scheduledClient.resources = {
  provides: { roots: ['scheduled-overlay'] },
  requires: { extensions: [SCHEDULED_STATE] },
}

export default scheduledClient
