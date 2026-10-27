import { ComposerActions } from './composer-actions.js'
import { ComposerDrafts } from './composer-drafts.js'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { isRecord, type ChatAttachment, type ChatImage } from '../../src/shared/protocol.js'
import type { BrowserPlugin, ClientSubmitMode, ClientSurfaceProps, ClientUiService } from '../../src/client/plugin-api.js'
import { COMPOSER_COMPONENT, DEFAULT_COMPOSER_PLACEHOLDER, type ComposerComponentProps } from './chat-surfaces-api.js'
import type { ClientSessionService, ClientSessionSnapshot } from './session-api.js'
import type { ClientComposerFocusOptions, ClientComposerService, ClientAttachmentProvider, ClientAttachmentProviderRegistration } from './composer-api.js'
import { Composer, composerWorkspaceLabel } from './ui/composer.js'
import { focusComposerEditor } from './ui/composer-focus.js'
import { acceptsImmediateReply } from './ui/turn-intervention.js'
import { SettingsRow, SettingsSwitch } from './ui/settings.js'

const COMPOSER_PREFERENCE_STORAGE_KEY = 'alto.composer-preferences'

interface ComposerPreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ComposerPreference {
  version: 1
  autoExpand: boolean
}

export interface ComposerPreferenceSnapshot extends ComposerPreference {
  revision: number
}

export function parseComposerPreference(
  value: unknown,
  autoExpandByDefault = false,
): ComposerPreference {
  if (!isRecord(value) || value.version !== 1) {
    return { version: 1, autoExpand: autoExpandByDefault }
  }
  return {
    version: 1,
    autoExpand: typeof value.autoExpand === 'boolean'
      ? value.autoExpand
      : autoExpandByDefault,
  }
}

function composerPreferenceStorage(): ComposerPreferenceStorage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export class ComposerPreferenceController {
  private readonly listeners = new Set<() => void>()
  private state: ComposerPreferenceSnapshot

  constructor(
    autoExpandByDefault = false,
    private readonly storage = composerPreferenceStorage(),
  ) {
    let stored: unknown
    try {
      stored = JSON.parse(storage?.getItem(COMPOSER_PREFERENCE_STORAGE_KEY) ?? 'null')
    } catch {
      stored = undefined
    }
    this.state = {
      ...parseComposerPreference(stored, autoExpandByDefault),
      revision: 0,
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ComposerPreferenceSnapshot => this.state

  setAutoExpand(autoExpand: boolean): void {
    if (this.state.autoExpand === autoExpand) return
    this.state = { version: 1, autoExpand, revision: this.state.revision + 1 }
    try {
      this.storage?.setItem(COMPOSER_PREFERENCE_STORAGE_KEY, JSON.stringify({
        version: 1,
        autoExpand,
      } satisfies ComposerPreference))
    } catch {
      // The preference still applies to the current window when storage is unavailable.
    }
    for (const listener of this.listeners) listener()
  }
}

function ComposerSettings({ controller }: { controller: ComposerPreferenceController }): ReactNode {
  const preference = useSyncExternalStore(controller.subscribe, controller.snapshot)
  return (
    <section className="settings-section composer-settings-page">
      <h2>Behavior</h2>
      <div className="settings-card">
        <SettingsRow
          label="Expand while editing"
          description="Increase the composer height while it has keyboard focus."
          checked={preference.autoExpand}
          onClick={() => controller.setAutoExpand(!preference.autoExpand)}
        >
          <SettingsSwitch on={preference.autoExpand} />
        </SettingsRow>
      </div>
    </section>
  )
}

class ComposerService implements ClientComposerService {
  readonly actions = new ComposerActions()
  readonly drafts = new ComposerDrafts()

  appendToSession(session: ClientSessionService, text: string): boolean {
    return this.drafts.append(session, text)
  }
  private readonly transitionRevisions = new WeakMap<HTMLElement, number>()
  private readonly attachmentProviders = new Map<string, ClientAttachmentProvider>()

  focus(options: ClientComposerFocusOptions = {}): boolean {
    const editors = [...document.querySelectorAll<HTMLElement>('[data-cordis-composer-editor]')]
    const focusedPane = [...document.querySelectorAll<HTMLElement>('.workspace-chat-pane.is-focused')]
      .find((candidate) => candidate.getClientRects().length > 0)
    const editor = focusedPane?.querySelector<HTMLElement>('[data-cordis-composer-editor]')
      ?? editors.find((candidate) => candidate.getClientRects().length > 0)
    if (!editor) return false
    const composer = editor.closest<HTMLElement>('.composer')
    if (composer && options.transition === 'none') {
      const revision = (this.transitionRevisions.get(composer) ?? 0) + 1
      this.transitionRevisions.set(composer, revision)
      composer.classList.add('composer-focus-continuity')
      const release = (): void => {
        if (this.transitionRevisions.get(composer) !== revision) return
        this.transitionRevisions.delete(composer)
        composer.classList.remove('composer-focus-continuity')
      }
      // Keep transitions disabled until React has painted the destination's
      // focused state. Re-enabling them earlier replays the expand animation.
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(release))
      } else {
        queueMicrotask(release)
      }
    }
    focusComposerEditor(editor)
    if (document.activeElement !== editor) composer?.classList.remove('composer-focus-continuity')
    return document.activeElement === editor
  }

  async attach(file: File): Promise<ChatAttachment> {
    const provider = [...this.attachmentProviders.values()].find((candidate) => candidate.accepts(file))
    if (!provider) throw new Error(`${file.name || 'That file'} is not supported by an active attachment plugin`)
    return provider.upload(file)
  }

  registerAttachmentProvider(
    owner: import('cordis').Context,
    provider: ClientAttachmentProvider,
  ): ClientAttachmentProviderRegistration {
    let active = false
    const dispose = owner.effect(() => {
      if (this.attachmentProviders.has(provider.id)) {
        throw new Error(`Composer attachment provider "${provider.id}" is already registered`)
      }
      active = true
      this.attachmentProviders.set(provider.id, provider)
      return () => {
        active = false
        if (this.attachmentProviders.get(provider.id) === provider) {
          this.attachmentProviders.delete(provider.id)
        }
      }
    }, `clientComposer.registerAttachmentProvider(${JSON.stringify(provider.id)})`)
    return {
      dispose: async () => {
        if (active) await dispose()
      },
    }
  }
}

