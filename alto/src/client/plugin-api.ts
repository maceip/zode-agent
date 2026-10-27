import type { ComponentType } from 'react'
import type {
  ChatAttachment,
  ChatImage,
  HarnessEvent,
  HarnessSnapshot,
  JsonValue,
  SkillOption,
  UiContribution,
  UiSurface,
} from '../shared/protocol.js'
import type { Command } from './commands.js'
import type { ClientNativeViewsService } from './native-views.js'
import type { ClientNativeTerminalsService } from './native-terminals.js'

export type { ClientNativeViewsService } from './native-views.js'
export type { ClientNativeTerminalsService } from './native-terminals.js'

/**
 * Stable, low-specificity visual primitives supplied by the client kernel.
 *
 * Plugins should add their own feature class beside these classes. The core
 * selectors use `:where()`, so normal plugin-local CSS always wins without
 * requiring `!important` or knowledge of the stylesheet load order.
 */
export const clientStyles = {
  pane: 'alto-pane',
  paneHeader: 'alto-pane-header',
  toolbar: 'alto-toolbar',
  paneToolbar: 'alto-pane-toolbar',
  toolbarTitle: 'alto-toolbar-title',
  toolbarPicker: 'alto-toolbar-picker',
  toolbarActions: 'alto-toolbar-actions',
  toolbarGroup: 'alto-toolbar-group',
  toolbarModes: 'alto-toolbar-modes',
  overlayLayer: 'alto-overlay-layer',
  floatingPanel: 'alto-floating-panel',
  button: 'alto-button',
  iconButton: 'alto-icon-button',
} as const

export interface ClientHostSnapshot {
  revision: number
  connectionEpoch: number
  connection: 'connecting' | 'online' | 'retrying'
  connected: boolean
  problem?: string | undefined
  snapshot?: HarnessSnapshot | undefined
}

export interface ClientHostService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientHostSnapshot
  journal(): readonly HarnessEvent[]
  onEvent(listener: (event: HarnessEvent) => void, replay?: boolean): () => void
  programActivated(revision: number): void
  command: Command
  call(method: string, payload?: JsonValue): Promise<JsonValue>
}

export interface ClientOverlays {
  subscribe(listener: () => void): () => void
  snapshot(): string | undefined
  nativeViewsOccluded(): boolean
  open(id: string, options?: ClientOverlayOptions): void
  toggle(id: string, options?: ClientOverlayOptions): void
  close(id: string): void
  closeAll(): void
}

export interface ClientOverlayOptions {
  /**
   * Native desktop surfaces sit above the browser renderer. Modal overlays
   * hide them so the overlay cannot be obscured; lightweight HUDs opt out.
   */
  occludesNativeViews?: boolean
}

export interface ClientDraft {
  text: string
  images: ChatImage[]
  attachments: ChatAttachment[]
  skills: SkillOption[]
}

export type ClientSubmitMode = 'queue' | 'steer'

export interface ClientSubmitTarget {
  /** Stable while a composer is addressing the same pane. */
  id: string
  threadId?: string
  activeTurn: boolean
  send(draft: ClientDraft): Promise<void>
  steer(draft: ClientDraft): Promise<void>
}

export interface ClientSubmitRequest {
  mode: ClientSubmitMode
  target?: ClientSubmitTarget
}

export interface ClientSurfaceProps {
  surface: UiSurface
}

export type ClientSurfaceRenderer = ComponentType<ClientSurfaceProps>

/** A named, plugin-owned React component with feature-defined props. */
export type ClientComponentRenderer<Props = unknown> = ComponentType<Props>

export interface ClientContributionProps {
  contribution: UiContribution
}

export type ClientContributionRenderer = ComponentType<ClientContributionProps>

export type ClientRootRenderer = ComponentType

export interface ClientSettingsIconProps {
  size?: number
}

/** A plugin-owned page rendered inside Alto's shared Settings window. */
export interface ClientSettingsPage {
  id: string
  label: string
  /** Embeds a compact settings section in a built-in page instead of adding navigation. */
  placement?: 'general'
  group?: string
  keywords?: readonly string[]
  order?: number
  icon?: ClientComponentRenderer<ClientSettingsIconProps>
  renderer: ClientRootRenderer
}

export interface ClientSurfaceRegistration {
  update(renderer: ClientSurfaceRenderer): void
  dispose(): Promise<void>
}

export interface ClientComponentRegistration<Props = unknown> {
  update(renderer: ClientComponentRenderer<Props>): void
  dispose(): Promise<void>
}

