import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { clientStyles } from '../../../src/client/plugin-api.js'
import { asyncQuestionReply, asyncQuestionValues } from './async-question-model.js'
export { asyncQuestionReply } from './async-question-model.js'
import { isRecord } from '../../../src/shared/protocol.js'
import type { ClientSessionService } from '../session-api.js'
import type { ActivityItem } from './transcript.js'
import { UserInputRequest } from './user-input.js'

const STORAGE_KEY = 'alto.answered-agent-questions'
const RETENTION = 200

interface SavedAnswer { key: string; answers?: string[] }

function answeredQuestions(): SavedAnswer[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(saved) ? saved.flatMap((entry): SavedAnswer[] => {
      if (typeof entry === 'string') return [{ key: entry }]
      if (!isRecord(entry) || typeof entry.key !== 'string' || !Array.isArray(entry.answers)
        || !entry.answers.every((answer) => typeof answer === 'string')) return []
      return [{ key: entry.key, answers: entry.answers as string[] }]
    }).slice(-RETENTION) : []
  } catch { return [] }
}

function rememberAnswer(key: string, answers: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
      ...answeredQuestions().filter((entry) => entry.key !== key), { key, answers },
    ].slice(-RETENTION)))
  } catch { /* The current card and transcript still retain the submitted answer. */ }
}

export function AnsweredQuestion({ item, answers }: { item: ActivityItem; answers?: string[] | undefined }): ReactNode {
  return <section className={clientStyles.floatingPanel + ' input-request input-question-answered'} aria-label="Answered agent questions">
    <div className="input-request-heading">Answered</div>
    {item.questions?.map((question, index) => <div className="input-question" key={index}>
      <div className="input-question-title">{question.title}</div>
      {answers?.[index] && <div className="input-question-answer">
        <Check size={14} aria-hidden="true" />
        <span>{answers[index]}</span>
      </div>}
    </div>)}
  </section>
}

export async function replyToAsyncQuestion(session: ClientSessionService, threadId: string | undefined, text: string): Promise<void> {
  const state = session.snapshot()
  if (!threadId || state.threadId !== threadId || !state.connected || state.canAcceptDirectInput === false) {
    throw new Error('The original chat is not available')
  }
  if (state.turn.tag === 'sending') throw new Error('The chat is changing turns')
  const draft = { text, images: [], attachments: [], skills: [] }
  // request_user_input_async has already returned to the agent. Its answer is
  // ordinary user input: steer an active turn, or send to this chat if idle.
  if (state.turn.tag === 'idle') await session.send(draft)
  else await session.steer(draft)
}

export function AsyncQuestionRequest({ item, session }: { item: ActivityItem; session: ClientSessionService }): ReactNode {
  const [threadId] = useState(() => item.threadId ?? session.snapshot().threadId)
  const isWorking = (): boolean => session.snapshot().turn.tag !== 'idle'
  const working = useSyncExternalStore(session.subscribe, isWorking, isWorking)
  const key = (threadId ?? '') + ':' + item.id
  const [saved, setSaved] = useState(() => answeredQuestions().find((entry) => entry.key === key))
  const answers = item.questionAnswers ?? saved?.answers
  if (answers || saved) return <AnsweredQuestion item={item} answers={answers} />
  return <UserInputRequest
    request={{
      id: item.id, method: 'agentMessage/async', receivedAt: '',
      params: { isBlocking: false, questions: (item.questions ?? []).map((question, index) => ({
        id: String(index), question: question.title, isOther: true,
        options: question.options?.map((label) => ({ label })),
      })) },
    }}
    heading={working ? 'Question · agent is still working' : 'A question for you'}
    submitLabel="Send answer"
    resolve={async (_id, result) => {
      await replyToAsyncQuestion(session, threadId, asyncQuestionReply(item, result))
      const answers = asyncQuestionValues(item, result)
      rememberAnswer(key, answers)
      setSaved({ key, answers })
    }}
  />
}
