import {
  Circle,
  CircleCheck,
  FileText,
  LoaderCircle,
} from 'lucide-react'
import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react'
import type {
  BrowserPlugin,
  ClientHostService,
  ClientUiService,
} from '../../src/client/plugin-api.js'
import type {
  HarnessEvent,
  RpcNotification,
} from '../../src/shared/protocol.js'
import { fileChangeKind, isRecord } from '../../src/shared/protocol.js'
import {
  FILE_REVIEW_ACTION_COMPONENT,
  type ChatFileChange,
  type FileReviewActionProps,
} from './chat-surfaces-api.js'
import type { ClientSessionService } from './session-api.js'
import { TURN_PROGRESS_ACCESSORY, type TurnProgressAccessory, type TurnProgressAccessoryProps } from './turn-progress-api.js'
import styles from './turn-progress.css'

export type TurnPlanStepStatus = 'pending' | 'inProgress' | 'completed'
export type TurnProgressPhase = 'active' | 'completed'

export interface TurnPlanStep {
  step: string
  status: TurnPlanStepStatus
}

export interface TurnProgressSnapshot {
  revision: number
  visible: boolean
  phase: TurnProgressPhase
  threadId?: string
  turnId?: string
  steps: readonly TurnPlanStep[]
  completedSteps: number
  files: readonly ChatFileChange[]
  filesChanged: number
  additions: number
  deletions: number
}

interface TrackedTurn {
  threadId: string
  turnId?: string
  phase: TurnProgressPhase
  steps: readonly TurnPlanStep[]
  patches: Map<string, readonly ChatFileChange[]>
}

const EMPTY_PROGRESS: TurnProgressSnapshot = Object.freeze({
  revision: 0,
  visible: false,
  phase: 'active',
  steps: Object.freeze([]),
  completedSteps: 0,
  files: Object.freeze([]),
  filesChanged: 0,
  additions: 0,
  deletions: 0,
})

function stringAt(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined
}

function notificationThreadId(notification: RpcNotification): string | undefined {
  return stringAt(notification.params, 'threadId')
    ?? stringAt(recordAt(notification.params, 'thread'), 'id')
}

function notificationTurnId(notification: RpcNotification): string | undefined {
  return stringAt(notification.params, 'turnId')
    ?? stringAt(recordAt(notification.params, 'turn'), 'id')
}

function normalizeStepStatus(value: unknown): TurnPlanStepStatus | undefined {
  if (value === 'pending' || value === 'completed') return value
  if (value === 'inProgress' || value === 'in_progress') return 'inProgress'
  return undefined
}

export function planSteps(value: unknown): readonly TurnPlanStep[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const step = typeof candidate.step === 'string' ? candidate.step.trim() : ''
    const status = normalizeStepStatus(candidate.status)
    return step && status ? [{ step, status }] : []
  })
}

function lineChanges(
  diff: string,
  kind: ReturnType<typeof fileChangeKind>,
): { additions: number; deletions: number } {
  const contentLines = diff ? diff.replace(/\n$/u, '').split('\n').length : 0
  if (kind === 'add') return { additions: contentLines, deletions: 0 }
  if (kind === 'delete') return { additions: 0, deletions: contentLines }
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

function fileChanges(value: unknown): readonly ChatFileChange[] {
  if (!isRecord(value) || !Array.isArray(value.changes)) return []
  return value.changes.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.path !== 'string') return []
    const diff = typeof candidate.diff === 'string' ? candidate.diff : ''
    const kind = fileChangeKind(candidate.kind)
    return [{
      path: candidate.path,
      kind,
      diff,
      ...lineChanges(diff, kind),
    }]
  })
}

export function summarizePatches(
  patches: Iterable<readonly ChatFileChange[]>,
): Pick<TurnProgressSnapshot, 'files' | 'filesChanged' | 'additions' | 'deletions'> {
  const paths = new Set<string>()
  const files: ChatFileChange[] = []
  let additions = 0
  let deletions = 0
  for (const changes of patches) {
    for (const change of changes) {
      files.push(change)
      paths.add(change.path)
      additions += change.additions
      deletions += change.deletions
    }
  }
  return { files, filesChanged: paths.size, additions, deletions }
}

