import { Worker } from 'node:worker_threads'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import type { ProcessOptions, ProcessOutput, ProcessRunnerService } from './process-runner-api.js'

// Even asynchronous execFile synchronously creates the process. On macOS that
// can take hundreds of milliseconds, so periodic scans must launch off Electron's
// main thread. Keep this worker self-contained so bundled plugins can reload it.
const workerSource = `
const { execFile } = require('node:child_process')
const { parentPort } = require('node:worker_threads')
const queue = []
const children = new Map()
let disposed = false

function drain() {
  while (!disposed && children.size < 4 && queue.length) {
    const { id, file, args, options } = queue.shift()
    try {
      const child = execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
        children.delete(id)
        if (!disposed) {
          parentPort.postMessage({ id, stdout, stderr, ...(error ? { error: {
            message: error.message, code: error.code, signal: error.signal,
            killed: error.killed, cmd: error.cmd,
          } } : {}) })
          drain()
        }
      })
      children.set(id, child)
    } catch (error) {
      parentPort.postMessage({ id, stdout: '', stderr: '', error: { message: error.message, code: error.code } })
    }
  }
}

parentPort.on('message', (message) => {
  if (message.type === 'dispose') {
    disposed = true
    queue.length = 0
    for (const child of children.values()) child.kill('SIGKILL')
    parentPort.close()
  } else if (message.type === 'cancel') {
    const index = queue.findIndex((request) => request.id === message.id)
    if (index >= 0) queue.splice(index, 1)
    children.get(message.id)?.kill('SIGTERM')
  } else if (!disposed) {
    queue.push(message)
    drain()
  }
})
`

interface ProcessReply extends ProcessOutput {
  id: number
  error?: {
    message: string
    code?: string | number
    signal?: string
    killed?: boolean
    cmd?: string
  }
}

export class ProcessRunner implements ProcessRunnerService {
  private readonly worker = new Worker(workerSource, { eval: true })
  private readonly pending = new Map<number, {
    resolve: (output: ProcessOutput) => void
    reject: (error: unknown) => void
    cleanup: () => void
  }>()
  private nextId = 0
  private stopped: Error | undefined
  private readonly exited: Promise<void>

  constructor() {
    this.worker.on('message', (reply: ProcessReply) => {
      const pending = this.pending.get(reply.id)
      if (!pending) return
      this.pending.delete(reply.id)
      pending.cleanup()
      if (reply.error) {
        pending.reject(Object.assign(new Error(reply.error.message), reply.error, {
          stdout: reply.stdout,
          stderr: reply.stderr,
        }))
      } else {
        pending.resolve({ stdout: reply.stdout, stderr: reply.stderr })
      }
    })
    this.worker.on('error', (error) => this.fail(error instanceof Error ? error : new Error(String(error))))
    this.exited = new Promise((resolve) => this.worker.once('exit', (code) => {
      this.fail(new Error(`Process worker exited (${code})`))
      resolve()
    }))
  }

  execFile(file: string, args: string[], options: ProcessOptions = {}): Promise<ProcessOutput> {
    if (this.stopped) return Promise.reject(this.stopped)
    const { signal, ...commandOptions } = options
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const cancel = (): void => {
        this.pending.delete(id)
        cleanup()
        reject(signal?.reason)
        this.worker.postMessage({ type: 'cancel', id })
      }
      const cleanup = (): void => signal?.removeEventListener('abort', cancel)
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        this.worker.postMessage({ id, file, args, options: {
          timeout: 5_000,
          maxBuffer: 4 * 1024 * 1024,
          env: process.env,
          ...commandOptions,
        } })
      } catch (error) {
        this.pending.delete(id)
        cleanup()
        reject(error)
      }
    })
  }

  async dispose(): Promise<void> {
    if (!this.stopped) {
      this.fail(new Error('Process runner disposed'))
      this.worker.postMessage({ type: 'dispose' })
    }
    await this.exited
  }

  private fail(error: Error): void {
    this.stopped ??= error
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(this.stopped)
    }
    this.pending.clear()
  }
}

const processRunner: HarnessPlugin = (ctx) => {
  ctx.effect(() => {
    const runner = new ProcessRunner()
    ctx.provide('processRunner', runner)
    return () => runner.dispose()
  }, 'processRunner.worker')
}

processRunner.provide = 'processRunner'
export default processRunner
