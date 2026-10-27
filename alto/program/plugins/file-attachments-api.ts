import type { ChatAttachment, JsonValue } from '../../src/shared/protocol.js'
import { isRecord } from '../../src/shared/protocol.js'

export const FILE_ATTACHMENT_STORE_METHOD = 'file-attachments.store'
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface FileAttachmentUpload {
  name: string
  mediaType: string
  data: string
}

export function parseStoredAttachment(value: JsonValue): ChatAttachment {
  if (
    !isRecord(value)
    || typeof value.name !== 'string'
    || typeof value.path !== 'string'
    || typeof value.mediaType !== 'string'
    || typeof value.size !== 'number'
  ) throw new Error('Alto returned an invalid file attachment')
  return {
    name: value.name,
    path: value.path,
    mediaType: value.mediaType,
    size: value.size,
  }
}
