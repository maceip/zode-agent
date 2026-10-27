import childProcess from 'node:child_process'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import processRunner, { ProcessRunner } from '../program/plugins/process-runner.js'

const runners: ProcessRunner[] = []
const directories: string[] = []

function runner(): ProcessRunner {
  const instance = new ProcessRunner()
  runners.push(instance)
  return instance
}

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'alto-process-'))
  directories.push(value)
  return value
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(runners.splice(0).map((instance) => instance.dispose()))
  await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

describe('background process runner', () => {
  it('launches commands outside the main thread and preserves cwd, env, and output', async () => {
    const instance = runner()
    const cwd = await directory()
    const spy = vi.spyOn(childProcess, 'execFile')
    const result = await instance.execFile(process.execPath, ['-e', `
      console.log(JSON.stringify({ cwd: process.cwd(), value: process.env.ALTO_TEST_VALUE }))
      console.error('diagnostic')
    `], { cwd, env: { ALTO_TEST_VALUE: 'inherited option' } })
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: await realpath(cwd),
      value: 'inherited option',
    })
    expect(result.stderr).toBe('diagnostic\n')
    expect(spy).not.toHaveBeenCalled()
  })

  it('preserves command errors and continues after a failed launch', async () => {
    const instance = runner()
    await expect(instance.execFile(process.execPath, ['-e', `
      process.stdout.write('partial'); process.stderr.write('failure'); process.exit(7)
    `])).rejects.toMatchObject({ code: 7, stdout: 'partial', stderr: 'failure' })
    await expect(instance.execFile('/nonexistent/alto-test-command', [])).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(instance.execFile(process.execPath, ['-e', "process.stdout.write('ok')"]))
      .resolves.toEqual({ stdout: 'ok', stderr: '' })
  })

  it('enforces command timeouts and output limits', async () => {
    const instance = runner()
    await expect(instance.execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 }))
      .rejects.toMatchObject({ killed: true, signal: 'SIGTERM' })
    await expect(instance.execFile(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], { maxBuffer: 100 }))
      .rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  })

  it('aborts a running command and rejects already-aborted requests without launching', async () => {
    const instance = runner()
    const cwd = await directory()
    const controller = new AbortController()
    const task = instance.execFile(process.execPath, ['-e', `
      require('node:fs').writeFileSync('pid', String(process.pid))
      setInterval(() => {}, 1000)
    `], { cwd, signal: controller.signal }).catch((error: unknown) => error)
    await vi.waitFor(async () => expect(await readdir(cwd)).toEqual(['pid']))
    const pid = Number(await readFile(path.join(cwd, 'pid'), 'utf8'))
    controller.abort(new Error('cancelled refresh'))
    expect(await task).toMatchObject({ message: 'cancelled refresh' })
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
    await expect(instance.execFile(process.execPath, ['-e', "require('node:fs').writeFileSync('unexpected', '')"], {
      cwd, signal: controller.signal,
    })).rejects.toThrow('cancelled refresh')
    expect(await readdir(cwd)).toEqual(['pid'])
  })

  it('limits concurrent launches and kills running commands without starting queued ones on disposal', async () => {
    const instance = runner()
    const cwd = await directory()
    const tasks = Array.from({ length: 10 }, (_, index) => instance.execFile(process.execPath, ['-e', `
      require('node:fs').writeFileSync(${JSON.stringify(String(index))}, String(process.pid))
      setInterval(() => {}, 1000)
    `], { cwd, timeout: 10_000 }).catch((error: unknown) => error))
    await vi.waitFor(async () => expect(await readdir(cwd)).toHaveLength(4), { timeout: 5_000 })
    const pids = await Promise.all((await readdir(cwd)).map(async (file) => Number(await readFile(path.join(cwd, file), 'utf8'))))
    await instance.dispose()
    for (const result of await Promise.all(tasks)) expect(result).toMatchObject({ message: 'Process runner disposed' })
    expect(await readdir(cwd)).toHaveLength(4)
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    await expect(instance.execFile(process.execPath, ['-e', ''])).rejects.toThrow('disposed')
  })

  it('releases its worker when the owning plugin unloads', async () => {
    const root = new Context()
    const fiber = await root.plugin(processRunner)
    try {
      const service = root.processRunner
      await expect(service.execFile(process.execPath, ['-e', "process.stdout.write('ready')"]))
        .resolves.toEqual({ stdout: 'ready', stderr: '' })
      await fiber.dispose()
      await expect(service.execFile(process.execPath, ['-e', ''])).rejects.toThrow('disposed')
    } finally {
      await fiber.dispose()
    }
  })
})
