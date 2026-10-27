import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const temporaryRoots: string[] = []
const executablePath = 'Electron.app/Contents/MacOS/Electron'

// Keep Electron's real lazy-download loader; replace its network installer only.
const successfulInstaller = `
  const fs = require('node:fs')
  const path = require('node:path')
  const executablePath = ${JSON.stringify(executablePath)}
  fs.mkdirSync(path.join(__dirname, 'dist', path.dirname(executablePath)), { recursive: true })
  fs.writeFileSync(path.join(__dirname, 'dist', executablePath), '')
  fs.writeFileSync(path.join(__dirname, 'dist', 'Electron.app', 'Contents', 'Info.plist'), '')
  fs.writeFileSync(path.join(__dirname, 'path.txt'), executablePath)
  fs.writeFileSync(path.join(__dirname, 'installer-ran'), 'yes')
`

async function fixture(installer?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alto-macos-app-'))
  temporaryRoots.push(root)
  await mkdir(path.join(root, 'scripts'))
  await cp(new URL('../scripts/build-macos-app.mjs', import.meta.url), path.join(root, 'scripts', 'build-macos-app.mjs'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.1' }))
  if (installer !== undefined) {
    const electron = path.join(root, 'node_modules', 'electron')
    await mkdir(electron, { recursive: true })
    await cp(require.resolve('electron'), path.join(electron, 'index.js'))
    await writeFile(path.join(electron, 'install.js'), installer)
  }
  return root
}

function run(root: string, mode: string[] = [], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_OVERRIDE_DIST_PATH
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'build-macos-app.mjs'), ...mode], {
    cwd: os.tmpdir(), encoding: 'utf8', env: { ...env, ...extraEnv },
  })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== 'darwin')('macOS app Electron setup', () => {
  it.each([
    { mode: [] }, { mode: ['--install'] }, { mode: ['--portable'] },
  ])('resolves and downloads a missing bundle for mode $mode from another directory', async ({ mode }) => {
    const root = await fixture(successfulInstaller)
    const result = run(root, mode)

    expect(result.status).toBe(1)
    await expect(readFile(path.join(root, 'node_modules', 'electron', 'installer-ran'), 'utf8')).resolves.toBe('yes')
    expect(result.stderr).toContain('assets/Alto.icns is missing')
    expect(result.stderr).not.toContain('Electron app bundle is missing')
  })

  it('reuses an existing binary without running the installer', async () => {
    const root = await fixture("throw new Error('installer must not run')")
    const electron = path.join(root, 'node_modules', 'electron')
    await mkdir(path.join(electron, 'dist', path.dirname(executablePath)), { recursive: true })
    await writeFile(path.join(electron, 'dist', executablePath), '')
    await writeFile(path.join(electron, 'dist', 'Electron.app', 'Contents', 'Info.plist'), '')
    await writeFile(path.join(electron, 'path.txt'), executablePath)

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('assets/Alto.icns is missing')
    expect(result.stderr).not.toContain('installer must not run')
  })

  it('reports a missing Electron package before starting packaging', async () => {
    const result = run(await fixture())
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Cannot find module 'electron'")
    expect(result.stderr).not.toContain('assets/Alto.icns is missing')
  })

  it('reports a failed download before starting packaging', async () => {
    const result = run(await fixture("throw new Error('download unavailable')"))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('download unavailable')
    expect(result.stderr).toContain('Electron failed to install correctly')
    expect(result.stderr).not.toContain('assets/Alto.icns is missing')
  })

  it('rejects an incomplete app bundle even when the binary is present', async () => {
    const root = await fixture(successfulInstaller + `
      fs.unlinkSync(path.join(__dirname, 'dist', 'Electron.app', 'Contents', 'Info.plist'))
    `)
    // Isolate the bundle check from the independent icon check.
    await mkdir(path.join(root, 'assets'))
    await writeFile(path.join(root, 'assets', 'Alto.icns'), '')
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Electron app bundle is missing at')
    expect(result.stderr).not.toContain('assets/Alto.icns is missing')
  })

  it('resolves an overridden Electron distribution instead of the default package directory', async () => {
    const root = await fixture("throw new Error('installer must not run')")
    const electron = path.join(root, 'node_modules', 'electron')
    const override = path.join(root, 'custom-electron')
    await writeFile(path.join(electron, 'path.txt'), executablePath)
    await mkdir(path.join(override, 'Electron.app', 'Contents'), { recursive: true })
    await writeFile(path.join(override, 'Electron.app', 'Contents', 'Info.plist'), '')
    const result = run(root, [], { ELECTRON_OVERRIDE_DIST_PATH: override })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('assets/Alto.icns is missing')
    expect(result.stderr).not.toContain('Electron app bundle is missing')
    expect(result.stderr).not.toContain('installer must not run')
  })
})

it.skipIf(process.platform === 'darwin')('rejects macOS packaging on other platforms before resolving Electron', async () => {
  const result = run(await fixture())
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('macOS app bundles must be built on macOS')
  expect(result.stderr).not.toContain("Cannot find module 'electron'")
})
