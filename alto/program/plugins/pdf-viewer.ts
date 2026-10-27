import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import {
  PDF_VIEWER_INSPECT_METHOD,
  type PdfDocument,
} from './pdf-viewer-api.js'
import { resolveReadableFile } from './workspace-files.js'

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
const PDF_HEADER_BYTES = 1024

export async function inspectPdfDocument(
  filePath: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<PdfDocument> {
  if (!path.isAbsolute(filePath)) throw new Error('PDF files must use an absolute path')
  if (path.extname(filePath).toLowerCase() !== '.pdf') {
    throw new Error('That file is not a PDF document')
  }

  const resolved = await resolveReadableFile(filePath)
  const metadata = await stat(resolved)
  if (!metadata.isFile()) throw new Error('That PDF path is not a file')
  if (metadata.size > maxBytes) {
    throw new Error(`PDF preview is limited to ${Math.floor(maxBytes / 1024 / 1024)} MB`)
  }

  const handle = await open(resolved, 'r')
  try {
    const header = Buffer.alloc(Math.min(PDF_HEADER_BYTES, Math.max(0, metadata.size)))
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (!header.subarray(0, bytesRead).includes(Buffer.from('%PDF-'))) {
      throw new Error('That file does not contain a PDF header')
    }
  } finally {
    await handle.close()
  }

  return {
    path: resolved,
    name: path.basename(resolved),
    size: metadata.size,
    modifiedAt: Math.floor(metadata.mtimeMs),
  }
}

function asJson(document: PdfDocument): JsonValue {
  return document as unknown as JsonValue
}

const pdfViewer: HarnessPlugin<{ maxBytes?: number }> = (ctx, config) => {
  const configuredMax = config?.maxBytes
  const maxBytes = typeof configuredMax === 'number' && Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : DEFAULT_MAX_BYTES

  ctx.clientExtensions.registerMethod(ctx, PDF_VIEWER_INSPECT_METHOD, async (payload) => {
    if (!isRecord(payload) || typeof payload.path !== 'string') {
      throw new Error('pdf-viewer.inspect needs an absolute path')
    }
    return asJson(await inspectPdfDocument(payload.path, maxBytes))
  })
}

pdfViewer.inject = ['clientExtensions']

export default pdfViewer
