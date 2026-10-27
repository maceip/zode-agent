import type { ActivityItem } from './ui/transcript.js'

type PreviewMessage = Pick<ActivityItem, 'kind' | 'content' | 'images' | 'attachments' | 'questions'>

/** Activities are chronological; tools and reasoning are not chat messages. */
export function latestSearchPreview(messages: readonly PreviewMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.kind !== 'user' && message.kind !== 'agent') continue
    const text = (message.content || message.questions?.map((question) => question.title).join(' ') || '')
      .replace(/\s+/g, ' ').trim()
    const preview = text || (message.images?.length ? 'Image' : message.attachments?.length ? 'Attachment' : '')
    if (preview) return preview.length > 240 ? `${preview.slice(0, 239)}…` : preview
  }
  return ''
}