function fileChangeItem(notification: RpcNotification): {
  id: string
  changes: readonly ChatFileChange[]
} | undefined {
  const item = recordAt(notification.params, 'item')
  const isPatchUpdate = notification.method === 'item/fileChange/patchUpdated'
  const isFileItem = (
    notification.method === 'item/started'
    || notification.method === 'item/completed'
  ) && item?.type === 'fileChange'
  if (!isPatchUpdate && !isFileItem) return undefined
  const id = stringAt(notification.params, 'itemId') ?? stringAt(item, 'id')
  if (!id) return undefined
  return {
    id,
    changes: fileChanges(isPatchUpdate ? notification.params : item),
  }
}

function seedFileChanges(
  turn: Record<string, unknown> | undefined,
): Map<string, readonly ChatFileChange[]> {
  const patches = new Map<string, readonly ChatFileChange[]>()
  if (!Array.isArray(turn?.items)) return patches
  for (const candidate of turn.items) {
    if (!isRecord(candidate) || candidate.type !== 'fileChange' || typeof candidate.id !== 'string') continue
    patches.set(candidate.id, fileChanges(candidate))
  }
  return patches
}

function newTrackedTurn(threadId: string, turnId?: string): TrackedTurn {
  return {
    threadId,
    ...(turnId ? { turnId } : {}),
    phase: 'active',
    steps: [],
    patches: new Map<string, readonly ChatFileChange[]>(),
  }
}

export function currentStepIndex(steps: readonly TurnPlanStep[]): number {
  if (!steps.length) return -1
  const active = steps.findIndex((step) => step.status === 'inProgress')
  if (active >= 0) return active
  const pending = steps.findIndex((step) => step.status === 'pending')
  return pending >= 0 ? pending : steps.length - 1
}

export class TurnProgressService {
  private readonly listeners = new Set<() => void>()
  private readonly turns = new Map<string, TrackedTurn>()
  private readonly disposeSession: () => void
  private readonly disposeEvents: () => void
  private activeThreadId: string | undefined
  private state: TurnProgressSnapshot = EMPTY_PROGRESS
  private disposed = false

