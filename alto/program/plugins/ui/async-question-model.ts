import { isRecord, type AsyncUserInputQuestion } from '../../../src/shared/protocol.js'
import type { ActivityItem } from './transcript.js'

export function asyncQuestionValues(item: ActivityItem, result: unknown): string[] {
  const answers = isRecord(result) && isRecord(result.answers) ? result.answers : {}
  return (item.questions ?? []).map((_question, index) => {
    const answer = answers[String(index)]
    const values = isRecord(answer) && Array.isArray(answer.answers) ? answer.answers : []
    return values.filter((value): value is string => typeof value === 'string').join('\n')
  })
}

export function asyncQuestionReply(item: ActivityItem, result: unknown): string {
  const answers = asyncQuestionValues(item, result)
  return (item.questions ?? []).map((question, index) => question.title + '\n' + answers[index]).join('\n\n')
}

export function answersFromQuestionReply(questions: readonly AsyncUserInputQuestion[], text: string): string[] | undefined {
  const answers: string[] = []
  let remaining = text
  for (let index = 0; index < questions.length; index += 1) {
    const prefix = questions[index]!.title + '\n'
    if (!remaining.startsWith(prefix)) return undefined
    remaining = remaining.slice(prefix.length)
    const next = questions[index + 1]
    const end = next ? remaining.indexOf('\n\n' + next.title + '\n') : remaining.length
    if (end < 0) return undefined
    const answer = remaining.slice(0, end)
    if (!answer.trim()) return undefined
    answers.push(answer)
    remaining = remaining.slice(end + (next ? 2 : 0))
  }
  return answers.length ? answers : undefined
}

const answeredItems = new WeakMap<ActivityItem, { reply: ActivityItem; item: ActivityItem }>()

// The reply is ordinary user input in the saved transcript. Read that exact
// question/answer format so history works after reloads and on other devices,
// without depending on the live item's ID or browser storage.
export function withAsyncQuestionAnswers(items: ActivityItem[]): ActivityItem[] {
  const pending: { item: ActivityItem; index: number }[] = []
  let result = items
  for (const [index, item] of items.entries()) {
    if (item.kind === 'agent' && item.delivery === 'async' && item.questions?.length) pending.push({ item, index })
    if (item.kind !== 'user') continue
    for (let cursor = pending.length - 1; cursor >= 0; cursor -= 1) {
      const question = pending[cursor]!
      if (question.item.threadId && item.threadId && question.item.threadId !== item.threadId) continue
      const answers = answersFromQuestionReply(question.item.questions!, item.content)
      if (!answers) continue
      const cached = answeredItems.get(question.item)
      const answered = cached?.reply === item
        ? cached.item
        : { ...question.item, questionAnswers: answers }
      answeredItems.set(question.item, { reply: item, item: answered })
      if (result === items) result = [...items]
      result[question.index] = answered
      pending.splice(cursor, 1)
      break
    }
  }
  return result
}
