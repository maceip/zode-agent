import { isRecord } from '../../src/shared/protocol.js'
import { stringValue } from './ui/values.js'

export function commandTitle(item: Record<string, unknown>): string {
  const actionTypes = Array.isArray(item.commandActions)
    ? item.commandActions.flatMap((action) => (
        isRecord(action) && typeof action.type === 'string' ? [action.type] : []
      ))
    : []
  if (actionTypes.length > 0 && actionTypes.every((type) => type === 'read' || type === 'listFiles')) {
    return 'Read files'
  }
  if (actionTypes.includes('search')) return 'Searched files'
  return 'Ran a command'
}

export function toolTitle(item: Record<string, unknown>): string {
  const tool = stringValue(item.tool) ?? stringValue(item.type) ?? 'tool'
  const identity = `${stringValue(item.server) ?? ''} ${tool}`.toLowerCase()
  if (identity.includes('browser') || identity.includes('node_repl')) return 'Used the browser'
  if (identity.includes('apply_patch') || identity.includes('write_file') || identity.includes('edit')) return 'Edited a file'
  if (identity.includes('read_file') || identity.includes('read_mcp')) return 'Read files'
  if (identity.includes('view_image') || identity.includes('imageview')) return 'Viewed an image'
  if (identity.includes('exec_command') || identity.includes('write_stdin')) return 'Ran a command'
  if (item.type === 'webSearch') return 'Searched the web'
  return `Used ${tool.replace(/^mcp__/, '').replaceAll('_', ' ')}`
}
