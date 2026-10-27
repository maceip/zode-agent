import type { ComponentType } from 'react'
import type { LocalProject, ThreadSummary } from '../../src/shared/protocol.js'

export const HISTORY_ENTRY_DECORATION_COMPONENT = 'sidebar.history-entry-decoration'

export interface HistoryEntryDecorationProps {
  thread: ThreadSummary
  project?: LocalProject | undefined
  active: boolean
}

export type HistoryEntryDecoration = ComponentType<HistoryEntryDecorationProps>
