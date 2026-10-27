import { describe, expect, it } from 'vitest'
import { unseenCompletedTaskCount } from '../program/plugins/scheduled.client.js'
import type { ScheduledTask } from '../program/plugins/scheduled-api.js'

function task(id: string, status: 'running' | 'succeeded' | 'failed', finishedAt?: string): ScheduledTask {
  return {
    id,
    name: id,
    prompt: 'Do work',
    target: 'local',
    cron: '0 9 * * *',
    timezone: 'UTC',
    permissionMode: 'auto',
    enabled: true,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    lastRun: {
      status,
      startedAt: '2026-08-27T16:00:00.000Z',
      ...(finishedAt ? { finishedAt } : {}),
    },
  }
}

describe('scheduled completion notices', () => {
  it('counts only terminal runs that have not been seen', () => {
    const tasks = [
      task('new-success', 'succeeded', '2026-08-27T16:01:00.000Z'),
      task('seen-failure', 'failed', '2026-08-27T16:02:00.000Z'),
      task('still-running', 'running'),
    ]

    expect(unseenCompletedTaskCount(tasks, {
      'seen-failure': '2026-08-27T16:02:00.000Z',
    })).toBe(1)
  })
})