function composerSnapshotEqual(
  left: ClientSessionSnapshot,
  right: ClientSessionSnapshot,
): boolean {
  return left.providerId === right.providerId
    && left.remoteLocation === right.remoteLocation
    && left.remoteWorkspaceName === right.remoteWorkspaceName
    && left.agentConfig === right.agentConfig
    && left.models === right.models
    && left.providers === right.providers
    && left.acceptsImages === right.acceptsImages
    && left.connected === right.connected
    && left.harness?.codex.status === right.harness?.codex.status
    && left.harness?.codex.models === right.harness?.codex.models
    && left.projects === right.projects
    && left.activeProjectId === right.activeProjectId
    && left.projectScope === right.projectScope
    && left.threadId === right.threadId
    && left.turn.tag === right.turn.tag
    && acceptsImmediateReply(left.harness, left.threadId) === acceptsImmediateReply(right.harness, right.threadId)
    && left.canAcceptDirectInput === right.canAcceptDirectInput
    && left.skills === right.skills
    && left.session.workspace === right.session.workspace
    && left.session.model === right.session.model
    && left.session.effort === right.session.effort
    && left.session.permissionMode === right.session.permissionMode
}

function useComposerSession(session: ClientSessionService): ClientSessionSnapshot {
  const snapshot = useMemo(() => {
    let current: ClientSessionSnapshot | undefined
    return (): ClientSessionSnapshot => {
      const next = session.snapshot()
      if (!current || !composerSnapshotEqual(current, next)) current = next
      return current
    }
  }, [session])
  return useSyncExternalStore(session.subscribe, snapshot, snapshot)
}

