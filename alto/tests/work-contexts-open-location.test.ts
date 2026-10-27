import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openLocalCheckout } from '../program/plugins/work-contexts.js'
import type { WorkCheckout } from '../program/plugins/work-contexts-api.js'

describe('open a checkout location', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'alto-location-'))
    directories.push(root)
    const location = path.join(root, 'repo with spaces; $(literal)')
    await mkdir(location)
    const checkout: WorkCheckout = { id: 'known', kind: 'local', projectId: 'project', branch: 'main', label: 'Project', location }
    const contexts = { checkout: (id: string) => id === checkout.id ? checkout : undefined }
    const execFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const lifetime = new AbortController()
    return { root, location, checkout, contexts, execFile, lifetime }
  }

  it.skipIf(process.platform !== 'darwin')('opens the registered directory as one literal argument', async () => {
    const run = await fixture()
    await expect(openLocalCheckout({ checkoutId: 'known', location: '/untrusted/override' }, run.contexts, run, run.lifetime.signal))
      .resolves.toEqual({ location: run.location })
    expect(run.execFile).toHaveBeenCalledWith('open', [run.location], { timeout: 15_000, signal: run.lifetime.signal })
  })

  it('rejects unregistered, remote, missing, and file targets without launching them', async () => {
    const run = await fixture()
    const open = (payload: unknown) => openLocalCheckout(payload, run.contexts, run, run.lifetime.signal)
    await expect(open({ location: run.location })).rejects.toThrow(/checkoutId/)
    await expect(open({ checkoutId: 'unknown' })).rejects.toThrow(/local checkout/)
    run.checkout.kind = 'blox'
    await expect(open({ checkoutId: 'known' })).rejects.toThrow(/local checkout/)
    run.checkout.kind = 'local'
    run.checkout.location = path.join(run.root, 'missing')
    await expect(open({ checkoutId: 'known' })).rejects.toThrow(/no longer exists/)
    run.checkout.location = path.join(run.root, 'script.command')
    await writeFile(run.checkout.location, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await expect(open({ checkoutId: 'known' })).rejects.toThrow(/no longer exists/)
    expect(run.execFile).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'darwin')('reports Finder failures and stops an unloaded action', async () => {
    const run = await fixture()
    run.execFile.mockRejectedValueOnce(new Error('unavailable'))
    await expect(openLocalCheckout({ checkoutId: 'known' }, run.contexts, run, run.lifetime.signal)).rejects.toThrow(/Could not open/)
    run.lifetime.abort()
    await expect(openLocalCheckout({ checkoutId: 'known' }, run.contexts, run, run.lifetime.signal)).rejects.toThrow()
    expect(run.execFile).toHaveBeenCalledTimes(1)
  })
})
