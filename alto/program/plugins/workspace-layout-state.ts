import type { ThreadSummary } from '../../src/shared/protocol.js'
import { normalizeTabGroups, parseTabGroups, type WorkspaceTabGroup } from './workspace-tab-groups.js'

export const WORKSPACE_LAYOUT_READ_METHOD = 'workspace-layout.persistence.read'
export const WORKSPACE_LAYOUT_WRITE_METHOD = 'workspace-layout.persistence.write'

export type WorkspaceSplitDirection = 'horizontal' | 'vertical'
export type WorkspaceMoveDirection = 'left' | 'right' | 'up' | 'down'
export type WorkspaceHistoryDirection = -1 | 1

export interface WorkspacePaneLocation {
  workspace: string
  projectId?: string
  unscoped?: boolean
  thread?: ThreadSummary
}

export interface WorkspacePaneNavigation {
  index: number
  entries: WorkspacePaneLocation[]
}

export interface WorkspacePaneNode {
  type: 'pane'
  id: string
  kind?: string
  workspace: string
  projectId?: string
  unscoped?: boolean
  thread?: ThreadSummary
  /** Opaque, persisted resource identifier interpreted by the pane-kind plugin. */
  resource?: string
  navigation?: WorkspacePaneNavigation
}

export interface WorkspaceSplitNode {
  type: 'split'
  id: string
  direction: WorkspaceSplitDirection
  ratio: number
  first: WorkspaceLayoutNode
  second: WorkspaceLayoutNode
}

export type WorkspaceLayoutNode = WorkspacePaneNode | WorkspaceSplitNode

export interface WorkspaceTabNameBinding {
  source: string
  id: string
}

export interface WorkspaceView {
  id: string
  groupId?: string
  name: string
  nameBinding?: WorkspaceTabNameBinding
  workspace: string
  projectId?: string
  unscoped?: boolean
  focusedPaneId: string
  maximizedPaneId?: string
  root: WorkspaceLayoutNode
}

export interface WorkspaceLayoutState {
  version: 2
  activeViewId: string
  views: WorkspaceView[]
  groups?: WorkspaceTabGroup[]
}

export function firstWorkspacePane(node: WorkspaceLayoutNode): WorkspacePaneNode {
  return node.type === 'pane' ? node : firstWorkspacePane(node.first)
}

export function workspacePaneIds(node: WorkspaceLayoutNode): string[] {
  if (node.type === 'pane') return [node.id]
  return [...workspacePaneIds(node.first), ...workspacePaneIds(node.second)]
}

export function workspacePane(
  node: WorkspaceLayoutNode,
  paneId: string,
): WorkspacePaneNode | undefined {
  if (node.type === 'pane') return node.id === paneId ? node : undefined
  return workspacePane(node.first, paneId) ?? workspacePane(node.second, paneId)
}

export function workspacePaneOfKind(
  node: WorkspaceLayoutNode,
  kind: string,
): WorkspacePaneNode | undefined {
  if (node.type === 'pane') return node.kind === kind ? node : undefined
  return workspacePaneOfKind(node.first, kind) ?? workspacePaneOfKind(node.second, kind)
}

export function mapWorkspacePane(
  node: WorkspaceLayoutNode,
  paneId: string,
  update: (pane: WorkspacePaneNode) => WorkspacePaneNode,
): WorkspaceLayoutNode {
  if (node.type === 'pane') return node.id === paneId ? update(node) : node
  const first = mapWorkspacePane(node.first, paneId, update)
  const second = mapWorkspacePane(node.second, paneId, update)
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second }
}

const WORKSPACE_PANE_HISTORY_LIMIT = 50

