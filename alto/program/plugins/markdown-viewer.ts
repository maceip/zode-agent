import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import {
  MARKDOWN_VIEWER_READ_METHOD,
  MARKDOWN_VIEWER_WRITE_METHOD,
  type MarkdownDocument,
} from './markdown-viewer-api.js'
import { resolveReadableFile } from './workspace-files.js'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd'])

function validateMarkdownPath(filePath: string): void {
  if (!path.isAbsolute(filePath)) throw new Error('Markdown files must use an absolute path')
  if (!MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLocaleLowerCase())) {
    throw new Error('That file is not a Markdown document')
  }
}

function markdownSizeLimit(maxBytes: number): string {
  return String(Math.floor(maxBytes / 1024 / 1024))
}

export async function readMarkdownDocument(
  filePath: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<MarkdownDocument> {
  validateMarkdownPath(filePath)

  const resolved = await resolveReadableFile(filePath)
  const metadata = await stat(resolved)
  if (!metadata.isFile()) throw new Error('That Markdown path is not a file')
  if (metadata.size > maxBytes) {
    throw new Error(`Markdown preview is limited to ${markdownSizeLimit(maxBytes)} MB`)
  }

  return {
    path: resolved,
    name: path.basename(resolved),
    source: await readFile(resolved, 'utf8'),
    modifiedAt: Math.floor(metadata.mtimeMs),
  }
}

export async function writeMarkdownDocument(
  filePath: string,
  source: string,
  expectedModifiedAt: number,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<MarkdownDocument> {
  validateMarkdownPath(filePath)
  if (Buffer.byteLength(source, 'utf8') > maxBytes) {
    throw new Error(`Markdown editing is limited to ${markdownSizeLimit(maxBytes)} MB`)
  }

  const resolved = await resolveReadableFile(filePath)
  const metadata = await stat(resolved)
  if (!metadata.isFile()) throw new Error('That Markdown path is not a file')
  if (Math.floor(metadata.mtimeMs) !== Math.floor(expectedModifiedAt)) {
    throw new Error('This Markdown file changed on disk. Reload it before saving.')
  }

  await writeFile(resolved, source, 'utf8')
  return readMarkdownDocument(resolved, maxBytes)
}

function asJson(document: MarkdownDocument): JsonValue {
  return document as unknown as JsonValue
}

const markdownViewer: HarnessPlugin<{ maxBytes?: number }> = (ctx, config) => {
  const configuredMax = config?.maxBytes
  const maxBytes = typeof configuredMax === 'number' && Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : DEFAULT_MAX_BYTES

  ctx.clientExtensions.registerMethod(ctx, MARKDOWN_VIEWER_READ_METHOD, async (payload) => {
    if (!isRecord(payload) || typeof payload.path !== 'string') {
      throw new Error('markdown-viewer.read needs an absolute path')
    }
    return asJson(await readMarkdownDocument(payload.path, maxBytes))
  })
  ctx.clientExtensions.registerMethod(ctx, MARKDOWN_VIEWER_WRITE_METHOD, async (payload) => {
    if (
      !isRecord(payload)
      || typeof payload.path !== 'string'
      || typeof payload.source !== 'string'
      || typeof payload.modifiedAt !== 'number'
      || !Number.isFinite(payload.modifiedAt)
    ) {
      throw new Error('markdown-viewer.write needs a path, source, and modification time')
    }
    return asJson(await writeMarkdownDocument(
      payload.path,
      payload.source,
      payload.modifiedAt,
      maxBytes,
    ))
  })
}

markdownViewer.inject = ['clientExtensions']

export default markdownViewer