export function ComposerSurface({
  surface,
  session,
  ui,
  composer,
  preferences,
  autoFocus,
  submitDraft,
  allowSubmitDuringTurn,
  lockWorkspace,
  draftStore,
}: ClientSurfaceProps & {
  session: ClientSessionService
  ui?: ClientUiService
  composer: ClientComposerService
  preferences: ComposerPreferenceController
  autoFocus?: boolean
  submitDraft?: (
    draft: Parameters<ClientUiService['submit']>[0],
    mode: ClientSubmitMode,
  ) => Promise<void>
  allowSubmitDuringTurn?: boolean
  lockWorkspace?: boolean
  draftStore?: ComposerComponentProps['draftStore']
}): ReactNode {
  const actions = useSyncExternalStore(composer.actions.subscribe, composer.actions.snapshot)
  const state = useComposerSession(session)
  const preference = useSyncExternalStore(preferences.subscribe, preferences.snapshot)
  const immediateReply = state.turn.tag === 'running' && acceptsImmediateReply(state.harness, state.threadId)
  const initialDraft = useRef(draftStore?.read())
  // Keep native contenteditable input out of React's render path. Revisions are
  // only needed when submit or error recovery explicitly replaces the draft.
  const message = useRef(initialDraft.current?.message ?? '')
  const [messageRevision, setMessageRevision] = useState(0)
  const [images, setImages] = useState<ChatImage[]>(() => [...(initialDraft.current?.images ?? [])])
  const [attachments, setAttachments] = useState<ChatAttachment[]>(() => [
    ...(initialDraft.current?.attachments ?? []),
  ])
  const activeProject = state.projects.find((project) => project.id === state.activeProjectId)
  const workspaceLabel = state.remoteLocation
    ? state.remoteWorkspaceName ?? ''
    : state.projectScope === 'unscoped'
    ? 'No workspace'
    : composerWorkspaceLabel(activeProject?.name, state.session.workspace)
  const workspaceLocked = Boolean(lockWorkspace) || Boolean(state.threadId) || state.turn.tag !== 'idle'

  useEffect(() => {
    draftStore?.write({ message: message.current, images, attachments })
  }, [attachments, draftStore, images])

  useEffect(() => composer.drafts?.register(session, (text) => {
    message.current = message.current ? `${message.current}\n\n${text}` : text
    draftStore?.write({ message: message.current, images, attachments })
    setMessageRevision((revision) => revision + 1)
  }), [composer, session, draftStore, images, attachments])

  const submit = async (
    draft: Parameters<ClientUiService['submit']>[0],
    mode: ClientSubmitMode,
  ): Promise<void> => {
    const previousMessage = message.current
    const previousImages = images
    const previousAttachments = attachments
    message.current = ''
    setMessageRevision((revision) => revision + 1)
    setImages([])
    setAttachments([])
    try {
      if (submitDraft) await submitDraft(draft, mode)
      else if (ui) {
        await ui.submit(draft, (forwarded) => session.send(forwarded), {
          mode,
          target: {
            id: state.threadId ?? `new:${state.session.workspace}`,
            ...(state.threadId ? { threadId: state.threadId } : {}),
            activeTurn: state.turn.tag === 'running',
            send: (forwarded) => session.send(forwarded),
            steer: (forwarded) => session.steer(forwarded),
          },
        })
      }
      else throw new Error('composer submission is not configured')
    } catch (error) {
      if (!message.current) {
        message.current = previousMessage
        setMessageRevision((revision) => revision + 1)
      }
      setImages((current) => current.length ? current : previousImages)
      setAttachments((current) => current.length ? current : previousAttachments)
      throw error
    }
  }

  const interrupt = async (): Promise<void> => {
    try {
      await session.interrupt()
    } catch (error) {
      console.error('Unable to interrupt the active turn', error)
    }
  }

  return (
    <Composer
      toolbarActions={actions.map(({ id, component: Action }) => <Action key={id} session={session} />)}
      sendLabel={immediateReply ? 'Send reply' : undefined}
      value={message.current}
      valueRevision={messageRevision}
      images={images}
      attachments={attachments}
      skills={state.skills}
      agentConfig={state.agentConfig}
      onAgentConfigChange={(id, value) => session.setAgentConfig?.(id, value)}
      models={state.models ?? state.harness?.codex.models ?? []}
      providers={state.providers}
      providerId={state.providerId}
      providerLocked={Boolean(state.threadId && state.activities.length) || state.turn.tag !== 'idle'}
      onProviderChange={(id) => session.setProvider?.(id)}
      {...((!state.providerId || state.providerId === 'codex') && session.loadModels
        ? { onModelsRequest: async () => { await session.loadModels?.() } }
        : {})}
      model={state.session.model}
      effort={state.session.effort}
      permissionMode={state.session.permissionMode}
      workspaceId={state.activeProjectId}
      workspaceLabel={workspaceLabel}
      workspaceOptions={[
        { id: '', label: 'No workspace', path: 'No workspace' },
        ...state.projects.map((project) => ({
          id: project.id,
          label: project.name,
          path: project.primaryRoot,
        })),
      ]}
      workspaceLocked={workspaceLocked}
      remoteWorkspace={Boolean(state.remoteLocation)}
      capabilities={(surface.capabilities ?? []).filter((capability) => capability !== 'images' || state.acceptsImages !== false)}
      placeholder={state.connected ? surface.placeholder ?? DEFAULT_COMPOSER_PLACEHOLDER : 'Connecting…'}
      focusHeight={surface.focusHeight ?? 156}
      maxHeight={surface.maxHeight ?? 180}
      autoExpand={preference.autoExpand}
      {...(autoFocus !== undefined ? { autoFocus } : {})}
      // Connection changes block submission, not the local draft editor. Toggling
      // contenteditable during a reconnect drops Chromium's focus and caret.
      readOnly={state.turn.tag === 'idle' && state.canAcceptDirectInput === false}
      disabled={
        !state.connected
        || (state.turn.tag === 'idle' && state.canAcceptDirectInput === false)
      }
      sending={state.turn.tag === 'sending'}
      activeTurn={state.turn.tag === 'running'}
      allowSubmitDuringTurn={allowSubmitDuringTurn ?? ui?.canSubmitDuringTurn() ?? false}
      onChange={(nextMessage) => {
        message.current = nextMessage
        draftStore?.write({ message: nextMessage, images, attachments })
      }}
      onImagesChange={setImages}
      onAttachmentsChange={setAttachments}
      onAttachFile={(file) => composer.attach(file)}
      onModelChange={(model) => session.setModel(model)}
      onEffortChange={(effort) => session.setEffort(effort)}
      onPermissionModeChange={(mode) => session.setPermissionMode(mode)}
      onWorkspaceChange={(id) => {
        if (workspaceLocked) return
        if (!id) {
          session.newThread(null)
          return
        }
        const project = state.projects.find((candidate) => candidate.id === id)
        if (project) session.retargetNewThread(project)
      }}
      onSubmit={(draft, mode) => void submit(draft, mode)}
      onInterrupt={() => void interrupt()}
    />
  )
}

