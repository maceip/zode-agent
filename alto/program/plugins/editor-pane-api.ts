import type { MarkdownFileLinkDetails } from './markdown-api.js'
import type { ClientSessionService } from './session-api.js'

export const EDITOR_PANE_KIND = 'editor'
export const EDITOR_PREPARE = 'editor.prepare'
export const EDITOR_OPEN_FILE = 'editor.open-file'

export interface EditorLaunch {
  workingDirectory: string
  command: string
}

export interface ClientEditorService {
  unavailable(session: ClientSessionService): string | undefined
  open(session: ClientSessionService): void
  openFile(details: MarkdownFileLinkDetails, origin: HTMLElement): boolean
}

declare module 'cordis' {
  interface Context {
    clientEditor: ClientEditorService
  }
}
