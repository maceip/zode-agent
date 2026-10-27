import {
  Hash,
  Keyboard,
  RotateCcw,
  X,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { Context } from 'cordis'
import {
  clientStyles,
  type BrowserPlugin,
  type ClientOverlays,
  type ClientUiService,
} from '../../src/client/plugin-api.js'
import type {
  ClientHotkeysService,
  ClientHotkeysSnapshot,
  HotkeyAction,
  HotkeyActionRegistration,
  HotkeyBinding,
  ResolvedHotkeyAction,
} from './hotkeys-api.js'
import { ConversationPaneOverlay } from './ui/conversation-overlay.js'
import styles from './hotkeys.css'

interface HotkeysConfig {
  leader?: string
  timeoutMs?: number
}

interface PersistedConfig {
  version: 2
  leader: string
  overrides: Record<string, string | null>
}

interface StoredConfig {
  version?: number
  leader?: string
  overrides?: Record<string, unknown>
}

interface KeyEvent {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

interface SnapshotChange {
  pendingLeader?: boolean
  leaderPath?: readonly string[]
  recordingActionId?: string | undefined
}

const CONFIG_KEY = 'codex-cordis.hotkeys.config'
const LEADER_OVERLAY_ID = 'leader-hud'
const NATIVE_PANE_SELECTOR = '[data-native-pane-surface]'
const LEADER_HUD_WIDTH = 640

export interface HorizontalBounds {
  left: number
  right: number
}

export interface HudPlacement {
  left: number
  width: number
}

/** Places the HUD in the widest horizontal gap between native desktop surfaces. */
export function nativeSafeHudPlacement(
  viewportWidth: number,
  preferredWidth: number,
  margin: number,
  blockers: readonly HorizontalBounds[],
): HudPlacement | undefined {
  const viewportLeft = Math.max(0, margin)
  const viewportRight = Math.max(viewportLeft, viewportWidth - margin)
  const intervals = blockers
    .map(({ left, right }) => ({
      left: Math.max(viewportLeft, Math.min(viewportRight, left - margin)),
      right: Math.max(viewportLeft, Math.min(viewportRight, right + margin)),
    }))
    .filter(({ left, right }) => right > left)
    .sort((left, right) => left.left - right.left)

  const merged: HorizontalBounds[] = []
  for (const interval of intervals) {
    const previous = merged.at(-1)
    if (!previous || interval.left > previous.right) {
      merged.push({ ...interval })
    } else {
      previous.right = Math.max(previous.right, interval.right)
    }
  }

  const gaps: HorizontalBounds[] = []
  let cursor = viewportLeft
  for (const interval of merged) {
    if (interval.left > cursor) gaps.push({ left: cursor, right: interval.left })
    cursor = Math.max(cursor, interval.right)
  }
  if (cursor < viewportRight) gaps.push({ left: cursor, right: viewportRight })

  const gap = gaps.sort((left, right) => {
    const widthDifference = (right.right - right.left) - (left.right - left.left)
    return widthDifference || right.right - left.right
  })[0]
  if (!gap) return undefined

  const width = Math.min(preferredWidth, gap.right - gap.left)
  if (width <= 0) return undefined
  return { left: gap.right - width, width }
}

function safeRead<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key)
    return value === null ? fallback : JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function safeWrite(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Shortcut persistence is optional; registered actions remain usable in memory.
  }
}

export function normalizeHotkeyKey(key: string): string {
  if (key === 'Space' || key === 'Spacebar' || key === ' ') return ' '
  if (key === 'Option') return 'Alt'
  return key.length === 1 ? key.toLocaleLowerCase() : key
}

export function formatHotkeyKey(key: string): string {
  if (key === ' ') return 'Space'
  if (key === 'Alt') return '⌥'
  return key.length === 1 ? key.toLocaleUpperCase() : key
}

