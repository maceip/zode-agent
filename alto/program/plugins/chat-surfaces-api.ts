import type {
  ClientDraft,
  ClientSubmitMode,
  ClientSurfaceProps,
} from '../../src/client/plugin-api.js'
import type { ChatAttachment, ChatImage } from '../../src/shared/protocol.js'
import type { ClientSessionService } from './session-api.js'

export const CONVERSATION_COMPONENT = 'chat.conversation'
export const COMPOSER_COMPONENT = 'chat.composer'
export const FILE_REVIEW_ACTION_COMPONENT = 'chat.file-review-action'
export const DEFAULT_COMPOSER_PLACEHOLDER = "Let's build"

export interface ChatFileChange {
  path: string
  kind: string
  diff: string
  additions: number
  deletions: number
}

export interface FileReviewActionProps {
  activityId: string
  files: readonly ChatFileChange[]
  session: ClientSessionService
  appearance?: 'label' | 'icon'
}

export interface ConversationComponentProps extends ClientSurfaceProps {
  session: ClientSessionService
  showUnscopedRequests?: boolean
  visible?: boolean
}

export interface ComposerDraftStore {
  read(): Readonly<{
    message: string
    images: readonly ChatImage[]
    attachments: readonly ChatAttachment[]
  }> | undefined
  write(draft: Readonly<{
    message: string
    images: readonly ChatImage[]
    attachments: readonly ChatAttachment[]
  }>): void
}

export interface ComposerComponentProps extends ClientSurfaceProps {
  session: ClientSessionService
  autoFocus?: boolean
  submitDraft?: (draft: ClientDraft, mode: ClientSubmitMode) => Promise<void>
  allowSubmitDuringTurn?: boolean
  lockWorkspace?: boolean
  draftStore?: ComposerDraftStore
}
