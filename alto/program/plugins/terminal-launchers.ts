import type { Context } from 'cordis'
import type { TerminalLauncher, TerminalLaunchRequest } from './ghostty-terminal-api.js'

export class TerminalLaunchers {
  private launcher: TerminalLauncher | undefined

  register(owner: Context, launcher: TerminalLauncher): { dispose(): void } {
    if (this.launcher) throw new Error(`Terminal launcher ${this.launcher.id} is already registered`)
    const dispose = owner.effect(() => {
      this.launcher = launcher
      return () => { if (this.launcher === launcher) this.launcher = undefined }
    })
    return { dispose }
  }

  async prepare(request: TerminalLaunchRequest): Promise<{ command?: string }> {
    return request.identity && this.launcher
      ? this.launcher.prepare(request)
      : (request.command ? { command: request.command } : {})
  }

  async close(identity: NonNullable<TerminalLaunchRequest['identity']>): Promise<void> {
    await this.launcher?.close(identity)
  }
}
