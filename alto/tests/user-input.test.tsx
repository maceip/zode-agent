import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApprovalRequest } from '../program/plugins/ui/inspectors.js'
import { inputQuestions } from '../program/plugins/ui/user-input.js'

describe('agent question picker', () => {
  it('reads the native question schema without losing descriptions or flags', () => {
    expect(inputQuestions({ questions: [{
      id: 'scope', header: 'Scope', question: 'Which files?', isOther: true,
      options: [{ label: 'This workspace', description: 'Only files in the current project.' }],
    }, { id: 'token', header: 'Token', question: 'Access token?', isSecret: true, options: null }] })).toEqual([
      { id: 'scope', header: 'Scope', question: 'Which files?', isOther: true, isSecret: false,
        options: [{ label: 'This workspace', description: 'Only files in the current project.' }] },
      { id: 'token', header: 'Token', question: 'Access token?', isOther: false, isSecret: true, options: [] },
    ])
  })

  it('ignores malformed questions and options instead of showing object strings', () => {
    expect(inputQuestions({ questions: [null, {}, { question: 'Missing ID' }] })).toEqual([])
    expect(inputQuestions({ questions: [{ id: 'one', question: 'Choose', options: [null, {}, { label: '' }] }] })[0]?.options).toEqual([])
    expect(inputQuestions({})).toEqual([])
  })

  it('routes native questions to the picker without changing permission approvals', () => {
    const render = (method: string, params: Record<string, unknown>) => renderToStaticMarkup(
      <ApprovalRequest request={{ id: 42, method, params, receivedAt: '2026-09-09T00:00:00Z' }} resolve={async () => {}} />,
    )
    const html = render('item/tool/requestUserInput', { questions: [{
      id: 'scope', question: 'Which files?', options: [{ label: 'Workspace', description: 'Project files only' }],
    }] })
    expect(html).toContain('type="radio"')
    expect(html).toContain('Project files only')
    expect(html).toContain('Continue')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('checked=""')
    expect(html).not.toContain('autofocus')
    expect(html).not.toContain('Something else')
    const approval = render('item/commandExecution/requestApproval', { command: 'pwd' })
    expect(approval).toContain('Accept once')
    expect(approval).toContain('Decline')
    expect(approval).not.toContain('input-request')
  })
})
