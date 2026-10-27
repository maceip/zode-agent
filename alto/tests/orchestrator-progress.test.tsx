import { renderToStaticMarkup } from 'react-dom/server'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { activeChatSubagents, focusAfterSubagentDismiss, SubagentDots, SUBAGENT_DOT_LIMIT } from '../program/plugins/orchestrator-progress.client.js'
import { TurnProgressView, type TurnProgressSnapshot } from '../program/plugins/turn-progress.client.js'
import type { AgentTask, AgentTaskStatus } from '../program/plugins/orchestrator-api.js'

function agent(id: string, parent = 'parent', status: AgentTaskStatus = 'working', createdAt = 1): AgentTask {
  return { id, threadId: id, parentThreadId: parent, parentTitle: parent, title: id, status, createdAt, updatedAt: 1, workspace: '/repo', activity: '', result: '' }
}
const empty: TurnProgressSnapshot = { revision: 0, visible: false, phase: 'active', steps: [], completedSteps: 0, files: [], filesChanged: 0, additions: 0, deletions: 0 }

describe('subagent dots in the turn pill', () => {
  it('returns focus to the surviving trigger, or the composer in the same pane after completion', () => {
    const composer = { focus: vi.fn() }
    const scope = { querySelector: vi.fn(() => composer) }
    const trigger = { focus: vi.fn(), closest: vi.fn(() => scope) }
    focusAfterSubagentDismiss(trigger as unknown as HTMLElement, true)
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(composer.focus).not.toHaveBeenCalled()
    focusAfterSubagentDismiss(trigger as unknown as HTMLElement, false)
    expect(trigger.closest).toHaveBeenCalledWith('.workspace-chat-pane, main')
    expect(scope.querySelector).toHaveBeenCalledWith('[data-cordis-composer-editor]')
    expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(() => focusAfterSubagentDismiss(null, false)).not.toThrow()
  })
  it('shows only actively running descendants of this chat, not other chats or old history', () => {
    const tasks = [agent('other', 'other-chat'), agent('done', 'parent', 'done'), agent('stopped', 'parent', 'stopped'), agent('old-failure', 'parent', 'failed'), agent('unverified', 'parent', 'unknown'),
      agent('working'), agent('waiting', 'parent', 'waiting'), agent('starting', 'parent', 'starting'), agent('stopping', 'parent', 'stopping')]
    expect(activeChatSubagents(tasks, 'parent').map((task) => task.id)).toEqual(['starting', 'stopping', 'waiting', 'working'])
    expect(activeChatSubagents(tasks)).toEqual([])
    expect(activeChatSubagents(tasks, 'new-chat')).toEqual([])
  })
  it('includes nested workers even after the intermediate agent finishes', () => {
    const tasks = [agent('child', 'parent', 'done'), agent('grandchild', 'child'), agent('sibling', 'parent')]
    expect(activeChatSubagents(tasks, 'parent').map((task) => task.id)).toEqual(['grandchild', 'sibling'])
    expect(activeChatSubagents(tasks, 'child').map((task) => task.id)).toEqual(['grandchild'])
  })
  it('uses native ancestry for descendants outside the recent list', () => {
    expect(activeChatSubagents([{ ...agent('nested', 'missing'), ancestorThreadIds: ['missing', 'parent'] }], 'parent')).toHaveLength(1)
  })
  it('keeps dot order stable when status events reorder the server list', () => {
    const tasks = [agent('new', 'parent', 'working', 2), agent('old', 'parent', 'waiting', 1)]
    expect(activeChatSubagents(tasks, 'parent').map((task) => task.id)).toEqual(['old', 'new'])
    expect(activeChatSubagents([...tasks].reverse(), 'parent').map((task) => task.id)).toEqual(['old', 'new'])
  })
  it('caps visible dots without hiding the additional count', () => {
    const html = renderToStaticMarkup(<SubagentDots tasks={Array.from({ length: 7 }, (_, index) => agent(String(index)))} />)
    expect(SUBAGENT_DOT_LIMIT).toBe(4)
    expect(html.match(/class="turn-subagent-dot is-/g)).toHaveLength(4)
    expect(html).toContain('+3')
  })
  it('can show only the accessory before the first edit or completed step', () => {
    expect(renderToStaticMarkup(<TurnProgressView progress={empty} />)).toBe('')
    const html = renderToStaticMarkup(<TurnProgressView progress={empty} accessory={{ label: '1 active subagent', content: <button>Agent dots</button>, details: <div>Agent list</div> }} />)
    expect(html).toContain('turn-progress-pill')
    expect(html).toContain('1 active subagent')
    expect(html).toContain('Agent dots')
    expect(html).toContain('Agent list')
    expect(html).not.toContain('Completed')
    expect(html).not.toContain('turn-progress-details')
  })
  it('does not revive completed file totals when a background subagent remains active', () => {
    const progress = { ...empty, phase: 'completed' as const, filesChanged: 5, additions: 99, completedSteps: 1, steps: [{ step: 'Old work', status: 'completed' as const }] }
    const html = renderToStaticMarkup(<TurnProgressView progress={progress} accessory={{ label: '1 active subagent', content: <button>Agent dots</button> }} />)
    expect(html).toContain('Agent dots')
    expect(html).not.toContain('files changed')
    expect(html).not.toContain('Old work')
    expect(html).not.toContain('Completed')
  })
  it('keeps the existing plan and file summary alongside the accessory', () => {
    const progress = { ...empty, visible: true, filesChanged: 2, additions: 15, deletions: 3 }
    const html = renderToStaticMarkup(<TurnProgressView progress={progress} accessory={{ label: '2 active subagents', content: <SubagentDots tasks={[agent('a'), agent('b')]} /> }} />)
    expect(html).toContain('files changed')
    expect(html).toContain('turn-progress-additions')
    expect(html).toContain('turn-subagents-dots')
  })
  it('uses one optional accessory registration in the single and split pane renderers', async () => {
    const [core, split, plugin, css] = await Promise.all(['turn-progress.client.tsx', 'workspace-turn-progress.client.tsx', 'orchestrator.client.tsx', 'orchestrator-progress.css'].map((file) => readFile(new URL('../program/plugins/' + file, import.meta.url), 'utf8')))
    expect(core).toContain('ui.component<TurnProgressAccessoryProps>(TURN_PROGRESS_ACCESSORY)')
    expect(split).toContain('<ConnectedTurnProgress')
    expect(plugin).toContain('registerComponent<TurnProgressAccessoryProps>')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('turn-subagents-trigger:is(:hover, :focus-visible, [aria-expanded="true"])')
    const mini = await readFile(new URL('../program/plugins/orchestrator-progress.client.tsx', import.meta.url), 'utf8')
    expect(mini).toContain('<SubagentDots tasks={active} />')
    expect(mini).not.toContain('<SubagentDots tasks={displayed} />')
  })
})
