import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import {
  SOURCE_VIEWER_READ_METHOD,
  type SourceDocument,
} from './source-viewer-api.js'
import { resolveReadableFile } from './workspace-files.js'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

export async function readSourceDocument(
  filePath: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<SourceDocument> {
  const resolved = await resolveReadableFile(filePath)
  const metadata = await stat(resolved)
  if (!metadata.isFile()) throw new Error('That source path is not a file')
  if (metadata.size > maxBytes) {
    throw new Error(`Source preview is limited to ${Math.floor(maxBytes / 1024 / 1024)} MB`)
  }

  const bytes = await readFile(resolved)
  if (bytes.includes(0)) throw new Error('That file is binary and cannot be shown as source')
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('That file is not valid UTF-8 text')
  }
  return {
    path: resolved,
    name: path.basename(resolved),
    source,
    revision: createHash('sha256').update(bytes).digest('hex'),
    modifiedAt: Math.floor(metadata.mtimeMs),
    lineCount: source ? source.split('\n').length : 1,
  }
}

const sourceViewer: HarnessPlugin<{ maxBytes?: number }> = (ctx, config) => {
  const configuredMax = config?.maxBytes
  const maxBytes = typeof configuredMax === 'number' && Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : DEFAULT_MAX_BYTES

  ctx.clientExtensions.registerMethod(ctx, SOURCE_VIEWER_READ_METHOD, async (payload) => {
    if (!isRecord(payload) || typeof payload.path !== 'string') {
      throw new Error('source-viewer.read needs an absolute path')
    }
    return await readSourceDocument(payload.path, maxBytes) as unknown as JsonValue
  })
}

sourceViewer.inject = ['clientExtensions']

export default sourceViewer