function sameThread(left: ThreadSummary | undefined, right: ThreadSummary | undefined): boolean {
  if (!left || !right) return left === right
  return left.id === right.id
    && left.title === right.title
    && left.preview === right.preview
    && left.cwd === right.cwd
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.recencyAt === right.recencyAt
    && left.projectId === right.projectId
    && left.projectRef?.source === right.projectRef?.source
    && left.projectRef?.id === right.projectRef?.id
    && left.gitInfo?.branch === right.gitInfo?.branch
    && left.gitInfo?.sha === right.gitInfo?.sha
    && left.gitInfo?.originUrl === right.gitInfo?.originUrl
    && left.modelProvider === right.modelProvider
    && left.status?.type === right.status?.type
    && JSON.stringify(left.status?.activeFlags ?? []) === JSON.stringify(right.status?.activeFlags ?? [])
    && left.canAcceptDirectInput === right.canAcceptDirectInput
}

function sameLocation(left: WorkspacePaneLocation, right: WorkspacePaneLocation): boolean {
  if (left.thread || right.thread) return left.thread?.id === right.thread?.id
  return left.workspace === right.workspace
    && left.projectId === right.projectId
    && left.unscoped === right.unscoped
}

function locationMatchesPane(pane: WorkspacePaneNode, location: WorkspacePaneLocation): boolean {
  return pane.workspace === location.workspace
    && pane.projectId === location.projectId
    && pane.unscoped === location.unscoped
    && sameThread(pane.thread, location.thread)
}

function atLocation(
  pane: WorkspacePaneNode,
  location: WorkspacePaneLocation,
  navigation: WorkspacePaneNavigation,
): WorkspacePaneNode {
  const next: WorkspacePaneNode = {
    ...pane,
    workspace: location.workspace,
    navigation,
  }
  if (location.projectId) next.projectId = location.projectId
  else delete next.projectId
  if (location.unscoped) next.unscoped = true
  else delete next.unscoped
  if (location.thread) next.thread = location.thread
  else delete next.thread
  return next
}

export function workspacePaneLocation(pane: WorkspacePaneNode): WorkspacePaneLocation {
  return {
    workspace: pane.workspace,
    ...(pane.projectId ? { projectId: pane.projectId } : {}),
    ...(pane.unscoped ? { unscoped: true } : {}),
    ...(pane.thread ? { thread: pane.thread } : {}),
  }
}

/** Records a pane location using browser-style history semantics. */
export function recordWorkspacePaneLocation(
  pane: WorkspacePaneNode,
  location: WorkspacePaneLocation,
): WorkspacePaneNode {
  const existing = pane.navigation
  if (!existing) {
    return atLocation(pane, location, { index: 0, entries: [location] })
  }

  const current = existing.entries[existing.index]
  if (current && sameLocation(current, location)) {
    const entryChanged = current.workspace !== location.workspace
      || current.projectId !== location.projectId
      || current.unscoped !== location.unscoped
      || !sameThread(current.thread, location.thread)
    if (!entryChanged && locationMatchesPane(pane, location)) return pane
    const entries = [...existing.entries]
    entries[existing.index] = location
    return atLocation(pane, location, { ...existing, entries })
  }

  // Retargeting a blank composer, or turning it into its first chat, should
  // not leave a dead blank page in the Back stack.
  if (current && !current.thread) {
    const entries = [...existing.entries]
    entries[existing.index] = location
    return atLocation(pane, location, { ...existing, entries })
  }

  const entries = [...existing.entries.slice(0, existing.index + 1), location]
    .slice(-WORKSPACE_PANE_HISTORY_LIMIT)
  return atLocation(pane, location, { index: entries.length - 1, entries })
}

export function canNavigateWorkspacePane(
  pane: WorkspacePaneNode | undefined,
  direction: WorkspaceHistoryDirection,
): boolean {
  if (!pane?.navigation) return false
  const index = pane.navigation.index + direction
  return index >= 0 && index < pane.navigation.entries.length
}

export function navigateWorkspacePane(
  pane: WorkspacePaneNode,
  direction: WorkspaceHistoryDirection,
): { pane: WorkspacePaneNode; location: WorkspacePaneLocation } | undefined {
  const navigation = pane.navigation
  if (!navigation) return undefined
  const index = navigation.index + direction
  const location = navigation.entries[index]
  if (!location) return undefined
  return {
    pane: atLocation(pane, location, { ...navigation, index }),
    location,
  }
}

