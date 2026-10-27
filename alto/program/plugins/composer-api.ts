import type { ComposerActions } from './composer-actions.js'
import type { ComposerDrafts } from './composer-drafts.js'
import type { ClientSessionService } from './session-api.js'
import type { ChatAttachment } from '../../src/shared/protocol.js'

export interface ClientComposerFocusOptions {
  transition?: 'auto' | 'none'
}

export interface ClientAttachmentProvider {
  id: string
  accepts(file: File): boolean
  upload(file: File): Promise<ChatAttachment>
}

export interface ClientAttachmentProviderRegistration {
  dispose(): Promise<void>
}

export interface ClientComposerService {
  actions: ComposerActions
  drafts?: ComposerDrafts

  /** Add text to a specific pane's draft without submitting it. */
  appendToSession?(session: ClientSessionService, text: string): boolean

  focus(options?: ClientComposerFocusOptions): boolean
  attach(file: File): Promise<ChatAttachment>
  registerAttachmentProvider(
    owner: import('cordis').Context,
    provider: ClientAttachmentProvider,
  ): ClientAttachmentProviderRegistration
}

declare module 'cordis' {
  interface Context {
    clientComposer: ClientComposerService
  }
}
