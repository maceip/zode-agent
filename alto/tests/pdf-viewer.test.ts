import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectPdfDocument } from '../program/plugins/pdf-viewer.js'

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

describe('PDF viewer', () => {
  it('inspects a real PDF without sending its contents through the client extension', async () => {
    const root = await temporaryDirectory('alto-pdf-root-')
    const file = path.join(root, 'report.pdf')
    const source = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'
    await writeFile(file, source)

    await expect(inspectPdfDocument(file)).resolves.toMatchObject({
      path: await realpath(file),
      name: 'report.pdf',
      size: Buffer.byteLength(source),
    })
  })

  it('rejects mislabeled and oversized files before opening a native view', async () => {
    const root = await temporaryDirectory('alto-pdf-invalid-')
    const mislabeled = path.join(root, 'report.pdf')
    const wrongExtension = path.join(root, 'report.txt')
    await writeFile(mislabeled, 'not a PDF')
    await writeFile(wrongExtension, '%PDF-1.7\n%%EOF\n')

    await expect(inspectPdfDocument(mislabeled)).rejects.toThrow('does not contain a PDF header')
    await expect(inspectPdfDocument(wrongExtension)).rejects.toThrow('not a PDF document')
    await expect(inspectPdfDocument(wrongExtension, 4)).rejects.toThrow('not a PDF document')

    const valid = path.join(root, 'large.pdf')
    await writeFile(valid, '%PDF-1.7\n%%EOF\n')
    await expect(inspectPdfDocument(valid, 4)).rejects.toThrow('limited to 0 MB')
  })
})
