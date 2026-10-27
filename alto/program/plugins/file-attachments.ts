import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import {
  isRecord,
  type ChatAttachment,
  type JsonValue,
  type TurnInput,
} from '../../src/shared/protocol.js'
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  FILE_ATTACHMENT_STORE_METHOD,
  type FileAttachmentUpload,
} from './file-attachments-api.js'

function safeFilename(value: string): string {
  const basename = path.basename(value.replaceAll('\\', '/')).normalize('NFC')
  const cleaned = [...basename]
    .filter((character) => character >= ' ' && character !== '\u007f')
    .join('')
    .slice(0, 180)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'attachment'
}

function uploadFrom(value: JsonValue | undefined): FileAttachmentUpload {
  if (
    !isRecord(value)
    || typeof value.name !== 'string'
    || typeof value.mediaType !== 'string'
    || typeof value.data !== 'string'
  ) throw new Error('file-attachments.store needs a name, media type, and base64 data')
  return {
    name: value.name,
    mediaType: value.mediaType || 'application/octet-stream',
    data: value.data,
  }
}

function decodedBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('The attachment payload is not valid base64')
  }
  return Buffer.from(value, 'base64')
}

export async function storeFileAttachment(
  root: string,
  upload: FileAttachmentUpload,
  maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
): Promise<ChatAttachment> {
  const bytes = decodedBase64(upload.data)
  if (bytes.length > maxBytes) {
    throw new Error(`Files are limited to ${Math.floor(maxBytes / 1024 / 1024)} MB`)
  }

  const name = safeFilename(upload.name)
  const directory = path.join(root, randomUUID())
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const filePath = path.join(directory, name)
  await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 })
  return {
    name,
    path: filePath,
    mediaType: upload.mediaType || 'application/octet-stream',
    size: bytes.length,
  }
}

function asJson(attachment: ChatAttachment): JsonValue {
  return attachment as unknown as JsonValue
}

export function attachedFileContext(input: readonly TurnInput[]): string | undefined {
  const attachments = input.flatMap((part) => (
    part.type === 'mention' ? [{ name: part.name, path: part.path }] : []
  ))
  if (!attachments.length) return undefined

  return [
    'The user attached local files to this turn. When they refer to an attached file, use these exact staged paths:',
    ...attachments.map(({ name, path: filePath }) => (
      '- ' + JSON.stringify(name) + ': ' + JSON.stringify(filePath)
    )),
  ].join('\n')
}

const fileAttachments: HarnessPlugin<{ maxBytes?: number }> = (ctx, config) => {
  const configuredMax = config?.maxBytes
  const maxBytes = typeof configuredMax === 'number' && Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : DEFAULT_MAX_ATTACHMENT_BYTES
  const root = path.join(homedir(), '.codex', 'attachments', 'alto')

  ctx.on('codex/turn/prepare', async (_draft, next) => {
    const prepared = await next()
    const context = attachedFileContext(prepared.input)
    if (!context) return prepared

    return {
      ...prepared,
      additionalContext: {
        ...prepared.additionalContext,
        alto_file_attachments: {
          kind: 'untrusted',
          value: context,
        },
      },
    }
  })

  ctx.clientExtensions.registerMethod(ctx, FILE_ATTACHMENT_STORE_METHOD, async (payload) => (
    asJson(await storeFileAttachment(root, uploadFrom(payload), maxBytes))
  ))
}

fileAttachments.inject = ['clientExtensions']

export default fileAttachments