export function splitWorkspacePane(
  node: WorkspaceLayoutNode,
  paneId: string,
  direction: WorkspaceSplitDirection,
  nextPane: WorkspacePaneNode,
  splitId: string,
): WorkspaceLayoutNode {
  if (node.type === 'pane') {
    if (node.id !== paneId) return node
    return {
      type: 'split',
      id: splitId,
      direction,
      ratio: 0.5,
      first: node,
      second: nextPane,
    }
  }
  const first = splitWorkspacePane(node.first, paneId, direction, nextPane, splitId)
  if (first !== node.first) return { ...node, first }
  const second = splitWorkspacePane(node.second, paneId, direction, nextPane, splitId)
  return second === node.second ? node : { ...node, second }
}

export function removeWorkspacePane(
  node: WorkspaceLayoutNode,
  paneId: string,
): WorkspaceLayoutNode | undefined {
  if (node.type === 'pane') return node.id === paneId ? undefined : node
  const first = removeWorkspacePane(node.first, paneId)
  const second = removeWorkspacePane(node.second, paneId)
  if (!first) return second
  if (!second) return first
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second }
}

export function resizeWorkspaceSplit(
  node: WorkspaceLayoutNode,
  splitId: string,
  ratio: number,
): WorkspaceLayoutNode {
  if (node.type === 'pane') return node
  if (node.id === splitId) return { ...node, ratio: Math.max(0.2, Math.min(0.8, ratio)) }
  const first = resizeWorkspaceSplit(node.first, splitId, ratio)
  const second = resizeWorkspaceSplit(node.second, splitId, ratio)
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second }
}

interface WorkspacePaneRect {
  id: string
  left: number
  top: number
  right: number
  bottom: number
}

function paneRects(
  node: WorkspaceLayoutNode,
  left = 0,
  top = 0,
  right = 1,
  bottom = 1,
): WorkspacePaneRect[] {
  if (node.type === 'pane') return [{ id: node.id, left, top, right, bottom }]
  if (node.direction === 'horizontal') {
    const split = left + (right - left) * node.ratio
    return [
      ...paneRects(node.first, left, top, split, bottom),
      ...paneRects(node.second, split, top, right, bottom),
    ]
  }
  const split = top + (bottom - top) * node.ratio
  return [
    ...paneRects(node.first, left, top, right, split),
    ...paneRects(node.second, left, split, right, bottom),
  ]
}

function intervalGap(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): number {
  if (firstEnd < secondStart) return secondStart - firstEnd
  if (secondEnd < firstStart) return firstStart - secondEnd
  return 0
}

/** Finds the visually nearest pane in one Vim direction. */
export function adjacentWorkspacePane(
  node: WorkspaceLayoutNode,
  paneId: string,
  direction: WorkspaceMoveDirection,
): string | undefined {
  const panes = paneRects(node)
  const current = panes.find((pane) => pane.id === paneId)
  if (!current) return undefined
  const horizontal = direction === 'left' || direction === 'right'
  const currentPrimary = horizontal
    ? (current.left + current.right) / 2
    : (current.top + current.bottom) / 2
  const currentCross = horizontal
    ? (current.top + current.bottom) / 2
    : (current.left + current.right) / 2

  return panes
    .filter((pane) => {
      if (pane.id === paneId) return false
      if (direction === 'left') return pane.right <= current.left
      if (direction === 'right') return pane.left >= current.right
      if (direction === 'up') return pane.bottom <= current.top
      return pane.top >= current.bottom
    })
    .map((pane) => {
      const primary = horizontal
        ? (pane.left + pane.right) / 2
        : (pane.top + pane.bottom) / 2
      const cross = horizontal
        ? (pane.top + pane.bottom) / 2
        : (pane.left + pane.right) / 2
      const crossGap = horizontal
        ? intervalGap(current.top, current.bottom, pane.top, pane.bottom)
        : intervalGap(current.left, current.right, pane.left, pane.right)
      return {
        id: pane.id,
        score: [crossGap > 0 ? 1 : 0, Math.abs(primary - currentPrimary), crossGap, Math.abs(cross - currentCross)],
      }
    })
    .sort((left, right) => {
      for (let index = 0; index < left.score.length; index += 1) {
        const difference = left.score[index]! - right.score[index]!
        if (difference) return difference
      }
      return left.id.localeCompare(right.id)
    })[0]?.id
}

