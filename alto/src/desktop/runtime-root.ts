import { access, cp, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises'
import path from 'node:path'

const PORTABLE_MARKER = '.alto-portable'

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false)
}

async function copyInitialProgram(bundledRoot: string, runtimeRoot: string): Promise<void> {
  const destination = path.join(runtimeRoot, 'program')
  if (await exists(destination)) return

  const temporary = `${destination}.staging-${process.pid}`
  await rm(temporary, { recursive: true, force: true })
  await cp(path.join(bundledRoot, 'program'), temporary, { recursive: true })
  try {
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    if (!await exists(destination)) throw error
  }
}

async function pointAtBundle(runtimeRoot: string, bundledRoot: string, name: string): Promise<void> {
  const destination = path.join(runtimeRoot, name)
  const source = path.join(bundledRoot, name)
  const current = await readlink(destination).catch(() => undefined)
  if (current === source) return

  await rm(destination, { recursive: true, force: true })
  await symlink(source, destination, 'dir')
}

/**
 * Portable releases keep executable assets inside the app, but copy the
 * reprogrammable Cordis program and mutable state into Application Support.
 * Development bundles remain rooted at their checkout as before.
 */
export async function desktopRuntimeRoot(
  bundledRoot: string,
  userDataRoot: string,
): Promise<string> {
  if (!await exists(path.join(bundledRoot, PORTABLE_MARKER))) return bundledRoot

  const runtimeRoot = path.join(userDataRoot, 'runtime')
  await mkdir(runtimeRoot, { recursive: true })
  await copyInitialProgram(bundledRoot, runtimeRoot)
  await Promise.all([
    pointAtBundle(runtimeRoot, bundledRoot, 'dist'),
    pointAtBundle(runtimeRoot, bundledRoot, 'native'),
    pointAtBundle(runtimeRoot, bundledRoot, 'node_modules'),
    pointAtBundle(runtimeRoot, bundledRoot, 'src'),
  ])
  return runtimeRoot
}
