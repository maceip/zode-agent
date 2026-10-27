export const CONVERSATION_TITLES_STATE = 'conversation-titles'
export const CONVERSATION_RENAME = 'conversation-titles.rename'

export interface ConversationTitle {
  title: string
  manual: boolean
}

export type ConversationTitleSnapshot = Record<string, ConversationTitle>

declare module 'cordis' {
  interface Events {
    'conversation/rename'(id: string, title: string, next: () => Promise<void>): Promise<void>
  }
}