interface ComposerConfig {
  composerAutoExpandByDefault?: boolean
}

const composerClient: BrowserPlugin<ComposerConfig> = (ctx, config) => {
  const ui = ctx.clientUi
  const composer = new ComposerService()
  const preferences = new ComposerPreferenceController(config?.composerAutoExpandByDefault === true)
  ctx.provide('clientComposer', composer)
  const Component = (props: ComposerComponentProps) => (
    <ComposerSurface {...props} ui={ui} composer={composer} preferences={preferences} />
  )
  const Surface = (props: ClientSurfaceProps) => <Component {...props} session={ctx.clientSession} />
  ui.registerComponent(ctx, COMPOSER_COMPONENT, Component)
  ui.registerSurface(ctx, 'default-composer', Surface)
  ui.registerSettingsPage(ctx, {
    id: 'composer', label: 'Composer', placement: 'general',
    keywords: ['composer', 'input', 'typing', 'expand', 'resize', 'focus'], order: 10,
    renderer: () => <ComposerSettings controller={preferences} />,
  })
}

composerClient.inject = ['clientUi', 'clientSession']
composerClient.provide = 'clientComposer'
composerClient.resources = {
  provides: { surfaces: ['default-composer'], components: [COMPOSER_COMPONENT] },
}

export default composerClient