function compactHotkeyKey(key: string): string {
  const normalized = normalizeHotkeyKey(key)
  if (normalized === ' ') return 'Space'
  if (normalized === 'Enter') return '↵'
  if (normalized === 'Tab') return '⇥'
  if (normalized === 'Escape') return 'Esc'
  if (normalized === 'ArrowLeft') return '←'
  if (normalized === 'ArrowRight') return '→'
  if (normalized === 'ArrowUp') return '↑'
  if (normalized === 'ArrowDown') return '↓'
  return formatHotkeyKey(normalized)
}

function compactGlobalBinding(binding: Extract<HotkeyBinding, { kind: 'global' }>): string {
  return [
    binding.ctrl ? '⌃' : '',
    binding.alt ? '⌥' : '',
    binding.shift ? '⇧' : '',
    binding.meta ? '⌘' : '',
    compactHotkeyKey(binding.key),
  ].join('')
}

export function hotkeyHintLabel(
  action: ResolvedHotkeyAction | undefined,
  leader: string,
): string | undefined {
  if (!action?.enabled) return undefined
  const direct = action.binding?.kind === 'global'
    ? action.binding
    : action.aliases?.[0]
  if (direct) return compactGlobalBinding(direct)
  if (action.binding?.kind !== 'leader') return undefined
  return [
    compactHotkeyKey(leader),
    ...leaderBindingSequence(action.binding).map((key) => compactHotkeyKey(key)),
  ].join(' ')
}

type LeaderBinding = Extract<HotkeyBinding, { kind: 'leader' }>

export interface LeaderHudEntry {
  key: string
  label: string
  kind: 'action' | 'group'
}

export function leaderBindingSequence(binding: LeaderBinding): string[] {
  return [
    ...(binding.prefix ?? []).map((entry) => normalizeHotkeyKey(entry.key)),
    normalizeHotkeyKey(binding.key),
  ]
}

function beginsWith(sequence: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= sequence.length
    && prefix.every((key, index) => sequence[index] === key)
}

function leaderBindingsConflict(left: LeaderBinding, right: LeaderBinding): boolean {
  const leftSequence = leaderBindingSequence(left)
  const rightSequence = leaderBindingSequence(right)
  return beginsWith(leftSequence, rightSequence) || beginsWith(rightSequence, leftSequence)
}

export function leaderHudEntries(
  actions: readonly ResolvedHotkeyAction[],
  path: readonly string[],
): LeaderHudEntry[] {
  const entries = new Map<string, LeaderHudEntry>()
  for (const action of actions) {
    if (!action.enabled || action.binding?.kind !== 'leader') continue
    const sequence = leaderBindingSequence(action.binding)
    if (!beginsWith(sequence, path) || sequence.length <= path.length) continue
    const prefix = action.binding.prefix ?? []
    const group = path.length < prefix.length
    const key = sequence[path.length]!
    const entry: LeaderHudEntry = {
      key,
      label: group ? prefix[path.length]?.label ?? action.category : action.label,
      kind: group ? 'group' : 'action',
    }
    const current = entries.get(key)
    if (!current || entry.kind === 'group') entries.set(key, entry)
  }
  return [...entries.values()].sort((left, right) => (
    left.key.localeCompare(right.key, undefined, { numeric: true })
  ))
}

function physicalHotkeyCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (key === ' ') return 'Space'
  if (key === '-' || key === '_') return 'Minus'
  if (key === '=' || key === '+') return 'Equal'
  if (key === '[' || key === '{') return 'BracketLeft'
  if (key === ']' || key === '}') return 'BracketRight'
  return key
}

export function matchesGlobalBinding(event: KeyEvent, binding: HotkeyBinding): boolean {
  return binding.kind === 'global'
    && (
      normalizeHotkeyKey(event.key) === normalizeHotkeyKey(binding.key)
      || event.code === physicalHotkeyCode(binding.key)
    )
    && event.ctrlKey === Boolean(binding.ctrl)
    && event.metaKey === Boolean(binding.meta)
    && event.altKey === Boolean(binding.alt)
    && event.shiftKey === Boolean(binding.shift)
}