  constructor(
    private readonly host: ClientHostService,
    private readonly session: Pick<ClientSessionService, 'subscribe' | 'snapshot'>,
  ) {
    this.activeThreadId = session.snapshot().threadId
    for (const event of host.journal()) this.apply(event)
    this.seedActiveTurnFiles()
    this.state = this.buildSnapshot(0)
    this.disposeSession = session.subscribe(() => this.syncSession())
    this.disposeEvents = host.onEvent((event) => this.receive(event))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): TurnProgressSnapshot => this.state

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeSession()
    this.disposeEvents()
    this.listeners.clear()
    this.turns.clear()
  }

  private seedActiveTurnFiles(): void {
    const state = this.session.snapshot()
    if (state.turn.tag !== 'running' || !state.threadId) return
    const promptIndex = state.activities.findLastIndex((activity) => (
      activity.kind === 'user' && !activity.continuesTurn
    ))
    const activeItems = state.activities.slice(Math.max(0, promptIndex + 1))
    const turnId = activeItems.findLast((activity) => activity.turnId)?.turnId
    const fileItems = activeItems.filter((activity) => (
      activity.kind === 'file'
      && activity.files?.length
      && (!turnId || !activity.turnId || activity.turnId === turnId)
    ))
    if (!fileItems.length) return
    const current = this.turns.get(state.threadId)
    const turn = current && (!turnId || !current.turnId || current.turnId === turnId)
      ? current
      : newTrackedTurn(state.threadId, turnId)
    if (turnId) turn.turnId = turnId
    for (const item of fileItems) {
      turn.patches.set(item.itemId ?? item.id, item.files ?? [])
    }
    this.turns.set(state.threadId, turn)
  }

  private syncSession(): void {
    const next = this.session.snapshot().threadId
    if (this.session.snapshot().providerId && this.session.snapshot().providerId !== 'codex') { this.activeThreadId = next; this.emit(); return }
    if (next === this.activeThreadId) return
    this.activeThreadId = next
    this.emit()
  }

  private receive(event: HarnessEvent): void {
    const changedThreadId = this.apply(event)
    if (changedThreadId && changedThreadId === this.activeThreadId) this.emit()
  }

  private apply(event: HarnessEvent): string | undefined {
    const activeThreadIds = event.type === 'snapshot'
      ? event.payload.codex.activeThreadIds
      : event.type === 'codex.status'
        ? event.payload.activeThreadIds
        : undefined
    if (activeThreadIds) {
      const active = new Set(activeThreadIds)
      let changed: string | undefined
      for (const [threadId, turn] of this.turns) {
        if (active.has(threadId) || turn.phase === 'completed') continue
        this.turns.delete(threadId)
        if (threadId === this.activeThreadId) changed = threadId
      }
      return changed
    }
    if (event.type !== 'codex.notification') return undefined
    const notification = event.payload
    const threadId = notificationThreadId(notification)
    if (!threadId) return undefined
    const turnId = notificationTurnId(notification)

    if (notification.method === 'turn/started') {
      const turn = newTrackedTurn(threadId, turnId)
      turn.patches = seedFileChanges(recordAt(notification.params, 'turn'))
      this.turns.set(threadId, turn)
      return threadId
    }

    if (notification.method === 'turn/completed') {
      const current = this.turns.get(threadId)
      if (current && turnId && current.turnId && turnId !== current.turnId) return undefined
      const turn = current ?? newTrackedTurn(threadId, turnId)
      if (!current) turn.patches = seedFileChanges(recordAt(notification.params, 'turn'))
      if (turnId) turn.turnId = turnId
      turn.phase = 'completed'
      this.turns.set(threadId, turn)
      return threadId
    }

    if (notification.method === 'turn/plan/updated') {
      const current = this.turns.get(threadId)
      const turn = current && (!turnId || !current.turnId || current.turnId === turnId)
        ? current
        : newTrackedTurn(threadId, turnId)
      turn.phase = 'active'
      turn.steps = planSteps(notification.params?.plan)
      if (turnId) turn.turnId = turnId
      this.turns.set(threadId, turn)
      return threadId
    }

    const current = this.turns.get(threadId)
    if (current && turnId && current.turnId && turnId !== current.turnId) return undefined
    const fileItem = fileChangeItem(notification)
    if (!fileItem) return undefined
    const turn = current ?? newTrackedTurn(threadId, turnId)
    if (turnId) turn.turnId = turnId
    turn.patches.set(fileItem.id, fileItem.changes)
    this.turns.set(threadId, turn)
    return threadId
  }

  private buildSnapshot(revision: number): TurnProgressSnapshot {
    const session = this.session.snapshot()
    if (session.providerId && session.providerId !== 'codex') {
      const turnId = session.activities.findLast((item) => item.turnId)?.turnId
      const steps = (session.agentPlan ?? []).map((entry) => ({ step: entry.content,
        status: entry.status === 'in_progress' ? 'inProgress' as const : entry.status }))
      const changes = summarizePatches(session.activities.filter((item) => item.turnId === turnId).map((item) => item.files ?? []))
      const completedSteps = steps.filter((step) => step.status === 'completed').length
      return { revision, visible: session.turn.tag === 'running' && (completedSteps > 0 || changes.filesChanged > 0),
        phase: session.turn.tag === 'idle' ? 'completed' : 'active', ...(session.threadId ? { threadId: session.threadId } : {}),
        ...(turnId ? { turnId } : {}), steps, completedSteps, ...changes }
    }
    const turn = this.activeThreadId ? this.turns.get(this.activeThreadId) : undefined
    if (!turn) return { ...EMPTY_PROGRESS, revision }
    const completedSteps = turn.phase === 'completed'
      ? turn.steps.length
      : turn.steps.filter((step) => step.status === 'completed').length
    const changes = summarizePatches(turn.patches.values())
    return {
      revision,
      visible: turn.phase === 'active' && (completedSteps > 0 || changes.filesChanged > 0),
      phase: turn.phase,
      threadId: turn.threadId,
      ...(turn.turnId ? { turnId: turn.turnId } : {}),
      steps: turn.steps,
      completedSteps,
      ...changes,
    }
  }

  private emit(): void {
    this.state = this.buildSnapshot(this.state.revision + 1)
    for (const listener of this.listeners) listener()
  }
}

