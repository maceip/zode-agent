import { describe, expect, it } from 'vitest'
import type { ThreadSummary } from '../src/shared/protocol.js'
import {
  cachedThreadIsFresh,
  ThreadActivityCache,
} from '../program/plugins/thread-cache.js'

function thread(id: string, updatedAt: number): ThreadSummary {
  return {
    id,
    title: id,
    preview: '',
    cwd: '/tmp/project',
    createdAt: 1,
    updatedAt,
  }
}

describe('thread activity cache', () => {
  it('reports freshness from the thread summary version', () => {
    const cached = { summary: thread('a', 5), activities: [], resumed: true }
    expect(cachedThreadIsFresh(cached, thread('a', 5))).toBe(true)
    expect(cachedThreadIsFresh(cached, thread('a', 6))).toBe(false)
  })

  it('evicts the least recently used thread', () => {
    const cache = new ThreadActivityCache(2)
    cache.put({ summary: thread('a', 1), activities: [], resumed: true })
    cache.put({ summary: thread('b', 1), activities: [], resumed: true })
    expect(cache.get('a')?.summary.id).toBe('a')
    cache.put({ summary: thread('c', 1), activities: [], resumed: true })
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')?.summary.id).toBe('a')
    expect(cache.get('c')?.summary.id).toBe('c')
  })
})
