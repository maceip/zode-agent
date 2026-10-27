import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { taskActive, tasksForChat, type AgentTask, type AgentTaskStatus } from '../program/plugins/orchestrator-api.js'
import { AgentTaskList } from '../program/plugins/orchestrator.client.js'

function task(id: string, status: AgentTaskStatus, parent = 'parent'): AgentTask {
  return {
    id, status, parentThreadId: parent, parentTitle: parent,
    title: id, workspace: '/repo', threadId: 'child-' + id,
    activity: '', result: 'Result for ' + id, createdAt: 0, updatedAt: 1,
  }
}
const render = (tasks: AgentTask[]) => renderToStaticMarkup(createElement(AgentTaskList, { tasks, onOpen: () => {}, onStop: () => {} }))

describe('current agents', () => {
  it('counts only confirmed activity, including agents waiting for input', () => {
    const statuses: AgentTaskStatus[] = ['starting', 'working', 'waiting', 'stopping', 'unknown', 'failed', 'done', 'stopped']
    expect(statuses.map((status) => task(status, status)).filter(taskActive).map((item) => item.status))
      .toEqual(['starting', 'working', 'waiting', 'stopping'])
  })

  it('does not turn 88 unknown historical agents into an active count or visible rows', () => {
    const saved = Array.from({ length: 88 }, (_, i) => task('old-' + i, 'unknown'))
    saved.push(task('finished', 'done'), task('failure', 'failed'), task('stopped', 'stopped'))
    const original = structuredClone(saved)
    expect(saved.filter(taskActive)).toHaveLength(0)
    expect(render(saved)).toBe('')
    expect(saved).toEqual(original)

    const tasks = [...saved, task('current', 'working')]
    const html = render(tasks)
    expect(tasks.filter(taskActive)).toHaveLength(1)
    expect(html.match(/class="agent-task"/g)).toHaveLength(1)
    expect(html).toContain('Result for current')
    expect(html).toContain('View history')
    expect(html).not.toContain('Result for old-')
    expect(html).not.toContain('agents-history')
  })

  it('keeps active descendants when their intermediate parent is historical', () => {
    const tasks = [task('finished', 'done'), task('nested', 'working', 'child-finished'), task('other', 'working', 'other-chat')]
    const html = render(tasksForChat(tasks, 'parent'))
    expect(html).toContain('Result for nested')
    expect(html).not.toContain('Result for finished')
    expect(html).not.toContain('Result for other')
  })
})
