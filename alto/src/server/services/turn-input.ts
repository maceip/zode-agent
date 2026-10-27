import type {
  ChatAttachment,
  ChatImage,
  SkillOption,
  TurnInput,
} from '../../shared/protocol.js'

export interface SubmittedTurn {
  text: string
  images?: ChatImage[]
  attachments?: ChatAttachment[]
  skills?: SkillOption[]
}

export function turnInputsFor(turn: SubmittedTurn): TurnInput[] {
  const text = turn.text.trim()
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...(turn.skills ?? []).map(({ name, path }) => ({
      type: 'skill' as const,
      name,
      path,
    })),
    ...(turn.images ?? []).map(({ url }) => ({
      type: 'image' as const,
      url,
    })),
    ...(turn.attachments ?? []).map(({ name, path }) => ({
      type: 'mention' as const,
      name,
      path,
    })),
  ]
}
