import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseSourceViewerResource,
  sourceViewerResource,
} from '../program/plugins/source-viewer-api.js'
import { readSourceDocument } from '../program/plugins/source-viewer.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

describe('source viewer', () => {
  it('round-trips exact source locations through opaque pane resources', () => {
    const location = {
      path: '/tmp/source with spaces.tsx',
      line: 42,
      endLine: 47,
      column: 9,
    }

    expect(parseSourceViewerResource(sourceViewerResource(location))).toEqual(location)
    expect(parseSourceViewerResource('source:%E0%A4%A')).toBeUndefined()
  })

  it('reads UTF-8 source below an allowed workspace root', async () => {
    const root = await temporaryDirectory('alto-source-root-')
    const sourceDirectory = path.join(root, 'src')
    const file = path.join(sourceDirectory, 'main.ts')
    await mkdir(sourceDirectory)
    await writeFile(file, 'export const answer = 42\n')

    await expect(readSourceDocument(file)).resolves.toMatchObject({
      path: await realpath(file),
      name: 'main.ts',
      source: 'export const answer = 42\n',
      lineCount: 2,
    })
  })

  it('reads files outside workspaces while rejecting binary and oversized files', async () => {
    const root = await temporaryDirectory('alto-source-root-')
    const outside = await temporaryDirectory('alto-source-outside-')
    const privateFile = path.join(outside, 'private.ts')
    const binaryFile = path.join(root, 'binary.dat')
    const largeFile = path.join(root, 'large.ts')
    await writeFile(privateFile, 'private\n')
    await writeFile(binaryFile, Buffer.from([0x61, 0x00, 0x62]))
    await writeFile(largeFile, '12345')

    await expect(readSourceDocument(privateFile)).resolves.toMatchObject({
      path: await realpath(privateFile),
      source: 'private\n',
    })
    await expect(readSourceDocument(binaryFile))
      .rejects.toThrow('binary')
    await expect(readSourceDocument(largeFile, 4))
      .rejects.toThrow('limited')
  })
})