export interface ClientContributionRegistration {
  update(renderer: ClientContributionRenderer): void
  dispose(): Promise<void>
}

export interface ClientRootRegistration {
  update(renderer: ClientRootRenderer): void
  dispose(): Promise<void>
}

export interface ClientSettingsPageRegistration {
  update(page: ClientSettingsPage): void
  dispose(): Promise<void>
}

export interface ClientStyleRegistration {
  update(css: string): void
  dispose(): Promise<void>
}

export type ClientSubmitNext = (draft: ClientDraft) => Promise<void>

export type ClientSubmitMiddleware = (
  draft: ClientDraft,
  next: ClientSubmitNext,
  request: ClientSubmitRequest,
) => Promise<void>

export interface ClientSubmitRegistration {
  dispose(): Promise<void>
}

export interface ClientSubmitMiddlewareOptions {
  activeTurn?: boolean
}

export interface BrowserPluginResourceSet {
  surfaces?: readonly string[]
  components?: readonly string[]
  roots?: readonly string[]
  extensions?: readonly string[]
}

export interface BrowserPluginResources {
  /** Browser resources this entry installs while its fiber is active. */
  provides?: BrowserPluginResourceSet
  /** Resources that must already exist for this entry to work. */
  requires?: BrowserPluginResourceSet
}

export interface ClientPluginMetadata {
  id: string
  module: string
  hash: string
  serverModule?: string
  protocolVersion: number
  inject: string[]
  provides: string[]
  resources: BrowserPluginResources
}

export interface ClientProgramDiagnostic {
  pluginId?: string
  severity: 'error' | 'warning'
  message: string
}

export interface ClientProgramSnapshot {
  revision: number
  status: 'idle' | 'loading' | 'active' | 'failed'
  error?: string
  plugins: ClientPluginMetadata[]
  diagnostics: ClientProgramDiagnostic[]
}

export interface ClientProgramService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientProgramSnapshot
  validate(
    ui: import('../shared/protocol.js').UiSnapshot,
    extensions: Readonly<Record<string, JsonValue>>,
    extensionMethods?: readonly string[],
  ): ClientProgramDiagnostic[]
}

export interface ClientUiService {
  readonly overlays: ClientOverlays
  subscribe(listener: () => void): () => void
  snapshot(): number
  renderer(surface: UiSurface): ClientSurfaceRenderer | undefined
  component<Props>(id: string): ClientComponentRenderer<Props> | undefined
  contributionRenderer(): ClientContributionRenderer | undefined
  rootRenderers(): readonly Readonly<{ id: string; renderer: ClientRootRenderer }>[]
  settingsPages(): readonly ClientSettingsPage[]
  registerSurface(
    owner: import('cordis').Context,
    id: string,
    renderer: ClientSurfaceRenderer,
  ): ClientSurfaceRegistration
  registerKind(
    owner: import('cordis').Context,
    kind: string,
    renderer: ClientSurfaceRenderer,
  ): ClientSurfaceRegistration
  registerComponent<Props>(
    owner: import('cordis').Context,
    id: string,
    renderer: ClientComponentRenderer<Props>,
  ): ClientComponentRegistration<Props>
  registerContributionRenderer(
    owner: import('cordis').Context,
    renderer: ClientContributionRenderer,
  ): ClientContributionRegistration
  registerRoot(
    owner: import('cordis').Context,
    id: string,
    renderer: ClientRootRenderer,
  ): ClientRootRegistration
  registerSettingsPage(
    owner: import('cordis').Context,
    page: ClientSettingsPage,
  ): ClientSettingsPageRegistration
  registerStyle(
    owner: import('cordis').Context,
    id: string,
    css: string,
  ): ClientStyleRegistration
  registerSubmitMiddleware(
    owner: import('cordis').Context,
    middleware: ClientSubmitMiddleware,
    options?: ClientSubmitMiddlewareOptions,
  ): ClientSubmitRegistration
  canSubmitDuringTurn(): boolean
  submit(
    draft: ClientDraft,
    fallback: ClientSubmitNext,
    request?: ClientSubmitRequest,
  ): Promise<void>
}

export type BrowserPlugin<Config = JsonValue> = import('cordis').Plugin<Config> & {
  protocolVersion?: number
  resources?: BrowserPluginResources
}

declare module 'cordis' {
  interface Context {
    clientHost: ClientHostService
    clientNativeTerminals: ClientNativeTerminalsService
    clientNativeViews: ClientNativeViewsService
    clientProgram: ClientProgramService
    clientUi: ClientUiService
  }
}