function ProgressRing(): ReactNode {
  return (
    <svg className="turn-progress-ring" viewBox="0 0 18 18" aria-hidden="true">
      <circle className="turn-progress-ring-track" cx="9" cy="9" r="7" />
      <circle
        className="turn-progress-ring-value"
        cx="9"
        cy="9"
        r="7"
        pathLength="100"
        strokeDasharray="100 100"
      />
    </svg>
  )
}

function ProgressMark({ progress }: { progress: TurnProgressSnapshot }): ReactNode {
  if (progress.phase === 'completed') {
    return <CircleCheck className="turn-progress-complete" size={18} strokeWidth={1.8} />
  }
  return progress.completedSteps > 0 ? <ProgressRing /> : null
}

function StepIcon({ status }: { status: TurnPlanStepStatus }): ReactNode {
  if (status === 'completed') return <CircleCheck size={18} strokeWidth={1.7} />
  if (status === 'inProgress') {
    return <LoaderCircle className="turn-progress-step-spinner" size={18} strokeWidth={1.8} />
  }
  return <Circle size={18} strokeWidth={1.5} />
}

type RollingDirection = 'up' | 'down'

interface RollingDigitState {
  current: number
  previous?: number
  revision: number
  direction: RollingDirection
}

function RollingDigit({
  value,
  direction,
}: {
  value: number
  direction: RollingDirection
}): ReactNode {
  const [state, setState] = useState<RollingDigitState>({
    current: value,
    revision: 0,
    direction,
  })

  useLayoutEffect(() => {
    setState((current) => current.current === value
      ? current
      : {
          current: value,
          previous: current.current,
          revision: current.revision + 1,
          direction,
        })
  }, [direction, value])

  const animating = state.previous !== undefined
  return (
    <span className={'turn-progress-rolling is-' + state.direction}>
      {animating && (
        <span
          className="turn-progress-rolling-value turn-progress-rolling-out"
          key={'out:' + state.revision}
        >
          {state.previous}
        </span>
      )}
      <span
        className={'turn-progress-rolling-value' + (animating ? ' turn-progress-rolling-in' : '')}
        key={'in:' + state.revision}
        onAnimationEnd={animating ? () => {
          setState((current) => current.revision === state.revision
            ? {
                current: current.current,
                revision: current.revision,
                direction: current.direction,
              }
            : current)
        } : undefined}
      >
        {state.current}
      </span>
    </span>
  )
}

export function numberDigits(value: number): readonly {
  place: number
  value: number
}[] {
  const digits = String(value).split('')
  return digits.map((digit, index) => ({
    place: digits.length - index - 1,
    value: Number(digit),
  }))
}

function RollingNumber({ value }: { value: number }): ReactNode {
  const previousValue = useRef(value)
  const direction: RollingDirection = value < previousValue.current ? 'down' : 'up'

  useLayoutEffect(() => {
    previousValue.current = value
  }, [value])

  return (
    <span className="turn-progress-number" aria-hidden="true">
      {numberDigits(value).map((digit) => (
        <RollingDigit
          key={digit.place}
          value={digit.value}
          direction={direction}
        />
      ))}
    </span>
  )
}