export function editableTarget(target: EventTarget | null): boolean {
  const element = target as (EventTarget & {
    closest?: (selector: string) => { getAttribute(name: string): string | null } | null
  }) | null
  if (typeof element?.closest !== 'function') return false
  if (element.closest('input, textarea, select, [role="textbox"]')) return true
  const contentEditable = element.closest('[contenteditable]')
  return contentEditable !== null && contentEditable.getAttribute('contenteditable') !== 'false'
}

export function preservesEditableNavigation(event: KeyEvent, target: EventTarget | null): boolean {
  return editableTarget(target) && (
    event.key === 'ArrowLeft'
    || event.key === 'ArrowRight'
    || event.key === 'ArrowUp'
    || event.key === 'ArrowDown'
  )
}

function initialConfig(config: HotkeysConfig): PersistedConfig {
  const configuredLeader = normalizeHotkeyKey(config.leader ?? 'Alt')
  const fallback: PersistedConfig = {
    version: 2,
    leader: configuredLeader,
    overrides: {},
  }
  const value = safeRead<StoredConfig | null>(CONFIG_KEY, null)
  if (
    (value?.version !== 1 && value?.version !== 2)
    || typeof value.leader !== 'string'
    || !value.overrides
  ) return fallback
  const savedLeader = normalizeHotkeyKey(value.leader)
  return {
    version: 2,
    // Version 1 shipped with Space as its default. Migrate that default once,
    // while preserving explicit comma/semicolon/backslash customizations.
    leader: value.version === 1 && savedLeader === ' ' ? configuredLeader : savedLeader,
    overrides: Object.fromEntries(Object.entries(value.overrides).filter((entry) => (
      typeof entry[1] === 'string' || entry[1] === null
    ))) as Record<string, string | null>,
  }
}

export class HotkeysService implements ClientHotkeysService {
  private readonly actions = new Map<string, HotkeyAction>()
  private readonly listeners = new Set<() => void>()
  private readonly keydown = (event: KeyboardEvent) => this.onKeyDown(event)
  private readonly keyup = (event: KeyboardEvent) => this.onKeyUp(event)
  private readonly blur = () => {
    this.modifierLeaderArmed = false
    this.clearPendingLeader()
  }
  private config: PersistedConfig
  private state: ClientHotkeysSnapshot
  private pendingTimer?: number
  private modifierLeaderArmed = false
  private ownsLeaderOverlay = false
  private disposed = false

