export const MARKDOWN_VIEWER_READ_METHOD = 'markdown-viewer.read'
export const MARKDOWN_VIEWER_WRITE_METHOD = 'markdown-viewer.write'

export interface MarkdownDocument {
  path: string
  name: string
  source: string
  modifiedAt: number
}

export interface MarkdownSaveRequest {
  path: string
  source: string
  modifiedAt: number
}

const RESOURCE_PREFIX = 'markdown:'

export function markdownViewerResource(path: string, threadId?: string): string {
  if (!threadId) return path
  return `${RESOURCE_PREFIX}${encodeURIComponent(path)}?thread=${encodeURIComponent(threadId)}`
}

export function parseMarkdownViewerResource(resource: string | undefined): { path: string; threadId?: string } | undefined {
  if (!resource) return
  if (!resource.startsWith(RESOURCE_PREFIX)) return { path: resource }
  try {
    const separator = resource.indexOf('?')
    const path = decodeURIComponent(resource.slice(RESOURCE_PREFIX.length, separator < 0 ? undefined : separator))
    if (!path) return
    const threadId = new URLSearchParams(separator < 0 ? '' : resource.slice(separator + 1)).get('thread')
    return { path, ...(threadId ? { threadId } : {}) }
  } catch { return }
}
