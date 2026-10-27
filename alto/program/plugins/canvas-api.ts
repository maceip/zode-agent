import type { ComponentType } from 'react'
import type { JsonValue } from '../../src/shared/protocol.js'

export interface CanvasStorage {
  readonly scopeKey: string
  read<T extends JsonValue>(key: string, fallback: T): T
  write(key: string, value: JsonValue): void
  remove(key: string): void
}

export interface CanvasPageProps {
  storage: CanvasStorage
  page: CanvasPage
  workspace: Readonly<CanvasWorkspace>
  active: boolean
  focused: boolean
}

export interface CanvasWorkspace {
  key: string
  name: string
  path: string
  projectId?: string
}

export interface CanvasPageContent {
  id: string
  title: string
  titleForWorkspace?: (workspace: Readonly<CanvasWorkspace>) => string
  icon?: ComponentType<{ size?: number; className?: string }>
  component: ComponentType<CanvasPageProps>
  order?: number
  /** Limits automatic page creation and restoration to matching workspaces. */
  availableIn?: (workspace: Readonly<CanvasWorkspace>) => boolean
}

export interface CanvasPageContentRegistration {
  dispose(): Promise<void>
}

/** @deprecated Use CanvasPageProps and registerPage(). */
export interface CanvasWidgetProps {
  storage: CanvasStorage
}

/** @deprecated Canvas plugins now own a complete page. */
export interface CanvasWidget {
  id: string
  title: string
  component: ComponentType<CanvasWidgetProps>
  initialWidth?: number
  initialHeight?: number
  order?: number
}

export interface CanvasWidgetRegistration {
  dispose(): Promise<void>
}

export interface CanvasPage {
  id: string
  title: string
  icon?: ComponentType<{ size?: number; className?: string }>
}

export type CanvasPageDropPosition = 'before' | 'after'

export interface CanvasDockItemProps {
  storage: CanvasStorage
  pages: readonly CanvasPage[]
  activePageId: string
  activatePage(id: string): void
  createPage(): void
  closePage(id: string): void
  closePane?: () => void
  movePage(id: string, targetId: string, position: CanvasPageDropPosition): void
}

export interface CanvasDockItem {
  id: string
  component: ComponentType<CanvasDockItemProps>
  order?: number
  grow?: boolean
}

export interface CanvasDockItemRegistration {
  dispose(): Promise<void>
}

export interface ClientCanvasSnapshot {
  revision: number
  pageContents: readonly CanvasPageContent[]
  dockItems: readonly CanvasDockItem[]
}

export interface ClientCanvasService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientCanvasSnapshot
  toggle(): void
  registerPage(
    owner: import('cordis').Context,
    page: CanvasPageContent,
  ): CanvasPageContentRegistration
  /** @deprecated Use registerPage(). */
  registerWidget(
    owner: import('cordis').Context,
    widget: CanvasWidget,
  ): CanvasWidgetRegistration
  registerDockItem(
    owner: import('cordis').Context,
    item: CanvasDockItem,
  ): CanvasDockItemRegistration
}

declare module 'cordis' {
  interface Context {
    clientCanvas: ClientCanvasService
  }
}