  constructor(
    private readonly ui: ClientUiService,
    private readonly options: HotkeysConfig,
  ) {
    this.config = initialConfig(options)
    this.state = this.buildSnapshot(0, false, [])
    window.addEventListener('keydown', this.keydown, true)
    window.addEventListener('keyup', this.keyup, true)
    window.addEventListener('blur', this.blur)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientHotkeysSnapshot => this.state

  registerAction(owner: Context, action: HotkeyAction): HotkeyActionRegistration {
    let active = false
    const dispose = owner.effect(() => {
      if (this.actions.has(action.id)) throw new Error(`hotkey action "${action.id}" is already registered`)
      const binding = this.resolvedBinding(action)
      if (binding?.kind === 'leader') {
        for (const candidate of this.actions.values()) {
          const candidateBinding = this.resolvedBinding(candidate)
          if (candidateBinding?.kind === 'leader' && leaderBindingsConflict(binding, candidateBinding)) {
            throw new Error(`leader binding for "${action.id}" conflicts with "${candidate.id}"`)
          }
        }
      }
      active = true
      this.actions.set(action.id, action)
      this.emit()
      return () => {
        active = false
        if (this.actions.get(action.id) === action) this.actions.delete(action.id)
        this.emit()
      }
    }, `clientHotkeys.registerAction(${JSON.stringify(action.id)})`)
    return {
      dispose: async () => {
        if (active) await dispose()
      },
    }
  }

  open(): void {
    this.ui.overlays.open('hotkeys')
  }

  setLeader(key: string): void {
    const leader = normalizeHotkeyKey(key)
    if (!leader || leader === this.config.leader) return
    this.modifierLeaderArmed = false
    this.clearPendingLeader()
    this.config = { ...this.config, leader }
    this.persistConfig()
    this.emit()
  }

  setLeaderBinding(actionId: string, key: string | undefined): void {
    const action = this.actions.get(actionId)
    if (!action || action.binding.kind !== 'leader') return
    const overrides = { ...this.config.overrides }
    if (key === undefined) {
      delete overrides[actionId]
    } else {
      const normalized = normalizeHotkeyKey(key)
      const nextBinding: LeaderBinding = { ...action.binding, key: normalized }
      for (const candidate of this.actions.values()) {
        if (candidate.id === actionId || candidate.binding.kind !== 'leader') continue
        const binding = this.resolvedBinding(candidate)
        if (binding?.kind === 'leader' && leaderBindingsConflict(nextBinding, binding)) {
          overrides[candidate.id] = null
        }
      }
      overrides[actionId] = normalized
    }
    this.config = { ...this.config, overrides }
    this.persistConfig()
    this.emit({ recordingActionId: undefined })
  }

  resetBindings(): void {
    this.modifierLeaderArmed = false
    this.clearPendingLeader()
    this.config = {
      version: 2,
      leader: normalizeHotkeyKey(this.options.leader ?? 'Alt'),
      overrides: {},
    }
    this.persistConfig()
    this.emit({ recordingActionId: undefined })
  }

  beginRecording(actionId: string): void {
    if (this.actions.get(actionId)?.binding.kind !== 'leader') return
    this.clearPendingLeader()
    this.emit({ recordingActionId: actionId })
  }

  cancelRecording(): void {
    if (!this.state.recordingActionId) return
    this.emit({ recordingActionId: undefined })
  }

  dispose(): void {
    if (this.disposed) return
    this.clearPendingLeader()
    this.disposed = true
    window.removeEventListener('keydown', this.keydown, true)
    window.removeEventListener('keyup', this.keyup, true)
    window.removeEventListener('blur', this.blur)
    this.listeners.clear()
    this.actions.clear()
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.isComposing) return
    if (this.state.recordingActionId) {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') this.cancelRecording()
      else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        this.setLeaderBinding(this.state.recordingActionId, event.key)
      }
      return
    }

    if (this.config.leader === 'Alt' && normalizeHotkeyKey(event.key) === 'Alt') {
      this.modifierLeaderArmed = !event.repeat
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
        && !editableTarget(event.target)
      if (this.modifierLeaderArmed) {
        event.preventDefault()
        event.stopPropagation()
        this.clearPendingLeader()
      }
      return
    }

    // Any key pressed while Option is held turns the gesture into a regular
    // modifier chord. This preserves Option-H/J/K/L and terminal Meta keys.
    this.modifierLeaderArmed = false

    // Arrow chords inside an editor belong to the editor. In particular,
    // macOS uses Option-Left/Right for word navigation, while workspace panes
    // use the same chords outside editable controls.
    const global = preservesEditableNavigation(event, event.target)
      ? undefined
      : this.resolvedActions().find((action) => (
        action.enabled && (
          (action.binding && matchesGlobalBinding(event, action.binding))
          || action.aliases?.some((binding) => matchesGlobalBinding(event, binding))
        )
      ))
    if (global) {
      event.preventDefault()
      event.stopPropagation()
      this.clearPendingLeader()
      if (!event.repeat || global.repeat) this.run(global.id)
      return
    }

    if (editableTarget(event.target)) {
      this.clearPendingLeader()
      return
    }

    if (this.state.pendingLeader) {
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      const key = normalizeHotkeyKey(event.key)
      if (key === 'Escape') {
        this.clearPendingLeader()
        return
      }
      const path = [...this.state.leaderPath, key]
      const matches = this.resolvedActions().filter((candidate) => (
        candidate.enabled
        && candidate.binding?.kind === 'leader'
        && beginsWith(leaderBindingSequence(candidate.binding), path)
      ))
      const action = matches.find((candidate) => (
        candidate.binding?.kind === 'leader'
        && leaderBindingSequence(candidate.binding).length === path.length
      ))
      if (action) {
        this.clearPendingLeader()
        this.run(action.id)
      } else if (matches.length) {
        this.continueLeader(path)
      } else {
        this.clearPendingLeader()
      }
      return
    }

