import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALTO_PLUGIN_DIRECTORIES_FILE,
  configuredPluginDirectories,
  pluginDirectoriesFromEnvironment,
} from '../src/server/plugin-directories.js'

describe('pluginDirectoriesFromEnvironment', () => {
  it('resolves and de-duplicates configured plugin directories', () => {
    const separator = path.delimiter
    expect(pluginDirectoriesFromEnvironment(
      '/workspace/alto',
      [`../alto-plugins`, `/opt/plugins`, `../alto-plugins`].join(separator),
    )).toEqual([
      path.resolve('/workspace/alto', '../alto-plugins'),
      path.resolve('/opt/plugins'),
    ])
  })

  it('ignores an empty setting', () => {
    expect(pluginDirectoriesFromEnvironment('/workspace/alto', '  ')).toEqual([])
  })

  it('loads the ignored project-local directory registry', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'alto-plugin-directories-'))
    try {
      const configPath = path.join(projectRoot, ALTO_PLUGIN_DIRECTORIES_FILE)
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(configPath, JSON.stringify({
        version: 1,
        directories: ['../company-plugins'],
      }))

      await expect(configuredPluginDirectories(projectRoot, undefined)).resolves.toEqual([
        path.resolve(projectRoot, '../company-plugins'),
      ])
      await expect(configuredPluginDirectories(projectRoot, ['./explicit'])).resolves.toEqual([
        path.join(projectRoot, 'explicit'),
      ])
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