function stepCount(progress: TurnProgressSnapshot): number | undefined {
  if (!progress.steps.length) return undefined
  const count = progress.phase === 'completed' ? progress.steps.length : progress.completedSteps
  return count || undefined
}

interface ChangedFileSummary {
  path: string
  additions: number
  deletions: number
}

function changedFileSummaries(files: readonly ChatFileChange[]): readonly ChangedFileSummary[] {
  const byPath = new Map<string, ChangedFileSummary>()
  for (const file of files) {
    const current = byPath.get(file.path)
    if (current) {
      current.additions += file.additions
      current.deletions += file.deletions
    } else {
      byPath.set(file.path, {
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
      })
    }
  }
  return [...byPath.values()]
}

function displayFilePath(path: string, workspace?: string): string {
  const root = workspace?.replace(/\/+$/u, '')
  return root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path
}

function useGrowOnExpansion(visible: boolean) {
  const pillRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = pillRef.current
    if (!visible || !element || typeof ResizeObserver !== 'function') return

    let previousWidth = element.getBoundingClientRect().width
    const stopGrowth = (): void => element.classList.remove('is-growing')
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width
      const growth = nextWidth - previousWidth
      previousWidth = nextWidth

      if (growth <= 1) {
        if (growth < -1) stopGrowth()
        return
      }

      element.style.setProperty('--turn-progress-grow-inset', String(growth / 2) + 'px')
      stopGrowth()
      void element.offsetWidth
      element.classList.add('is-growing')
    })

    element.addEventListener('animationend', stopGrowth)
    observer.observe(element)
    return () => {
      observer.disconnect()
      element.removeEventListener('animationend', stopGrowth)
      stopGrowth()
    }
  }, [visible])

  return pillRef
}

