import { execFileSync } from 'node:child_process'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('macOS app bundles must be built on macOS')

const APP_NAME = 'Alto'
const BUNDLE_ID = 'com.jm.alto'
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const install = process.argv.includes('--install')
const portable = process.argv.includes('--portable')
if (install && portable) throw new Error('--install and --portable cannot be used together')
const outputRoot = install
  ? path.join(os.homedir(), 'Applications')
  : path.join(projectRoot, 'dist', 'mac')
// Electron downloads its binary on first use. Resolve it through the package
// loader so packaging also works immediately after a clean npm ci.
const electronExecutable = createRequire(import.meta.url)('electron')
const sourceApp = path.resolve(electronExecutable, '../../..')
const icon = path.join(projectRoot, 'assets', 'Alto.icns')
const finalApp = path.join(outputRoot, `${APP_NAME}.app`)
const stagingApp = path.join(outputRoot, `.${APP_NAME}.app.staging-${process.pid}`)
const backupApp = path.join(outputRoot, `.${APP_NAME}.app.previous`)
const legacyApp = install
  ? path.join(outputRoot, ['Codex', 'Cordis.app'].join(' '))
  : undefined

async function exists(target) {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function plist(plistPath, command, optional = false) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plistPath], { stdio: 'pipe' })
  } catch (error) {
    if (!optional) throw error
  }
}

await Promise.all([
  exists(path.join(sourceApp, 'Contents', 'Info.plist')).then((found) => {
    if (!found) throw new Error(`Electron app bundle is missing at ${sourceApp}`)
  }),
  exists(icon).then((found) => {
    if (!found) throw new Error('assets/Alto.icns is missing; run npm run build:mac-icon first')
  }),
])

await mkdir(outputRoot, { recursive: true })
await rm(stagingApp, { recursive: true, force: true })
execFileSync('/usr/bin/ditto', [sourceApp, stagingApp], { stdio: 'inherit' })

const contents = path.join(stagingApp, 'Contents')
const resources = path.join(contents, 'Resources')
const infoPlist = path.join(contents, 'Info.plist')
await rm(path.join(resources, 'default_app.asar'), { force: true })
await rm(path.join(resources, 'app'), { recursive: true, force: true })
const appRoot = path.join(resources, 'app')
if (portable) {
  await Promise.all([
    mkdir(path.join(appRoot, 'dist'), { recursive: true }),
    mkdir(path.join(appRoot, 'native', 'ghostty', 'vendor'), { recursive: true }),
  ])
  await Promise.all([
    cp(path.join(projectRoot, 'package.json'), path.join(appRoot, 'package.json')),
    cp(path.join(projectRoot, 'package-lock.json'), path.join(appRoot, 'package-lock.json')),
    cp(path.join(projectRoot, 'LICENSE'), path.join(appRoot, 'LICENSE')),
    cp(path.join(projectRoot, 'program'), path.join(appRoot, 'program'), { recursive: true }),
    cp(path.join(projectRoot, 'src'), path.join(appRoot, 'src'), { recursive: true }),
    cp(path.join(projectRoot, 'dist', 'client'), path.join(appRoot, 'dist', 'client'), { recursive: true }),
    cp(path.join(projectRoot, 'dist', 'desktop'), path.join(appRoot, 'dist', 'desktop'), { recursive: true }),
    cp(path.join(projectRoot, 'dist', 'node'), path.join(appRoot, 'dist', 'node'), { recursive: true }),
    cp(
      path.join(projectRoot, 'native', 'ghostty', 'build'),
      path.join(appRoot, 'native', 'ghostty', 'build'),
      { recursive: true },
    ),
    cp(
      path.join(projectRoot, 'native', 'ghostty', 'vendor', 'share'),
      path.join(appRoot, 'native', 'ghostty', 'vendor', 'share'),
      { recursive: true },
    ),
    writeFile(path.join(appRoot, '.alto-portable'), ''),
  ])
  execFileSync('npm', [
    'ci',
    '--registry=https://registry.npmjs.org/',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ], { cwd: appRoot, stdio: 'inherit' })
} else {
  await symlink(projectRoot, appRoot, 'dir')
}
await cp(icon, path.join(resources, 'Alto.icns'))

plist(infoPlist, `Set :CFBundleDisplayName ${APP_NAME}`)
plist(infoPlist, `Set :CFBundleName ${APP_NAME}`)
plist(infoPlist, `Set :CFBundleIdentifier ${BUNDLE_ID}`)
plist(infoPlist, 'Set :CFBundleIconFile Alto.icns')
plist(infoPlist, `Set :CFBundleShortVersionString ${packageJson.version}`)
plist(infoPlist, `Set :CFBundleVersion ${packageJson.version}`)
plist(infoPlist, 'Delete :ElectronAsarIntegrity', true)

execFileSync('/usr/bin/codesign', [
  '--force',
  ...(portable ? ['--deep'] : []),
  '--sign',
  '-',
  stagingApp,
], { stdio: 'inherit' })

await rm(backupApp, { recursive: true, force: true })
if (await exists(finalApp)) await rename(finalApp, backupApp)
try {
  await rename(stagingApp, finalApp)
  await rm(backupApp, { recursive: true, force: true })
} catch (error) {
  if (await exists(backupApp)) await rename(backupApp, finalApp)
  throw error
}

if (legacyApp && legacyApp !== finalApp) {
  await rm(legacyApp, { recursive: true, force: true })
}

if (install) {
  // Refresh macOS's bundle and icon metadata after replacement, even when a
  // development build has the same bundle ID and version.
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', finalApp],
    { stdio: 'inherit' },
  )
}

console.log(`${install ? 'Installed' : portable ? 'Built portable' : 'Built'} ${finalApp}`)
