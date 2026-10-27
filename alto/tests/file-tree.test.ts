import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { listWorkspaceFiles } from '../program/plugins/file-tree.js'

const execFileAsync = promisify(execFile)
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

describe('file tree', () => {
  it('lists tracked and untracked Git files while respecting ignore rules', async () => {
    const root = await temporaryDirectory('alto-file-tree-git-')
    await execFileAsync('git', ['-C', root, 'init', '--quiet'])
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n')
    await writeFile(path.join(root, 'README.md'), '# Project\n')
    await writeFile(path.join(root, 'src', 'tracked.ts'), 'export {}\n')
    await writeFile(path.join(root, 'src', 'untracked.ts'), 'export const value = 1\n')
    await writeFile(path.join(root, 'ignored.txt'), 'ignored\n')
    await execFileAsync('git', ['-C', root, 'add', '.gitignore', 'README.md', 'src/tracked.ts'])

    await expect(listWorkspaceFiles(root)).resolves.toEqual([
      '.gitignore',
      'README.md',
      'src/tracked.ts',
      'src/untracked.ts',
    ])
  })

  it('falls back to a bounded filesystem walk outside Git repositories', async () => {
    const root = await temporaryDirectory('alto-file-tree-directory-')
    await mkdir(path.join(root, 'nested'))
    await mkdir(path.join(root, 'node_modules'))
    await mkdir(path.join(root, '.hidden'))
    await writeFile(path.join(root, 'a.txt'), 'a\n')
    await writeFile(path.join(root, 'nested', 'b.txt'), 'b\n')
    await writeFile(path.join(root, 'node_modules', 'dependency.js'), 'ignored\n')
    await writeFile(path.join(root, '.hidden', 'private.txt'), 'ignored\n')

    await expect(listWorkspaceFiles(root)).resolves.toEqual(['a.txt', 'nested/b.txt'])
    await expect(listWorkspaceFiles(root, 1)).resolves.toHaveLength(1)
  })
})
