import { isRecord, type JsonValue } from '../../src/shared/protocol.js'

export const FILE_TREE_LIST_METHOD = 'file-tree.list'

export interface FileTreeSnapshot {
  workspace: string
  paths: string[]
}

export function parseFileTreeSnapshot(value: JsonValue): FileTreeSnapshot {
  if (
    !isRecord(value)
    || typeof value.workspace !== 'string'
    || !Array.isArray(value.paths)
    || !value.paths.every((path) => typeof path === 'string')
  ) throw new Error('Alto returned an invalid file tree')
  return { workspace: value.workspace, paths: value.paths as string[] }
}