    if (
      event.repeat
      || event.ctrlKey
      || event.metaKey
      || event.altKey
      || normalizeHotkeyKey(event.key) !== this.config.leader
    ) return
    event.preventDefault()
    event.stopPropagation()
    if (!this.ui.overlays.snapshot()) {
      this.ui.overlays.open(LEADER_OVERLAY_ID, { occludesNativeViews: false })
      this.ownsLeaderOverlay = true
    }
    this.continueLeader([])
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (
      !this.modifierLeaderArmed
      || this.config.leader !== 'Alt'
      || normalizeHotkeyKey(event.key) !== 'Alt'
    ) return
    this.modifierLeaderArmed = false
    event.preventDefault()
    event.stopPropagation()
    if (!this.ui.overlays.snapshot()) {
      this.ui.overlays.open(LEADER_OVERLAY_ID, { occludesNativeViews: false })
      this.ownsLeaderOverlay = true
    }
    this.continueLeader([])
  }

  private continueLeader(path: readonly string[]): void {
    if (this.pendingTimer !== undefined) window.clearTimeout(this.pendingTimer)
    this.emit({ pendingLeader: true, leaderPath: path })
    this.pendingTimer = window.setTimeout(
      () => this.clearPendingLeader(),
      this.options.timeoutMs ?? 1_200,
    )
  }

  private run(id: string): void {
    const action = this.actions.get(id)
    if (!action || action.enabled?.() === false) return
    void Promise.resolve(action.run()).catch((error: unknown) => console.error(error))
  }

  private clearPendingLeader(): void {
    if (this.pendingTimer !== undefined) window.clearTimeout(this.pendingTimer)
    delete this.pendingTimer
    if (this.ownsLeaderOverlay) {
      this.ownsLeaderOverlay = false
      this.ui.overlays.close(LEADER_OVERLAY_ID)
    }
    if (this.state.pendingLeader) this.emit({ pendingLeader: false, leaderPath: [] })
  }

  private resolvedBinding(action: HotkeyAction): HotkeyBinding | undefined {
    if (action.binding.kind === 'global') return action.binding
    if (!Object.hasOwn(this.config.overrides, action.id)) return action.binding
    const key = this.config.overrides[action.id]
    return key == null ? undefined : { ...action.binding, key }
  }

  private resolvedActions(): ResolvedHotkeyAction[] {
    return [...this.actions.values()].map((action) => ({
      id: action.id,
      label: action.label,
      category: action.category,
      ...(action.detail ? { detail: action.detail } : {}),
      ...(this.resolvedBinding(action) ? { binding: this.resolvedBinding(action)! } : {}),
      ...(action.aliases?.length ? { aliases: action.aliases } : {}),
      ...(action.repeat ? { repeat: true } : {}),
      enabled: action.enabled?.() ?? true,
    }))
  }

  private buildSnapshot(
    revision: number,
    pendingLeader: boolean,
    leaderPath: readonly string[],
    recordingActionId?: string,
  ): ClientHotkeysSnapshot {
    return {
      revision,
      leader: this.config.leader,
      pendingLeader,
      leaderPath,
      ...(recordingActionId ? { recordingActionId } : {}),
      actions: this.resolvedActions(),
    }
  }

  private emit(change: SnapshotChange = {}): void {
    if (this.disposed) return
    const recording = 'recordingActionId' in change ? change.recordingActionId : this.state.recordingActionId
    const pending = change.pendingLeader ?? this.state.pendingLeader
    this.state = this.buildSnapshot(
      this.state.revision + 1,
      pending,
      pending ? change.leaderPath ?? this.state.leaderPath : [],
      recording,
    )
    for (const listener of this.listeners) listener()
  }

  private persistConfig(): void {
    safeWrite(CONFIG_KEY, this.config)
  }
}

