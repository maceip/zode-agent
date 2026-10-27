export interface ProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
}

export interface ProcessOutput {
  stdout: string
  stderr: string
}

export interface ProcessRunnerService {
  execFile(file: string, args: string[], options?: ProcessOptions): Promise<ProcessOutput>
}

declare module 'cordis' {
  interface Context {
    processRunner: ProcessRunnerService
  }
}
