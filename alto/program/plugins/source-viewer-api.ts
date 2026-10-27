import { isRecord, type JsonValue } from '../../src/shared/protocol.js'

export const SOURCE_VIEWER_READ_METHOD = 'source-viewer.read'
export const SOURCE_VIEWER_PANE_KIND = 'source-viewer'
const RESOURCE_PREFIX = 'source:'

export interface SourceLocation {
  path: string
  line?: number
  endLine?: number
  column?: number
}

export interface SourceDocument {
  path: string
  name: string
  source: string
  revision: string
  modifiedAt: number
  lineCount: number
}

function positive(value: string | null): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function sourceViewerResource(location: SourceLocation): string {
  const query = new URLSearchParams()
  if (location.line) query.set('line', String(location.line))
  if (location.endLine) query.set('endLine', String(location.endLine))
  if (location.column) query.set('column', String(location.column))
  const suffix = query.size ? `?${query}` : ''
  return `${RESOURCE_PREFIX}${encodeURIComponent(location.path)}${suffix}`
}

export function parseSourceViewerResource(resource: string | undefined): SourceLocation | undefined {
  if (!resource?.startsWith(RESOURCE_PREFIX)) return undefined
  const separator = resource.indexOf('?')
  const encodedPath = resource.slice(RESOURCE_PREFIX.length, separator < 0 ? undefined : separator)
  let path: string
  try {
    path = decodeURIComponent(encodedPath)
  } catch {
    return undefined
  }
  if (!path) return undefined
  const query = new URLSearchParams(separator < 0 ? '' : resource.slice(separator + 1))
  const line = positive(query.get('line'))
  const endLine = positive(query.get('endLine'))
  const column = positive(query.get('column'))
  return {
    path,
    ...(line ? { line } : {}),
    ...(endLine ? { endLine } : {}),
    ...(column ? { column } : {}),
  }
}

export function parseSourceDocument(value: JsonValue): SourceDocument {
  if (
    !isRecord(value)
    || typeof value.path !== 'string'
    || typeof value.name !== 'string'
    || typeof value.source !== 'string'
    || typeof value.revision !== 'string'
    || typeof value.modifiedAt !== 'number'
    || typeof value.lineCount !== 'number'
  ) throw new Error('Alto returned an invalid source document')
  return {
    path: value.path,
    name: value.name,
    source: value.source,
    revision: value.revision,
    modifiedAt: value.modifiedAt,
    lineCount: value.lineCount,
  }
}