/** Grows or shrinks a pane against every split boundary that contains it. */
export function resizeWorkspacePane(
  node: WorkspaceLayoutNode,
  paneId: string,
  delta: number,
): WorkspaceLayoutNode {
  if (node.type === 'pane') return node
  const inFirst = workspacePane(node.first, paneId) !== undefined
  const inSecond = !inFirst && workspacePane(node.second, paneId) !== undefined
  if (!inFirst && !inSecond) return node
  const child = resizeWorkspacePane(inFirst ? node.first : node.second, paneId, delta)
  const ratio = Math.max(0.2, Math.min(0.8, node.ratio + (inFirst ? delta : -delta)))
  return {
    ...node,
    ratio,
    ...(inFirst ? { first: child } : { second: child }),
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function threadGitInfo(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const git = value as NonNullable<ThreadSummary['gitInfo']>
  return (git.branch === undefined || typeof git.branch === 'string')
    && (git.sha === undefined || typeof git.sha === 'string')
    && (git.originUrl === undefined || typeof git.originUrl === 'string')
}

function threadProjectRef(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const reference = value as NonNullable<ThreadSummary['projectRef']>
  return typeof reference.source === 'string' && typeof reference.id === 'string'
}

function threadRuntimeStatus(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const status = value as NonNullable<ThreadSummary['status']>
  return typeof status.type === 'string'
    && (status.activeFlags === undefined
      || (Array.isArray(status.activeFlags)
        && status.activeFlags.every((flag) => typeof flag === 'string')))
}

function threadSummary(value: unknown): value is ThreadSummary {
  if (!value || typeof value !== 'object') return false
  const thread = value as Partial<ThreadSummary>
  return typeof thread.id === 'string'
    && typeof thread.title === 'string'
    && typeof thread.preview === 'string'
    && typeof thread.cwd === 'string'
    && finiteNumber(thread.createdAt)
    && finiteNumber(thread.updatedAt)
    && (thread.recencyAt === undefined || finiteNumber(thread.recencyAt))
    && (thread.projectId === undefined || typeof thread.projectId === 'string')
    && (thread.projectRef === undefined || threadProjectRef(thread.projectRef))
    && (thread.gitInfo === undefined || threadGitInfo(thread.gitInfo))
    && (thread.modelProvider === undefined || typeof thread.modelProvider === 'string')
    && (thread.status === undefined || threadRuntimeStatus(thread.status))
    && (thread.canAcceptDirectInput === undefined
      || typeof thread.canAcceptDirectInput === 'boolean')
}

function paneLocation(value: unknown): value is WorkspacePaneLocation {
  if (!value || typeof value !== 'object') return false
  const location = value as Partial<WorkspacePaneLocation>
  return typeof location.workspace === 'string'
    && (location.projectId === undefined || typeof location.projectId === 'string')
    && (location.unscoped === undefined || typeof location.unscoped === 'boolean')
    && !(location.projectId && location.unscoped)
    && (location.thread === undefined || threadSummary(location.thread))
}

function paneNavigation(value: unknown): value is WorkspacePaneNavigation {
  if (!value || typeof value !== 'object') return false
  const navigation = value as Partial<WorkspacePaneNavigation>
  return Number.isInteger(navigation.index)
    && Array.isArray(navigation.entries)
    && navigation.entries.length > 0
    && navigation.entries.length <= WORKSPACE_PANE_HISTORY_LIMIT
    && (navigation.index as number) >= 0
    && (navigation.index as number) < navigation.entries.length
    && navigation.entries.every(paneLocation)
}

function layoutNode(value: unknown, ids: Set<string>): value is WorkspaceLayoutNode {
  if (!value || typeof value !== 'object') return false
  const node = value as Partial<WorkspaceLayoutNode>
  if (typeof node.id !== 'string' || !node.id || ids.has(node.id)) return false
  ids.add(node.id)
  if (node.type === 'pane') {
    return (node.kind === undefined || typeof node.kind === 'string')
      && typeof node.workspace === 'string'
      && (node.projectId === undefined || typeof node.projectId === 'string')
      && (node.unscoped === undefined || typeof node.unscoped === 'boolean')
      && !(node.projectId && node.unscoped)
      && (node.thread === undefined || threadSummary(node.thread))
      && (node.resource === undefined || typeof node.resource === 'string')
      && (node.navigation === undefined || paneNavigation(node.navigation))
  }
  if (node.type !== 'split') return false
  const split = node as Partial<WorkspaceSplitNode>
  return (split.direction === 'horizontal' || split.direction === 'vertical')
    && finiteNumber(split.ratio)
    && split.ratio >= 0.2
    && split.ratio <= 0.8
    && layoutNode(split.first, ids)
    && layoutNode(split.second, ids)
}

export function parseWorkspaceLayout(value: unknown): WorkspaceLayoutState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const state = value as Omit<Partial<WorkspaceLayoutState>, 'version'> & { version?: number }
  if (
    (state.version !== 1 && state.version !== 2)
    || typeof state.activeViewId !== 'string'
    || !Array.isArray(state.views)
    || !state.views.length
  ) return undefined

  const ids = new Set<string>()
  const views: WorkspaceView[] = []
  const valid = state.views.every((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false
    const view = candidate as Partial<WorkspaceView>
    if (
      typeof view.id !== 'string'
      || !view.id
      || ids.has(view.id)
      || typeof view.name !== 'string'
      || !view.name.trim()
      || typeof view.focusedPaneId !== 'string'
    ) return false
    ids.add(view.id)
    if (!layoutNode(view.root, ids)) return false
    const paneIds = workspacePaneIds(view.root)
    if (!paneIds.includes(view.focusedPaneId)) return false
    if (
      view.maximizedPaneId !== undefined
      && (typeof view.maximizedPaneId !== 'string' || !paneIds.includes(view.maximizedPaneId))
    ) return false
    const first = firstWorkspacePane(view.root)
    const workspace = typeof view.workspace === 'string' && view.workspace
      ? view.workspace
      : first.workspace
    const projectId = typeof view.projectId === 'string'
      ? view.projectId
      : first.projectId
    const unscoped = !projectId && (view.unscoped === true || first.unscoped === true)
    views.push({
      id: view.id,
      ...(typeof view.groupId === 'string' ? { groupId: view.groupId } : {}),
      name: view.name,
      ...(view.nameBinding && typeof view.nameBinding.source === 'string' && view.nameBinding.source
        && typeof view.nameBinding.id === 'string' && view.nameBinding.id ? { nameBinding: { source: view.nameBinding.source, id: view.nameBinding.id } } : {}),
      workspace,
      ...(projectId ? { projectId } : {}),
      ...(unscoped ? { unscoped: true } : {}),
      focusedPaneId: view.focusedPaneId,
      ...(view.maximizedPaneId ? { maximizedPaneId: view.maximizedPaneId } : {}),
      root: view.root,
    })
    return true
  })
  if (!valid || !state.views.some((view) => view.id === state.activeViewId)) return undefined
  const groups = parseTabGroups(state.groups)
  return normalizeTabGroups({ version: 2, activeViewId: state.activeViewId, views, ...(groups.length ? { groups } : {}) })
}
