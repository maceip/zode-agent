import type { BrowserPlugin, ClientHostService } from '../../src/client/plugin-api.js'
import type { ChatAttachment } from '../../src/shared/protocol.js'
import type { ClientAttachmentProvider } from './composer-api.js'
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  FILE_ATTACHMENT_STORE_METHOD,
  parseStoredAttachment,
} from './file-attachments-api.js'

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`Could not read ${file.name}`))
        return
      }
      const comma = reader.result.indexOf(',')
      if (comma < 0) reject(new Error(`Could not encode ${file.name}`))
      else resolve(reader.result.slice(comma + 1))
    })
    reader.addEventListener('error', () => reject(reader.error ?? new Error(`Could not read ${file.name}`)))
    reader.readAsDataURL(file)
  })
}

class AltoFileAttachmentProvider implements ClientAttachmentProvider {
  readonly id = 'file-attachments'

  constructor(
    private readonly host: ClientHostService,
    private readonly maxBytes: number,
  ) {}

  accepts(): boolean {
    return true
  }

  async upload(file: File): Promise<ChatAttachment> {
    if (file.size > this.maxBytes) {
      throw new Error(`Files are limited to ${Math.floor(this.maxBytes / 1024 / 1024)} MB`)
    }
    return parseStoredAttachment(await this.host.call(FILE_ATTACHMENT_STORE_METHOD, {
      name: file.name || 'attachment',
      mediaType: file.type || 'application/octet-stream',
      data: await base64(file),
    }))
  }
}

const fileAttachmentsClient: BrowserPlugin<{ maxBytes?: number }> = (ctx, config) => {
  const configuredMax = config?.maxBytes
  const maxBytes = typeof configuredMax === 'number' && Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : DEFAULT_MAX_ATTACHMENT_BYTES
  ctx.clientComposer.registerAttachmentProvider(
    ctx,
    new AltoFileAttachmentProvider(ctx.clientHost, maxBytes),
  )
}

fileAttachmentsClient.inject = ['clientHost', 'clientComposer']

export default fileAttachmentsClient
