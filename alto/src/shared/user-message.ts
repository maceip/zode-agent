import type { ChatAttachment, ThreadMessage, ThreadTextElement, TurnInput } from './protocol.js'
import { isRecord } from './protocol.js'

function textElements(value: unknown): ThreadTextElement[] | undefined {
  if (!Array.isArray(value)) return undefined
  const elements = value.flatMap((element) => {
    if (!isRecord(element) || !isRecord(element.byteRange)) return []
    const start = element.byteRange.start
    const end = element.byteRange.end
    if (
      typeof start !== 'number'
      || typeof end !== 'number'
      || !Number.isFinite(start)
      || !Number.isFinite(end)
    ) return []
    return [{
      byteRange: { start, end },
      ...(typeof element.placeholder === 'string' ? { placeholder: element.placeholder } : {}),
    }]
  })
  return elements.length ? elements : undefined
}

function inputPart(part: unknown): TurnInput | undefined {
  if (!isRecord(part) || typeof part.type !== 'string') return undefined
  if (part.type === 'text' && typeof part.text === 'string') {
    const elements = textElements(part.text_elements)
    return {
      type: 'text',
      text: part.text,
      ...(elements ? { text_elements: elements } : {}),
    }
  }
  if (part.type === 'image' && typeof part.url === 'string') {
    return {
      type: 'image',
      url: part.url,
      ...(typeof part.detail === 'string' ? { detail: part.detail } : {}),
    }
  }
  if (part.type === 'localImage' && typeof part.path === 'string') {
    return {
      type: 'localImage',
      path: part.path,
      ...(typeof part.detail === 'string' ? { detail: part.detail } : {}),
    }
  }
  if (part.type === 'audio' && typeof part.url === 'string') {
    return { type: 'audio', url: part.url }
  }
  if (part.type === 'localAudio' && typeof part.path === 'string') {
    return { type: 'localAudio', path: part.path }
  }
  if (
    (part.type === 'skill' || part.type === 'mention')
    && typeof part.name === 'string'
    && typeof part.path === 'string'
  ) {
    return { type: part.type, name: part.name, path: part.path }
  }
  return undefined
}

function pathName(value: string, fallback: string): string {
  return value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? fallback
}

export function readUserMessage(item: unknown): Pick<ThreadMessage, 'text' | 'input' | 'images' | 'attachments'> | undefined {
  if (!isRecord(item) || item.type !== 'userMessage' || !Array.isArray(item.content)) return undefined

  const input = item.content.flatMap((part) => {
    const parsed = inputPart(part)
    return parsed ? [parsed] : []
  })
  const content = input.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').trim()
  const images = input.flatMap((part) => {
    if (part.type !== 'image') return []
    const mediaType = /^data:([^;,]+)/.exec(part.url)?.[1] ?? 'image/*'
    return [{ name: 'Image', mediaType, url: part.url }]
  })
  const attachments: ChatAttachment[] = input.flatMap((part) => {
    if (part.type === 'mention') return [{ name: part.name, path: part.path }]
    if (part.type === 'localImage') {
      return [{ name: pathName(part.path, 'Image'), path: part.path, mediaType: 'image/*' }]
    }
    if (part.type === 'localAudio') {
      return [{ name: pathName(part.path, 'Audio'), path: part.path, mediaType: 'audio/*' }]
    }
    if (part.type === 'audio') {
      return [{ name: 'Audio', path: part.url, mediaType: 'audio/*' }]
    }
    return []
  })
  return content || input.length
    ? {
        text: content,
        ...(images.length ? { images } : {}),
        ...(attachments.length ? { attachments } : {}),
        input,
      }
    : undefined
}