function bindingLabel(binding: HotkeyBinding | undefined, leader: string): ReactNode {
  if (!binding) return <span className="hotkey-unassigned">Unassigned</span>
  if (binding.kind === 'leader') {
    const sequence = [leader, ...leaderBindingSequence(binding)]
    return <>{sequence.map((key, index) => <kbd key={`${key}:${index}`}>{formatHotkeyKey(key)}</kbd>)}</>
  }
  return (
    <>
      {binding.ctrl && <kbd>Ctrl</kbd>}
      {binding.meta && <kbd>⌘</kbd>}
      {binding.alt && <kbd>⌥</kbd>}
      {binding.shift && <kbd>⇧</kbd>}
      <kbd>{formatHotkeyKey(binding.key)}</kbd>
    </>
  )
}

function LeaderHud({ state }: { state: ClientHotkeysSnapshot }): ReactNode {
  const hudRef = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    if (!state.pendingLeader) return
    let frame: number | undefined

    const place = (): void => {
      frame = undefined
      const hud = hudRef.current
      if (!hud) return

      const margin = window.innerWidth <= 680 ? 10 : 18
      const hudBounds = hud.getBoundingClientRect()
      const hudTop = window.innerHeight - margin - hudBounds.height
      const blockers = [...document.querySelectorAll<HTMLElement>(NATIVE_PANE_SELECTOR)]
        .map((element) => element.getBoundingClientRect())
        .filter((bounds) => (
          bounds.width > 1
          && bounds.height > 1
          && bounds.bottom > hudTop
          && bounds.top < window.innerHeight - margin
        ))
        .map(({ left, right }) => ({ left, right }))
      const placement = blockers.length
        ? nativeSafeHudPlacement(window.innerWidth, LEADER_HUD_WIDTH, margin, blockers)
        : undefined

      if (placement) {
        hud.style.left = `${placement.left}px`
        hud.style.right = 'auto'
        hud.style.width = `${placement.width}px`
      } else {
        hud.style.removeProperty('left')
        hud.style.removeProperty('right')
        hud.style.removeProperty('width')
      }
    }
    const schedule = (): void => {
      if (frame === undefined) frame = window.requestAnimationFrame(place)
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    if (hudRef.current) observer?.observe(hudRef.current)
    for (const surface of document.querySelectorAll<HTMLElement>(NATIVE_PANE_SELECTOR)) {
      observer?.observe(surface)
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [state.pendingLeader])

  if (!state.pendingLeader) return null
  const entries = leaderHudEntries(state.actions, state.leaderPath)
  const trail = [state.leader, ...state.leaderPath]
  return (
    <aside className={`${clientStyles.floatingPanel} leader-hud`} role="status" aria-label="Leader shortcuts" ref={hudRef}>
      <header className="leader-hud-header">
        <span className="leader-hud-trail">
          {trail.map((key, index) => (
            <span key={`${key}:${index}`}>
              {index > 0 && <i>›</i>}
              <kbd>{formatHotkeyKey(key)}</kbd>
            </span>
          ))}
        </span>
        <small>{state.leaderPath.length ? 'Subcommands' : 'Leader commands'}</small>
      </header>
      <div className="leader-hud-grid">
        {entries.map((entry) => (
          <span className={`leader-hud-action is-${entry.kind}`} key={`${entry.kind}:${entry.key}`}>
            <kbd>{formatHotkeyKey(entry.key)}</kbd>
            <span>{entry.label}</span>
            {entry.kind === 'group' && <i>›</i>}
          </span>
        ))}
      </div>
      <footer className="leader-hud-footer"><kbd>Esc</kbd><span>Cancel</span></footer>
    </aside>
  )
}

function ShortcutsPanel({
  state,
  service,
}: {
  state: ClientHotkeysSnapshot
  service: ClientHotkeysService
}): ReactNode {
  const categories = [...new Set(state.actions.map((action) => action.category))]
  return (
    <div className="hotkeys-panel-body shortcuts-panel">
      <section className="hotkey-leader-setting">
        <span>
          <strong>Leader key</strong>
          <small>Leader shortcuts pause while you type or edit a field.</small>
        </span>
        <select value={state.leader} onChange={(event) => service.setLeader(event.target.value)}>
          <option value="Alt">Option (⌥)</option>
          <option value=" ">Space</option>
          <option value=",">Comma</option>
          <option value=";">Semicolon</option>
          <option value="\\">Backslash</option>
        </select>
      </section>
      {categories.map((category) => {
        const actions = state.actions.filter((action) => action.category === category)
        return (
          <section className="shortcut-group" key={category}>
            <h2>{category}</h2>
            <div className="shortcut-list">
              {actions.map((action) => {
                const recording = state.recordingActionId === action.id
                return (
                  <div className={`shortcut-row ${recording ? 'recording' : ''}`} key={action.id}>
                    <span className="shortcut-copy">
                      <strong>{action.label}</strong>
                      {action.detail && <small>{action.detail}</small>}
                    </span>
                    <span className="shortcut-binding">{bindingLabel(action.binding, state.leader)}</span>
                    {action.binding?.kind !== 'global' && (
                      <button type="button" onClick={() => service.beginRecording(action.id)}>
                        {recording ? 'Press a key…' : 'Change'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
      <button className="hotkeys-reset" type="button" onClick={() => service.resetBindings()}>
        <RotateCcw size={13} /> Reset shortcuts
      </button>
    </div>
  )
}

interface ButtonHotkeyHintState {
  key: string
  label: string
  left: number
  top: number
  placement: 'above' | 'below'
}

export function hotkeyHintPlacement(top: number): 'above' | 'below' {
  return top >= 72 ? 'above' : 'below'
}

const HOTKEY_TARGET_SELECTOR = '[data-hotkey-action], [data-hotkey]'

function hotkeyTarget(value: EventTarget | null): HTMLElement | undefined {
  return value instanceof Element
    ? value.closest<HTMLElement>(HOTKEY_TARGET_SELECTOR) ?? undefined
    : undefined
}

function ButtonHotkeyHint({ state }: { state: ClientHotkeysSnapshot }): ReactNode {
  const [hint, setHint] = useState<ButtonHotkeyHintState>()
  const pointerTarget = useRef<HTMLElement | undefined>(undefined)
  const focusTarget = useRef<HTMLElement | undefined>(undefined)

  useEffect(() => {
    const actions = new Map(state.actions.map((action) => [action.id, action]))
    const show = (target: HTMLElement | undefined): void => {
      if (!target || !target.isConnected) {
        setHint(undefined)
        return
      }
      const staticLabel = target.dataset.hotkey?.trim()
      const action = target.dataset.hotkeyAction
        ? actions.get(target.dataset.hotkeyAction)
        : undefined
      const label = staticLabel || hotkeyHintLabel(action, state.leader)
      const rect = target.getBoundingClientRect()
      if (!label || rect.width === 0 || rect.height === 0) {
        setHint(undefined)
        return
      }
      const placement = hotkeyHintPlacement(rect.top)
      const left = Math.max(36, Math.min(window.innerWidth - 36, rect.left + rect.width / 2))
      const top = placement === 'above' ? rect.top - 7 : rect.bottom + 7
      setHint({
        key: `${label}:${Math.round(left)}:${Math.round(top)}`,
        label,
        left,
        top,
        placement,
      })
    }
    const sync = (): void => show(pointerTarget.current ?? focusTarget.current)
    const pointerOver = (event: PointerEvent): void => {
      const target = hotkeyTarget(event.target)
      if (!target || target === pointerTarget.current) return
      pointerTarget.current = target
      sync()
    }
    const pointerOut = (event: PointerEvent): void => {
      const target = hotkeyTarget(event.target)
      if (!target || target !== pointerTarget.current) return
      const next = hotkeyTarget(event.relatedTarget)
      if (next === target) return
      pointerTarget.current = next
      sync()
    }
    const focusIn = (event: FocusEvent): void => {
      focusTarget.current = hotkeyTarget(event.target)
      sync()
    }
    const focusOut = (event: FocusEvent): void => {
      const target = hotkeyTarget(event.target)
      if (!target || target !== focusTarget.current) return
      focusTarget.current = hotkeyTarget(event.relatedTarget)
      sync()
    }
    const dismiss = (): void => {
      pointerTarget.current = undefined
      focusTarget.current = undefined
      setHint(undefined)
    }

    document.addEventListener('pointerover', pointerOver)
    document.addEventListener('pointerout', pointerOut)
    document.addEventListener('focusin', focusIn)
    document.addEventListener('focusout', focusOut)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerover', pointerOver)
      document.removeEventListener('pointerout', pointerOut)
      document.removeEventListener('focusin', focusIn)
      document.removeEventListener('focusout', focusOut)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [state.actions, state.leader])

  if (!hint) return null
  return (
    <div
      className={`button-hotkey-hint is-${hint.placement}`}
      role="tooltip"
      style={{ left: hint.left, top: hint.top }}
      key={hint.key}
    >
      <kbd>{hint.label}</kbd>
    </div>
  )
}

function HotkeysRoot({
  service,
  overlays,
}: {
  service: ClientHotkeysService
  overlays: ClientOverlays
}): ReactNode {
  const state = useSyncExternalStore(service.subscribe, service.snapshot)
  const activeOverlay = useSyncExternalStore(overlays.subscribe, overlays.snapshot)
  const open = activeOverlay === 'hotkeys'
  const close = () => overlays.close('hotkeys')

  useEffect(() => {
    if (!open) return
    const dismiss = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && !state.recordingActionId) close()
    }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [open, state.recordingActionId])

  return (
    <>
      <ButtonHotkeyHint state={state} />
      <LeaderHud state={state} />
      {open && (
        <ConversationPaneOverlay className="hotkeys-backdrop" onMouseDown={close}>
          <section className="hotkeys-dialog" role="dialog" aria-modal="true" aria-label="Hotkeys" onMouseDown={(event) => event.stopPropagation()}>
            <header className="hotkeys-dialog-header">
              <span className="hotkeys-dialog-title"><Keyboard size={16} /><strong>Hotkeys</strong></span>
              <button className="hotkeys-close" type="button" aria-label="Close hotkeys" onClick={close}><X size={15} /></button>
            </header>
            <ShortcutsPanel state={state} service={service} />
            <footer className="hotkeys-footer">
              <span><Hash size={12} /> Leader: <kbd>{formatHotkeyKey(state.leader)}</kbd></span>
              <span><kbd>Esc</kbd> Close</span>
            </footer>
          </section>
        </ConversationPaneOverlay>
      )}
    </>
  )
}

function leaderAction(
  id: string,
  key: string,
  label: string,
  category: string,
  run: HotkeyAction['run'],
  detail?: string,
  enabled?: HotkeyAction['enabled'],
): HotkeyAction {
  return {
    id,
    label,
    category,
    binding: { kind: 'leader', key },
    run,
    ...(detail ? { detail } : {}),
    ...(enabled ? { enabled } : {}),
  }
}

const hotkeysClient: BrowserPlugin<HotkeysConfig> = (ctx, config) => {
  const ui = ctx.clientUi
  const service = new HotkeysService(ui, config)
  ctx.provide('clientHotkeys', service)

  service.registerAction(ctx, leaderAction(
    'hotkeys.open', '?', 'Hotkey control', 'Panels',
    () => service.open(),
    'Inspect or rebind shortcuts.',
  ))

  const BoundRoot = () => <HotkeysRoot service={service} overlays={ui.overlays} />
  ui.registerRoot(ctx, 'hotkeys', BoundRoot)
  ui.registerStyle(ctx, 'hotkeys', String(styles))
  return () => service.dispose()
}

hotkeysClient.inject = ['clientUi']
hotkeysClient.provide = 'clientHotkeys'
hotkeysClient.resources = { provides: { roots: ['hotkeys'] } }

export default hotkeysClient
