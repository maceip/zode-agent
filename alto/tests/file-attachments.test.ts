import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachedFileContext,
  storeFileAttachment,
} from '../program/plugins/file-attachments.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('file attachments', () => {
  it('stores bytes under an isolated directory and sanitizes the display name', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-attachments-'))
    roots.push(root)
    const attachment = await storeFileAttachment(root, {
      name: '../notes.md',
      mediaType: 'text/markdown',
      data: Buffer.from('# Notes').toString('base64'),
    })

    expect(attachment).toMatchObject({
      name: 'notes.md',
      mediaType: 'text/markdown',
      size: 7,
    })
    expect(path.relative(root, attachment.path).startsWith('..')).toBe(false)
    expect(await readFile(attachment.path, 'utf8')).toBe('# Notes')
    expect((await stat(attachment.path)).isFile()).toBe(true)
  })

  it('rejects invalid or oversized payloads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-attachments-'))
    roots.push(root)
    await expect(storeFileAttachment(root, {
      name: 'bad.bin',
      mediaType: 'application/octet-stream',
      data: 'not base64!',
    })).rejects.toThrow('valid base64')
    await expect(storeFileAttachment(root, {
      name: 'large.bin',
      mediaType: 'application/octet-stream',
      data: Buffer.from('too large').toString('base64'),
    }, 2)).rejects.toThrow('limited')
  })

  it('makes attached filenames and staged paths explicit to Codex', () => {
    expect(attachedFileContext([{
      type: 'text',
      text: 'Compare the attached notes.',
    }, {
      type: 'mention',
      name: 'architecture-notes.md',
      path: '/Users/test/.codex/attachments/alto/one/architecture-notes.md',
    }, {
      type: 'mention',
      name: 'design-analysis.md',
      path: '/Users/test/.codex/attachments/alto/two/design-analysis.md',
    }])).toBe([
      'The user attached local files to this turn. When they refer to an attached file, use these exact staged paths:',
      '- "architecture-notes.md": "/Users/test/.codex/attachments/alto/one/architecture-notes.md"',
      '- "design-analysis.md": "/Users/test/.codex/attachments/alto/two/design-analysis.md"',
    ].join('\n'))
  })

  it('does not add attachment context to ordinary turns', () => {
    expect(attachedFileContext([{ type: 'text', text: 'Hello' }])).toBeUndefined()
  })
})