export function TurnProgressView({
  progress,
  reviewAction: ReviewAction,
  session,
  accessory,
}: {
  progress: TurnProgressSnapshot
  reviewAction?: ComponentType<FileReviewActionProps>
  session?: ClientSessionService
  accessory?: TurnProgressAccessory
}): ReactNode {
  const visible = progress.visible || Boolean(accessory)
  const pillRef = useGrowOnExpansion(visible)
  if (!visible) return null
  // An accessory may outlive the parent turn. Do not revive its completed
  // file totals or plan just to keep that accessory visible.
  const showProgress = progress.visible
  const completedStepCount = showProgress ? stepCount(progress) : undefined
  const stepLabel = completedStepCount
    ? String(completedStepCount) + ' ' + (completedStepCount === 1 ? 'step' : 'steps')
    : undefined
  const fileLabel = String(progress.filesChanged) + ' '
    + (progress.filesChanged === 1 ? 'file' : 'files')
    + ' changed'
  const ariaLabel = [
    showProgress && progress.phase === 'completed' ? 'Completed' : undefined,
    stepLabel,
    showProgress && progress.filesChanged ? fileLabel : undefined,
    showProgress && progress.filesChanged
      ? String(progress.additions) + ' additions, ' + String(progress.deletions) + ' deletions'
      : undefined,
    showProgress && progress.files.length ? 'Review available' : undefined,
    accessory?.label,
  ].filter(Boolean).join('. ')
  const reviewActivityId = 'turn:' + (progress.threadId ?? 'unknown') + ':' + (progress.turnId ?? 'active')
  const fileSummaries = showProgress ? changedFileSummaries(progress.files) : []
  const completedSteps = !showProgress ? [] : progress.phase === 'completed'
    ? progress.steps
    : progress.steps.filter((step) => step.status === 'completed')
  const workspace = session?.snapshot().session.workspace

  return (
    <div className="turn-progress-surface">
      <div className="turn-progress-control" tabIndex={0} aria-label={ariaLabel}>
        {completedSteps.length > 0 && (
          <div className="turn-progress-details" role="status">
            {completedSteps.map((step, stepIndex) => (
              <div className="turn-progress-step" key={String(stepIndex) + ':' + step.step}>
                <span className="turn-progress-step-icon"><StepIcon status="completed" /></span>
                <span>{step.step}</span>
              </div>
            ))}
          </div>
        )}
        {fileSummaries.length > 0 && (
          <div className="turn-progress-file-details" role="status">
            {fileSummaries.map((file) => (
              <div className="turn-progress-file-row" key={file.path}>
                <span className="turn-progress-file-icon">
                  <FileText size={17} strokeWidth={1.6} />
                </span>
                <span className="turn-progress-file-path" title={file.path}>
                  {displayFilePath(file.path, workspace)}
                </span>
                <span className="turn-progress-file-stats">
                  {file.additions > 0 && (
                    <span className="turn-progress-additions">+{file.additions}</span>
                  )}
                  {file.deletions > 0 && (
                    <span className="turn-progress-deletions">−{file.deletions}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {accessory?.details}
        <div ref={pillRef} className={'turn-progress-pill is-' + (showProgress ? progress.phase : 'active')}>
          {showProgress && <ProgressMark progress={progress} />}
          {showProgress && progress.phase === 'completed' && <span>Completed</span>}
          {completedStepCount && (
            <span>
              <RollingNumber value={completedStepCount} />
              <span>&nbsp;{completedStepCount === 1 ? 'step' : 'steps'}</span>
            </span>
          )}
          {showProgress && progress.filesChanged > 0 && (
            <>
              <span
                className="turn-progress-files-trigger"
                tabIndex={0}
                aria-label={fileLabel + '. Show changed files'}
              >
                <RollingNumber value={progress.filesChanged} />
                <span>&nbsp;{progress.filesChanged === 1 ? 'file' : 'files'} changed</span>
              </span>
              <span className="turn-progress-additions">
                +<RollingNumber value={progress.additions} />
              </span>
              <span className="turn-progress-deletions">
                −<RollingNumber value={progress.deletions} />
              </span>
            </>
          )}
          {showProgress && ReviewAction && session && progress.files.length > 0 && (
            <ReviewAction
              activityId={reviewActivityId}
              files={progress.files}
              session={session}
              appearance="icon"
            />
          )}
          {accessory?.content}
        </div>
      </div>
    </div>
  )
}

export function ConnectedTurnProgress({
  progress,
  session,
  ui,
}: {
  progress: TurnProgressService
  session: ClientSessionService
  ui: ClientUiService
}): ReactNode {
  const snapshot = useSyncExternalStore(progress.subscribe, progress.snapshot)
  useSyncExternalStore(ui.subscribe, ui.snapshot)
  const ReviewAction = ui.component<FileReviewActionProps>(FILE_REVIEW_ACTION_COMPONENT)
  const Accessory = ui.component<TurnProgressAccessoryProps>(TURN_PROGRESS_ACCESSORY)
  const render = (accessory?: TurnProgressAccessory): ReactNode => (
    <TurnProgressView
      progress={snapshot}
      session={session}
      {...(accessory ? { accessory } : {})}
      {...(ReviewAction ? { reviewAction: ReviewAction } : {})}
    />
  )
  return Accessory ? <Accessory session={session} render={render} /> : render()
}

const turnProgressClient: BrowserPlugin = (ctx) => {
  const progress = new TurnProgressService(ctx.clientHost, ctx.clientSession)
  ctx.clientUi.registerSurface(
    ctx,
    'default-turn-progress',
    () => (
      <ConnectedTurnProgress
        progress={progress}
        session={ctx.clientSession}
        ui={ctx.clientUi}
      />
    ),
  )
  ctx.clientUi.registerStyle(ctx, 'turn-progress', String(styles))
  return () => progress.dispose()
}

turnProgressClient.inject = ['clientHost', 'clientUi', 'clientSession']
turnProgressClient.resources = { provides: { surfaces: ['default-turn-progress'] } }

export default turnProgressClient
