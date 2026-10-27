import {
  Check,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { PendingServerRequest, ProgramProposal } from '../../../src/shared/protocol.js'
import { isRecord } from '../../../src/shared/protocol.js'
import { pretty } from './values.js'
import { AgentInputRequest } from './agent-input.js'
import { UserInputRequest } from './user-input.js'

function requestTitle(method: string): string {
  if (method.includes('commandExecution')) return 'Run this command?'
  if (method.includes('fileChange')) return 'Apply these file changes?'
  if (method.includes('permissions')) return 'Grant additional permissions?'
  if (method.includes('requestUserInput')) return 'Codex needs your input'
  return method
}

export function ApprovalRequest(props: {
  request: PendingServerRequest
  resolve: (id: string | number, result: unknown) => Promise<void>
}): ReactNode {
  if (props.request.method === 'agent/requestUserInput') return <AgentInputRequest {...props} key={String(props.request.id)} />
  return props.request.method === 'item/tool/requestUserInput'
    ? <UserInputRequest {...props} key={typeof props.request.id + ':' + props.request.id} />
    : <ServerApprovalRequest {...props} />
}

function ServerApprovalRequest({
  request,
  resolve,
}: {
  request: PendingServerRequest
  resolve: (id: string | number, result: unknown) => Promise<void>
}): ReactNode {
  const [responseText, setResponseText] = useState('{}')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const questions = Array.isArray(request.params.questions)
    ? request.params.questions.filter(isRecord)
    : []
  const simpleApproval = request.method.includes('commandExecution/requestApproval')
    || request.method.includes('fileChange/requestApproval')
  const agentApproval = request.method === 'agent/requestApproval'
  const agentOptions = agentApproval && Array.isArray(request.params.options) ? request.params.options.filter(isRecord) : []

  const submit = async (result: unknown): Promise<void> => {
    setSubmitting(true)
    try {
      await resolve(request.id, result)
    } finally {
      setSubmitting(false)
    }
  }

  const submitAnswers = (): void => {
    const payload = Object.fromEntries(questions.flatMap((question) => (
      typeof question.id === 'string'
        ? [[question.id, { answers: [answers[question.id] ?? ''] }]]
        : []
    )))
    void submit({ answers: payload })
  }

  return (
    <article className="approval-card">
      <div className="approval-mark"><ShieldCheck size={18} /></div>
      <div className="approval-body">
        <h3>{agentApproval ? String(request.params.title ?? 'Allow this action?') : requestTitle(request.method)}</h3>
        {questions.length > 0 ? (
          <div className="question-list">
            {questions.map((question, index) => {
              const id = typeof question.id === 'string' ? question.id : String(index)
              const options = Array.isArray(question.options) ? question.options.filter(isRecord) : []
              return (
                <label className="question" key={id}>
                  <span>{String(question.question ?? question.header ?? 'Question')}</span>
                  {options.length ? (
                    <select value={answers[id] ?? ''} onChange={(event) => {
                      setAnswers((current) => ({ ...current, [id]: event.target.value }))
                    }}>
                      <option value="">Choose…</option>
                      {options.map((option, optionIndex) => (
                        <option key={optionIndex} value={String(option.label ?? '')}>
                          {String(option.label ?? '')}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={question.isSecret ? 'password' : 'text'}
                      value={answers[id] ?? ''}
                      onChange={(event) => {
                        setAnswers((current) => ({ ...current, [id]: event.target.value }))
                      }}
                    />
                  )}
                </label>
              )
            })}
          </div>
        ) : !agentApproval ? (
          <details>
            <summary>Request details</summary>
            <pre>{pretty(request.params)}</pre>
          </details>
        ) : null}
        {agentApproval ? (
          <div className="approval-actions">
            {agentOptions.map((option) => <button key={String(option.id)}
              className={`button ${String(option.kind).startsWith('allow') ? 'primary' : 'ghost'}`}
              disabled={submitting} onClick={() => void submit({ optionId: option.id })}>
              {String(option.label)}
            </button>)}
          </div>
        ) : simpleApproval ? (
          <div className="approval-actions">
            <button className="button ghost danger" disabled={submitting} onClick={() => void submit({ decision: 'decline' })}>
              <X size={15} /> Decline
            </button>
            <button className="button ghost" disabled={submitting} onClick={() => void submit({ decision: 'acceptForSession' })}>
              Accept for session
            </button>
            <button className="button primary" disabled={submitting} onClick={() => void submit({ decision: 'accept' })}>
              <Check size={15} /> Accept once
            </button>
          </div>
        ) : questions.length ? (
          <div className="approval-actions">
            <button className="button primary" disabled={submitting} onClick={submitAnswers}>Submit answers</button>
          </div>
        ) : (
          <div className="generic-response">
            <textarea value={responseText} onChange={(event) => setResponseText(event.target.value)} />
            <button className="button primary" disabled={submitting} onClick={() => {
              try {
                void submit(JSON.parse(responseText))
              } catch {
                setResponseText('{\n  "error": "Response must be valid JSON"\n}')
              }
            }}>Send JSON response</button>
          </div>
        )}
      </div>
    </article>
  )
}

export function ProgramProposalRequest({
  proposal,
  resolve,
}: {
  proposal: ProgramProposal
  resolve: (id: string, decision: 'accept' | 'decline') => Promise<void>
}): ReactNode {
  const [submitting, setSubmitting] = useState(false)
  const submit = async (decision: 'accept' | 'decline'): Promise<void> => {
    setSubmitting(true)
    try {
      await resolve(proposal.id, decision)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <article className="approval-card">
      <div className="approval-mark"><ShieldCheck size={18} /></div>
      <div className="approval-body">
        <h3>{proposal.summary}</h3>
        <details>
          <summary>Review {proposal.files.length} replacement file{proposal.files.length === 1 ? '' : 's'}</summary>
          <pre>{proposal.files.map((file) => `// ${file.path}\n${file.content}`).join('\n\n')}</pre>
        </details>
        <div className="approval-actions">
          <button className="button ghost danger" disabled={submitting} onClick={() => void submit('decline')}>
            Decline
          </button>
          <button className="button primary" disabled={submitting} onClick={() => void submit('accept')}>
            Apply
          </button>
        </div>
      </div>
    </article>
  )
}
