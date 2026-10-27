import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FSWatcher } from 'chokidar'
import { Context } from 'cordis'
import { expect, it, vi } from 'vitest'
import { ProgramRuntime } from '../src/server/services/program-runtime.js'

it('watches plugin sources and manifests without opening dependency or Git watchers', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'alto-program-watch-')))
  const projectRoot = path.join(root, 'alto')
  const programRoot = path.join(projectRoot, 'program')
  const externalRoot = path.join(root, 'company-plugins')
  const ignoredDirectories = [programRoot, externalRoot].flatMap((directory) => [
    path.join(directory, 'node_modules', 'icons'),
    path.join(directory, 'plugins', 'nested', 'node_modules', 'icons'),
    path.join(directory, '.git', 'objects'),
  ])
  let stop: (() => Promise<void>) | undefined
  try {
    await Promise.all(ignoredDirectories.map((directory) => mkdir(directory, { recursive: true })))
    await Promise.all(ignoredDirectories.map((directory) => writeFile(path.join(directory, 'index.js'), 'v1')))
    const entry = (id: string) => ({
      id, name: id, description: `Watches ${id} source changes.`, module: `plugins/${id}.ts`,
    })
    await writeFile(path.join(programRoot, 'cordis.json'), JSON.stringify({
      version: 2, plugins: [entry('local')],
    }))
    const externalManifest = path.join(externalRoot, 'alto-plugins.json')
    const extension = (name: string) => JSON.stringify({
      version: 1, mounts: [{ plugins: [{ ...entry('external'), name }] }],
    })
    await writeFile(externalManifest, extension('External'))
    const source = (marker: string) => `
const plugin = () => undefined
plugin.marker = ${JSON.stringify(marker)}
export default plugin
`
    const sources = [
      path.join(programRoot, 'plugins', 'local.ts'),
      path.join(externalRoot, 'plugins', 'external.ts'),
    ]
    await Promise.all(sources.map((file) => writeFile(file, source('v1'))))

    const runtime = new ProgramRuntime(new Context(), { projectRoot, pluginDirectories: [externalRoot] })
    stop = await runtime.start()
    const watcher = Reflect.get(runtime, 'watcher') as FSWatcher
    await new Promise<void>((resolve) => watcher.once('ready', resolve))
    const watchedPaths = Object.entries(watcher.getWatched()).flatMap(([directory, files]) => [
      directory, ...files.map((file) => path.join(directory, file)),
    ])
    expect(watchedPaths).toEqual(expect.arrayContaining([...sources, externalManifest]))
    for (const directory of ignoredDirectories) {
      expect(watchedPaths.some((file) => file === directory || file.startsWith(directory + path.sep))).toBe(false)
    }

    const changes: string[] = []
    watcher.on('all', (_event, file) => changes.push(file))
    const reconcile = vi.spyOn(runtime, 'reconcile')
    await Promise.all(ignoredDirectories.map((directory) => writeFile(path.join(directory, 'index.js'), 'v2')))
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(changes).toEqual([])
    expect(reconcile).not.toHaveBeenCalled()

    for (const [index, file] of sources.entries()) {
      const id = index === 0 ? 'local' : 'external'
      const before = runtime.snapshot().plugins.find((plugin) => plugin.id === id)?.loadedAt
      await writeFile(file, source('v2'))
      await vi.waitFor(() => {
        const plugin = runtime.snapshot().plugins.find((plugin) => plugin.id === id)
        expect(plugin?.state).toBe('active')
        expect(plugin?.loadedAt).not.toBe(before)
      })
    }
    await writeFile(externalManifest, extension('Renamed External'))
    await vi.waitFor(() => expect(runtime.snapshot().plugins.find((plugin) => plugin.id === 'external')?.name)
      .toBe('Renamed External'))
  } finally {
    await stop?.()
    await rm(root, { recursive: true, force: true })
  }
})
