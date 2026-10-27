import type { ClientSessionService } from './session-api.js'

/** Find a pane's draft by session, including chats that do not have a thread yet. */
export class ComposerDrafts {
  private readonly targets = new Map<ClientSessionService, (text: string) => void>()

  register(session: ClientSessionService, append: (text: string) => void): () => void {
    this.targets.set(session, append)
    return () => { if (this.targets.get(session) === append) this.targets.delete(session) }
  }

  append(session: ClientSessionService, text: string): boolean {
    const target = this.targets.get(session)
    if (!target) return false
    target(text)
    return true
  }
}
