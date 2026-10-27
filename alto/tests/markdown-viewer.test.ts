import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readMarkdownDocument,
  writeMarkdownDocument,
} from '../program/plugins/markdown-viewer.js'
import { renderedMarkdownSource } from '../program/plugins/markdown-viewer.client.js'

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

describe('Markdown viewer', () => {
  it('converts rendered edits back to GitHub-flavored Markdown', () => {
    expect(renderedMarkdownSource(`
      <h1>Notes</h1>
      <p>Hello <strong>world</strong>.</p>
      <ul><li>One</li><li><del>Two</del></li></ul>
      <table>
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>1</td><td>2</td></tr></tbody>
      </table>
    `)).toBe(`# Notes

Hello **world**.

-   One
-   ~~Two~~

| A | B |
| --- | --- |
| 1 | 2 |
`)
  })

  it('reads an existing Markdown file by absolute path', async () => {
    const root = await temporaryDirectory('alto-markdown-root-')
    const file = path.join(root, 'notes.md')
    await writeFile(file, '# Notes\n\nHello.\n')

    await expect(readMarkdownDocument(file)).resolves.toMatchObject({
      path: await realpath(file),
      name: 'notes.md',
      source: '# Notes\n\nHello.\n',
    })
  })

  it('reads Markdown outside registered workspace roots', async () => {
    const outside = await temporaryDirectory('alto-markdown-outside-')
    const file = path.join(outside, 'notes.md')
    await writeFile(file, '# Private\n')

    await expect(readMarkdownDocument(file)).resolves.toMatchObject({
      path: await realpath(file),
      source: '# Private\n',
    })
  })

  it('saves Markdown and returns the refreshed document', async () => {
    const root = await temporaryDirectory('alto-markdown-save-')
    const file = path.join(root, 'notes.md')
    await writeFile(file, '# Before\n')
    const loaded = await readMarkdownDocument(file)

    const saved = await writeMarkdownDocument(file, '# After\n', loaded.modifiedAt)

    expect(saved).toMatchObject({
      path: await realpath(file),
      source: '# After\n',
    })
    await expect(readFile(file, 'utf8')).resolves.toBe('# After\n')
  })

  it('refuses to overwrite a file loaded at a different modification time', async () => {
    const root = await temporaryDirectory('alto-markdown-conflict-')
    const file = path.join(root, 'notes.md')
    await writeFile(file, '# Notes\n')
    const loaded = await readMarkdownDocument(file)

    await expect(writeMarkdownDocument(file, '# Changed\n', loaded.modifiedAt - 1))
      .rejects.toThrow('changed on disk')
    await expect(readFile(file, 'utf8')).resolves.toBe('# Notes\n')
  })

  it('applies the configured byte limit to edited content', async () => {
    const root = await temporaryDirectory('alto-markdown-limit-')
    const file = path.join(root, 'notes.md')
    await writeFile(file, '# Notes\n')
    const loaded = await readMarkdownDocument(file)

    await expect(writeMarkdownDocument(file, '12345', loaded.modifiedAt, 4))
      .rejects.toThrow('Markdown editing is limited')
  })
})
