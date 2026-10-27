import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { DynamicToolCall } from '../../src/server/plugin-api.js'
import { isRecord } from '../../src/shared/protocol.js'

async function stagedContent(projectRoot: string, sourcePath: string): Promise<string> {
  if (!sourcePath || path.isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).includes('..')) {
    throw new Error('sourcePath must be relative to the Alto staging directory')
  }
  const root = path.join(await realpath(projectRoot), '.codex-cordis', 'staging')
  const resolved = await realpath(path.resolve(root, sourcePath))
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('sourcePath escapes the Alto staging directory')
  }

  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('sourcePath must identify a regular file')
    // ProgramRuntime accepts 500,000 UTF-16 code units. Bound the read even
    // when another process grows the staged file after stat.
    const bytes = Buffer.alloc(2_000_001)
    if (stat.size >= bytes.length) throw new Error('staged program file is too large')
    let size = 0
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    if (size === bytes.length) throw new Error('staged program file is too large')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
  } finally {
    await file.close()
  }
}

export async function readProgramChange(call: DynamicToolCall, projectRoot: string): Promise<{
  summary: string
  files: Array<{ path: string; content: string }>
}> {
  if (!isRecord(call.arguments) || typeof call.arguments.summary !== 'string' || !call.arguments.summary.trim()) {
    throw new Error('summary must be a nonempty string')
  }
  const input = call.arguments.files
  if (!Array.isArray(input) || !input.length || input.length > 24) throw new Error('files must contain between 1 and 24 replacements')
  const files: Array<{ path: string; content: string }> = []
  for (const [index, value] of input.entries()) {
    if (!isRecord(value) || typeof value.path !== 'string') throw new Error(`files[${index}] needs a string path`)
    const inline = typeof value.content === 'string'
    const staged = typeof value.sourcePath === 'string'
    if (inline === staged || ('content' in value && !inline) || ('sourcePath' in value && !staged)) {
      throw new Error(`files[${index}] needs exactly one of content or sourcePath`)
    }
    const content = inline ? value.content as string : await stagedContent(projectRoot, value.sourcePath as string)
    if (content.length > 500_000) throw new Error(`program file is too large: ${value.path}`)
    files.push({ path: value.path, content })
  }
  return { summary: call.arguments.summary, files }
}
