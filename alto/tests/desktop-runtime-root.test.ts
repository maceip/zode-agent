import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopRuntimeRoot } from '../src/desktop/runtime-root.js'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alto-runtime-root-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )))
})

describe('desktopRuntimeRoot', () => {
  it('uses the bundled root for development apps', async () => {
    const root = await temporaryRoot()
    const bundledRoot = path.join(root, 'bundle')
    await mkdir(bundledRoot)

    await expect(desktopRuntimeRoot(bundledRoot, path.join(root, 'user-data')))
      .resolves.toBe(bundledRoot)
  })

  it('copies mutable program files and links immutable release assets', async () => {
    const root = await temporaryRoot()
    const bundledRoot = path.join(root, 'bundle')
    const userDataRoot = path.join(root, 'user-data')
    await Promise.all([
      mkdir(path.join(bundledRoot, 'program'), { recursive: true }),
      mkdir(path.join(bundledRoot, 'dist'), { recursive: true }),
      mkdir(path.join(bundledRoot, 'native'), { recursive: true }),
      mkdir(path.join(bundledRoot, 'node_modules'), { recursive: true }),
      mkdir(path.join(bundledRoot, 'src'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(bundledRoot, '.alto-portable'), ''),
      writeFile(path.join(bundledRoot, 'program', 'cordis.json'), 'bundled'),
    ])

    const runtimeRoot = await desktopRuntimeRoot(bundledRoot, userDataRoot)
    expect(runtimeRoot).toBe(path.join(userDataRoot, 'runtime'))
    await expect(readFile(path.join(runtimeRoot, 'program', 'cordis.json'), 'utf8'))
      .resolves.toBe('bundled')
    await expect(readlink(path.join(runtimeRoot, 'dist')))
      .resolves.toBe(path.join(bundledRoot, 'dist'))
    await expect(readlink(path.join(runtimeRoot, 'native')))
      .resolves.toBe(path.join(bundledRoot, 'native'))
    await expect(readlink(path.join(runtimeRoot, 'node_modules')))
      .resolves.toBe(path.join(bundledRoot, 'node_modules'))
    await expect(readlink(path.join(runtimeRoot, 'src')))
      .resolves.toBe(path.join(bundledRoot, 'src'))

    await writeFile(path.join(runtimeRoot, 'program', 'cordis.json'), 'edited')
    await desktopRuntimeRoot(bundledRoot, userDataRoot)
    await expect(readFile(path.join(runtimeRoot, 'program', 'cordis.json'), 'utf8'))
      .resolves.toBe('edited')
  })
})
