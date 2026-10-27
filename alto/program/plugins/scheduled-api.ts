import type { Context } from 'cordis'
import type { JsonValue } from '../../src/shared/protocol.js'

export type ScheduledTarget = string

export type ScheduledRunStatus = 'running' | 'succeeded' | 'failed'

export interface ScheduledLastRun {
  status: ScheduledRunStatus
  startedAt: string
  finishedAt?: string
  message?: string
  threadId?: string
  externalId?: string
  url?: string
}

/** Fields that are safe to send to the browser. */
export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  target: ScheduledTarget
  targetLabel?: string
  sourceCheckoutId?: string
  projectId?: string
  workspace?: string
  branch?: string
  repository?: string
  cron: string
  timezone: string
  permissionMode: 'auto' | 'full'
  enabled: boolean
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  lastRun?: ScheduledLastRun
}

/** Server-only record passed to target providers and persisted on disk. */
export interface ScheduledProviderTask extends ScheduledTask {
  providerState?: JsonValue
  legacyState?: JsonValue
}

export interface ScheduledTargetDescriptor {
  id: ScheduledTarget
  label: string
  description: string
  icon: 'computer' | 'cloud'
  supportsCustomCron: boolean
  supportsPermissionMode: boolean
  supportsImport?: boolean
  timezoneMode: 'local' | 'utc' | 'fixed-offset'
  requiredWorkProvider?: string
  available?: boolean
  canManageExisting?: boolean
  documentation?: {
    label: string
    url: string
  }
}

export const LOCAL_SCHEDULED_TARGET: ScheduledTargetDescriptor = {
  id: 'local',
  label: 'This Mac',
  description: 'Local tasks create a new Alto chat when they run. Alto must be open at the scheduled time.',
  icon: 'computer',
  supportsCustomCron: true,
  supportsPermissionMode: true,
  timezoneMode: 'local',
  available: true,
}

export interface ScheduledTargetRunResult {
  status?: ScheduledRunStatus
  message?: string
}

export interface ScheduledTargetRefreshResult {
  lastRun?: ScheduledLastRun
  providerState?: JsonValue
}

export interface ScheduledTargetImportResult {
  content: string
  sourceLabel?: string
  url?: string
}

export interface ScheduledTargetProvider {
  descriptor: Omit<ScheduledTargetDescriptor, 'available' | 'canManageExisting'>
  normalize?(task: ScheduledProviderTask): ScheduledProviderTask | Promise<ScheduledProviderTask>
  prepare(
    task: ScheduledProviderTask,
    previous?: ScheduledProviderTask,
  ): JsonValue | Promise<JsonValue>
  create(task: ScheduledProviderTask): void | Promise<void>
  update(task: ScheduledProviderTask): void | Promise<void>
  remove(task: ScheduledProviderTask): void | Promise<void>
  setEnabled(task: ScheduledProviderTask, enabled: boolean): void | Promise<void>
  run(task: ScheduledProviderTask): ScheduledTargetRunResult | void | Promise<ScheduledTargetRunResult | void>
  refresh?(task: ScheduledProviderTask): ScheduledTargetRefreshResult | void | Promise<ScheduledTargetRefreshResult | void>
  importResult?(task: ScheduledProviderTask): ScheduledTargetImportResult | Promise<ScheduledTargetImportResult>
}

export interface ScheduledTargetRegistration {
  dispose(): Promise<void>
}

export interface ScheduledTaskService {
  registerTarget(
    owner: Context,
    provider: ScheduledTargetProvider,
  ): Promise<ScheduledTargetRegistration>
}

export interface ScheduledSnapshot {
  version: 1
  revision: number
  tasks: ScheduledTask[]
  targets: ScheduledTargetDescriptor[]
  updatedAt: string
}

declare module 'cordis' {
  interface Context {
    scheduled: ScheduledTaskService
  }
}

export const SCHEDULED_STATE = 'scheduled.state'
export const SCHEDULED_SAVE = 'scheduled.save'
export const SCHEDULED_REMOVE = 'scheduled.remove'
export const SCHEDULED_TOGGLE = 'scheduled.toggle'
export const SCHEDULED_RUN = 'scheduled.run'
export const SCHEDULED_REFRESH = 'scheduled.refresh'
export const SCHEDULED_IMPORT = 'scheduled.import'
