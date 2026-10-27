import { RemoteSessionStartup } from './ui/remote-startup.js'
import { threadIntervention } from './ui/turn-intervention.js'
import {
  ArrowDown,
  Bot,
  Folder,
  Gauge,
  Puzzle,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react'
import {
  isRecord,
  type PermissionMode,
} from '../../src/shared/protocol.js'
import type {
  BrowserPlugin,
  ClientContributionProps,
  ClientHostService,
  ClientOverlays,
  ClientProgramService,
  ClientSettingsIconProps,
  ClientSettingsPage,
  ClientSurfaceProps,
  ClientUiService,
} from '../../src/client/plugin-api.js'
import {
  CONVERSATION_COMPONENT,
  FILE_REVIEW_ACTION_COMPONENT,
  type ConversationComponentProps,
  type FileReviewActionProps,
} from './chat-surfaces-api.js'
import type {
  ClientSessionService,
  ClientSessionSnapshot,
} from './session-api.js'
import {
  resolveMarkdownCodeBlock,
  type ClientMarkdownService,
  type MarkdownCodeBlockProps,
  type MarkdownCodeBlockRenderer,
} from './markdown-api.js'
import {
  ActivityTimeline,
} from './ui/activity.js'
import {
  ConversationScrollController,
  conversationAwayFromBottom,
  conversationScrollPlan,
  conversationShouldReleaseFollow,
  conversationShouldScrollUpdate,
} from './ui/conversation-scroll.js'
export {
  conversationAwayFromBottom,
  conversationScrollPlan,
  conversationShouldReleaseFollow,
  conversationShouldScrollUpdate,
} from './ui/conversation-scroll.js'
import { Contribution } from './ui/contribution.js'
import { ConversationPaneOverlay } from './ui/conversation-overlay.js'
import { MarkdownMathProvider } from './ui/markdown.js'
import {
  ApprovalRequest,
  ProgramProposalRequest,
} from './ui/inspectors.js'
import { PluginsPanel } from './ui/plugins.js'
import { ProjectSettings } from './ui/project-settings.js'
import { SettingsRadioMark, SettingsRow, SettingsSwitch } from './ui/settings.js'
import { currentSessionModelSummary, ModelDefaultsSettings } from './ui/model-defaults.js'
import defaultStyles from './ui/default.css'
import inputRequestStyles from './ui/user-input.css'
import modelDefaultsStyles from './ui/model-defaults.css'

type BuiltInSettingsSection = 'general' | 'workspaces' | 'model' | 'plugins'
type SettingsSection = BuiltInSettingsSection | string

const builtInSettings: ReadonlyArray<Readonly<{
  id: BuiltInSettingsSection
  label: string
  keywords: string
}>> = [
  { id: 'general', label: 'General', keywords: 'general behavior composer notifications permissions session defaults' },
  { id: 'workspaces', label: 'Workspaces', keywords: 'workspaces projects folders' },
  { id: 'model', label: 'Model & reasoning', keywords: 'model reasoning effort agent default codex claude gemini pi' },
  { id: 'plugins', label: 'Plugins', keywords: 'plugins extensions tools fibers' },
]

const permissionOptions: Array<{
  mode: PermissionMode
  label: string
  detail: string
}> = [
  {
    mode: 'ask',
    label: 'Ask when needed',
    detail: 'Codex works in its workspace and asks before broader access.',
  },
  {
    mode: 'auto',
    label: 'Auto-review',
    detail: 'Codex reviews requests for additional access while it works.',
  },
  {
    mode: 'full',
    label: 'Full access',
    detail: 'Codex can edit files and run commands without approval prompts.',
  },
]

function useSession(session: ClientSessionService): ClientSessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.snapshot)
}

function useVisibleSession(
  session: ClientSessionService,
  visible: boolean,
): ClientSessionSnapshot {
  const frozen = useRef(session.snapshot())
  const subscribe = useMemo(
    () => visible ? session.subscribe : (_listener: () => void) => () => undefined,
    [session, visible],
  )
  const snapshot = useMemo(() => () => {
    if (visible) frozen.current = session.snapshot()
    return frozen.current
  }, [session, visible])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

function useOverlayDismiss(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const dismiss = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [close, open])
}

function ModalNavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}): ReactNode {
  return (
    <button className={`program-modal-nav-item ${active ? 'active' : ''}`} type="button" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

function SettingsWorkspace({
  state,
  session,
  host,
  initialSection,
  togglePlugin,
  program,
  ui,
  close,
}: {
  state: ClientSessionSnapshot
  session: ClientSessionService
  host: ClientHostService
  initialSection: SettingsSection
  togglePlugin: (id: string, enabled: boolean) => Promise<unknown>
  program: ClientProgramService
  ui: ClientUiService
  close: () => void
}): ReactNode {
  const browserProgram = useSyncExternalStore(program.subscribe, program.snapshot)
  const uiRevision = useSyncExternalStore(ui.subscribe, ui.snapshot)
  const extensionPages = useMemo(() => ui.settingsPages(), [ui, uiRevision])
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [query, setQuery] = useState('')
  const currentModel = currentSessionModelSummary(state)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visible = (label: string): boolean => !normalizedQuery
    || label.toLocaleLowerCase().includes(normalizedQuery)
  const extensionVisible = (page: ClientSettingsPage): boolean => visible([
    page.label,
    page.group ?? '',
    ...(page.keywords ?? []),
  ].join(' '))
  const generalPages = extensionPages.filter((page) => page.placement === 'general')
  const navigableExtensionPages = extensionPages.filter((page) => page.placement !== 'general')
  const builtInVisible = (id: string): boolean => {
    const item = builtInSettings.find((candidate) => candidate.id === id)
    if (!item) return false
    return visible(item.keywords)
      || (id === 'general' && generalPages.some(extensionVisible))
  }

  useEffect(() => {
    const extension = navigableExtensionPages.find((page) => page.id === section)
    if (extension ? extensionVisible(extension) : builtInVisible(section)) return
    const nextBuiltIn = builtInSettings.find((item) => visible(item.keywords))
    const nextExtension = navigableExtensionPages.find(extensionVisible)
    setSection(nextBuiltIn?.id ?? nextExtension?.id ?? 'general')
  }, [extensionPages, normalizedQuery, section])

  const extensionPage = navigableExtensionPages.find((page) => page.id === section)
  const ExtensionRenderer = extensionPage?.renderer
  const sectionTitle = builtInSettings.find((item) => item.id === section)?.label
    ?? extensionPage?.label
    ?? 'Settings'
  const personalPages = navigableExtensionPages.filter((page) => page.group === 'Personal')
  const extensionGroups = new Map<string, ClientSettingsPage[]>()
  for (const page of navigableExtensionPages) {
    if (page.group === 'Personal') continue
    const group = page.group ?? 'Extensions'
    extensionGroups.set(group, [...(extensionGroups.get(group) ?? []), page])
  }
  const generalSections = generalPages.map((page) => {
    const Renderer = page.renderer
    return <Renderer key={page.id} />
  })
  const extensionNav = (page: ClientSettingsPage): ReactNode => {
    const Icon = page.icon
    return (
      <ModalNavButton
        active={section === page.id}
        icon={Icon ? <Icon size={15} /> : <Puzzle size={15} />}
        label={page.label}
        onClick={() => setSection(page.id)}
        key={page.id}
      />
    )
  }

  return (
    <ConversationPaneOverlay className="program-modal-backdrop" onMouseDown={close}>
      <section className="program-modal" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}>
        <aside className="program-modal-sidebar">
          <div className="program-modal-sidebar-title">Settings</div>
          <label className="program-modal-search">
            <Search size={14} />
            <input value={query} placeholder="Search settings…" onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="program-modal-nav-group">
            <span>Personal</span>
            {visible('general permissions') && (
              <ModalNavButton active={section === 'general'} icon={<Settings2 size={15} />} label="General" onClick={() => setSection('general')} />
            )}
            {visible('workspaces projects folders') && (
              <ModalNavButton active={section === 'workspaces'} icon={<Folder size={15} />} label="Workspaces" onClick={() => setSection('workspaces')} />
            )}
            {builtInVisible('model') && (
              <ModalNavButton active={section === 'model'} icon={<Gauge size={15} />} label="Model & reasoning" onClick={() => setSection('model')} />
            )}
            {personalPages.filter(extensionVisible).map(extensionNav)}
          </div>
          {(visible('plugins extensions tools fibers') || (extensionGroups.get('Extensions') ?? []).some(extensionVisible)) && (
            <div className="program-modal-nav-group">
              <span>Extensions</span>
              {visible('plugins extensions tools fibers') && (
                <ModalNavButton active={section === 'plugins'} icon={<Puzzle size={15} />} label="Plugins" onClick={() => setSection('plugins')} />
              )}
              {(extensionGroups.get('Extensions') ?? []).filter(extensionVisible).map(extensionNav)}
            </div>
          )}
          {[...extensionGroups.entries()].filter(([group]) => group !== 'Extensions').map(([group, pages]) => {
            const visiblePages = pages.filter(extensionVisible)
            if (!visiblePages.length) return null
            return (
              <div className="program-modal-nav-group" key={group}>
                <span>{group}</span>
                {visiblePages.map(extensionNav)}
              </div>
            )
          })}
        </aside>

        <main className="program-modal-content">
          <header className="program-modal-titlebar">
            <h1>{sectionTitle}</h1>
            <button className="icon-button compact" type="button" aria-label="Close settings" onClick={close}><X size={15} /></button>
          </header>

          {section === 'general' && (
            <div className="settings-page">
              {generalSections}
              <section className="settings-section">
                <h2>Permissions</h2>
                <div className="settings-card permission-settings-card" role="radiogroup" aria-label="Permissions">
                  {permissionOptions.map((option) => {
                    const selected = option.mode === state.session.permissionMode
                    return (
                      <SettingsRow
                        label={option.label}
                        description={option.detail}
                        role="radio"
                        checked={selected}
                        onClick={() => session.setPermissionMode(option.mode)}
                        key={option.mode}
                      >
                        <SettingsRadioMark selected={selected} />
                      </SettingsRow>
                    )
                  })}
                </div>
              </section>

              <section className="settings-section">
                <h2>Session defaults</h2>
                <div className="settings-card">
                  <SettingsRow label="Workspace" description="Folder used when a new task starts">
                    <code>{state.session.workspace || 'Not selected'}</code>
                  </SettingsRow>
                  <SettingsRow label="Current model" description="Model selected for the next turn">
                    <span>{currentModel.model}</span>
                  </SettingsRow>
                  <SettingsRow label="Reasoning" description="Reasoning effort selected for the next turn">
                    <span>{currentModel.effort}</span>
                  </SettingsRow>
                </div>
              </section>
            </div>
          )}

          {section === 'workspaces' && (
            <div className="settings-page">
              <section className="settings-section">
                <div className="settings-card settings-project-card">
                  <ProjectSettings
                    projects={state.projects}
                    {...(state.activeProjectId ? { activeProjectId: state.activeProjectId } : {})}
                    workspace={state.session.workspace}
                    disabled={state.turn.tag !== 'idle'}
                    onSelect={(project) => session.selectProject(project)}
                    onSave={(project) => session.saveProject(project)}
                    onRemove={(id) => session.removeProject(id)}
                  />
                </div>
              </section>
            </div>
          )}

          {section === 'model' && (
            <ModelDefaultsSettings host={host} workspace={state.session.workspace} />
          )}

          {section === 'plugins' && (
            <div className="settings-page">
              <section className="settings-section">
                <PluginsPanel
                  plugins={state.harness?.program.plugins ?? []}
                  tools={state.harness?.program.tools ?? []}
                  diagnostics={browserProgram.diagnostics}
                  onToggle={togglePlugin}
                />
              </section>
            </div>
          )}
          {ExtensionRenderer && <ExtensionRenderer />}
        </main>
      </section>
    </ConversationPaneOverlay>
  )
}

function ActiveSettingsWorkspace({
  session,
  host,
  initialSection,
  togglePlugin,
  program,
  ui,
  close,
}: {
  session: ClientSessionService
  host: ClientHostService
  initialSection: 'general' | 'plugins'
  togglePlugin: (id: string, enabled: boolean) => Promise<unknown>
  program: ClientProgramService
  ui: ClientUiService
  close: () => void
}): ReactNode {
  const state = useSession(session)
  return (
    <SettingsWorkspace
      state={state}
      session={session}
      host={host}
      initialSection={initialSection}
      togglePlugin={togglePlugin}
      program={program}
      ui={ui}
      close={close}
    />
  )
}

function SettingsSurface({
  session,
  host,
  overlays,
  togglePlugin,
  program,
  ui,
}: ClientSurfaceProps & {
  session: ClientSessionService
  host: ClientHostService
  overlays: ClientOverlays
  togglePlugin: (id: string, enabled: boolean) => Promise<unknown>
  program: ClientProgramService
  ui: ClientUiService
}): ReactNode {
  const activeOverlay = useSyncExternalStore(overlays.subscribe, overlays.snapshot)
  const open = activeOverlay === 'settings'
  const close = () => overlays.close('settings')
  useOverlayDismiss(open, close)
  return open ? (
    <ActiveSettingsWorkspace
      session={session}
      host={host}
      initialSection="general"
      togglePlugin={togglePlugin}
      program={program}
      ui={ui}
      close={close}
    />
  ) : null
}

function PluginsSurface({
  session,
  host,
  overlays,
  togglePlugin,
  program,
  ui,
}: ClientSurfaceProps & {
  session: ClientSessionService
  host: ClientHostService
  overlays: ClientOverlays
  togglePlugin: (id: string, enabled: boolean) => Promise<unknown>
  program: ClientProgramService
  ui: ClientUiService
}): ReactNode {
  const activeOverlay = useSyncExternalStore(overlays.subscribe, overlays.snapshot)
  const open = activeOverlay === 'plugins'
  const close = () => overlays.close('plugins')
  useOverlayDismiss(open, close)

  return open ? (
    <ActiveSettingsWorkspace
      session={session}
      host={host}
      initialSection="plugins"
      togglePlugin={togglePlugin}
      program={program}
      ui={ui}
      close={close}
    />
  ) : null
}

function requestThreadId(params: Record<string, unknown>): string | undefined {
  if (typeof params.threadId === 'string') return params.threadId
  const thread = params.thread
  if (thread && typeof thread === 'object' && 'id' in thread && typeof thread.id === 'string') {
    return thread.id
  }
  const turn = params.turn
  if (turn && typeof turn === 'object' && 'threadId' in turn && typeof turn.threadId === 'string') {
    return turn.threadId
  }
  return undefined
}

function CodeBlockDispatcher({
  renderers,
  ...props
}: MarkdownCodeBlockProps & {
  renderers: readonly MarkdownCodeBlockRenderer[]
}): ReactNode {
  const match = resolveMarkdownCodeBlock(renderers, props.language)
  if (match) {
    const Renderer = match.component
    return <Renderer {...props} />
  }
  const className = props.language ? `language-${props.language}` : undefined
  return <pre><code className={className}>{props.code}</code></pre>
}

export function conversationWindowActive(
  visibilityState: DocumentVisibilityState,
  focused: boolean,
): boolean {
  return visibilityState === 'visible' && focused
}

function conversationWindowActiveSnapshot(): boolean {
  if (typeof document === 'undefined') return true
  return conversationWindowActive(document.visibilityState, document.hasFocus())
}

function conversationWindowActiveServerSnapshot(): boolean {
  return true
}

function subscribeConversationWindowActivity(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined
  window.addEventListener('focus', listener)
  window.addEventListener('blur', listener)
  document.addEventListener('visibilitychange', listener)
  return () => {
    window.removeEventListener('focus', listener)
    window.removeEventListener('blur', listener)
    document.removeEventListener('visibilitychange', listener)
  }
}

export function ConversationSurface({
  surface,
  session,
  markdown,
  ui,
  showUnscopedRequests = true,
  visible = true,
}: ClientSurfaceProps & {
  session: ClientSessionService
  markdown: ClientMarkdownService
  ui: ClientUiService
  showUnscopedRequests?: boolean
  visible?: boolean
}): ReactNode {
  const windowActive = useSyncExternalStore(
    subscribeConversationWindowActivity,
    conversationWindowActiveSnapshot,
    conversationWindowActiveServerSnapshot,
  )
  const activityVisible = visible && windowActive
  const state = useVisibleSession(session, activityVisible)
  const markdownState = useSyncExternalStore(markdown.subscribe, markdown.snapshot)
  useSyncExternalStore(ui.subscribe, ui.snapshot)
  const FileReviewAction = ui.component<FileReviewActionProps>(FILE_REVIEW_ACTION_COMPONENT)
  const CodeBlock = useMemo<ComponentType<MarkdownCodeBlockProps> | undefined>(() => {
    if (!markdownState.codeBlocks.length) return undefined
    const renderers = markdownState.codeBlocks
    return (props) => <CodeBlockDispatcher {...props} renderers={renderers} />
  }, [markdownState.codeBlocks])
  const feedRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollControllerRef = useRef<ConversationScrollController | null>(null)
  const previousThreadRef = useRef<string | undefined>(undefined)
  const previousTurnRef = useRef(state.turn.tag)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const requests = (state.harness?.pendingRequests ?? []).filter((request) => {
    const threadId = requestThreadId(request.params)
    return threadId ? threadId === state.threadId : showUnscopedRequests
  })
  const proposals = showUnscopedRequests ? state.harness?.program.proposals ?? [] : []

  useLayoutEffect(() => {
    if (!visible) return
    const feed = feedRef.current
    const content = contentRef.current
    if (!feed || !content) return
    const controller = new ConversationScrollController(feed, content, setShowJumpToLatest)
    scrollControllerRef.current = controller
    controller.start()
    return () => {
      controller.dispose()
      if (scrollControllerRef.current === controller) scrollControllerRef.current = null
    }
  }, [visible])

  useLayoutEffect(() => {
    if (!visible) return
    const feed = feedRef.current
    const controller = scrollControllerRef.current
    if (!feed || !controller) return
    const threadChanged = previousThreadRef.current !== state.threadId
    const previousTurn = previousTurnRef.current
    const turnStarted = previousTurn === 'idle' && state.turn.tag !== 'idle'
    const turnCompleted = previousTurn !== 'idle' && state.turn.tag === 'idle'
    previousThreadRef.current = state.threadId
    previousTurnRef.current = state.turn.tag
    const hasContent = state.activities.length > 0 || requests.length > 0 || proposals.length > 0
    const plan = conversationScrollPlan(
      hasContent,
      turnStarted,
    )
    if (conversationShouldScrollUpdate(
      threadChanged,
      turnStarted,
      turnCompleted,
      hasContent,
      controller.isFollowing(),
    )) {
      const behavior = threadChanged ? 'auto' : plan.behavior
      controller.follow(plan.target, behavior, threadChanged || turnStarted || !hasContent)
      return
    }
    controller.refresh()
  }, [state.activities, state.threadId, state.turn.tag, requests.length, proposals.length, visible])

  const jumpToLatest = (): void => {
    scrollControllerRef.current?.jumpToLatest()
  }

  return (
    <div className={`conversation-stage shell-conversation${windowActive ? '' : ' is-window-inactive'}`}>
      <div
        className="conversation-feed"
        ref={feedRef}
        tabIndex={-1}
        aria-label="Conversation"
        onPointerDown={(event) => {
          const target = event.target as HTMLElement
          if (target.closest('a, button, input, select, textarea, [contenteditable], [role="button"], [role="textbox"]')) return
          event.currentTarget.focus({ preventScroll: true })
        }}
      >
        <div className="conversation-feed-content" ref={contentRef}>
          {state.connectionError && <div className="connection-banner">{state.connectionError}</div>}
          {state.activities.length === 0 && !requests.length && surface.emptyState !== 'none' && (
            <div className="empty-state"><div className="empty-orbit"><Bot size={30} /><span /><span /></div></div>
          )}
          <MarkdownMathProvider renderer={markdownState.math} fileLinks={markdownState.fileLinks}>
            <ActivityTimeline
              items={state.activities}
              markdown={surface.markdown ?? true}
              active={state.turn.tag !== 'idle'}
              activeLabel={state.remoteStarting ? <RemoteSessionStartup state={state} visible={activityVisible} /> : undefined}
              waitingFor={threadIntervention(state.harness, state.threadId)}
              windowKey={state.threadId ?? 'new-thread'}
              hasEarlier={state.hasEarlierActivities}
              loadingEarlier={state.loadingEarlierActivities}
              loadEarlier={() => session.loadEarlierActivities()}
              {...(CodeBlock ? { codeBlock: CodeBlock } : {})}
              {...(FileReviewAction ? { reviewAction: FileReviewAction } : {})}
              session={session}
              visible={activityVisible}
            />
          </MarkdownMathProvider>
          {requests.map((request) => (
            <ApprovalRequest request={request} resolve={(id, result) => session.resolveRequest(id, result)} key={String(request.id)} />
          ))}
          {proposals.map((proposal) => (
            <ProgramProposalRequest proposal={proposal} resolve={(id, decision) => session.resolveProposal(id, decision)} key={proposal.id} />
          ))}
        </div>
      </div>
      <button
        className={`conversation-jump-latest${showJumpToLatest ? ' is-visible' : ''}`}
        type="button"
        aria-label="Jump to latest message"
        aria-hidden={!showJumpToLatest}
        tabIndex={showJumpToLatest ? 0 : -1}
        onClick={jumpToLatest}
      >
        <ArrowDown size={15} strokeWidth={1.8} />
      </button>
    </div>
  )
}

const uiSurfacesClient: BrowserPlugin = (ctx) => {
  const session = ctx.clientSession
  const ui = ctx.clientUi
  const markdown = ctx.clientMarkdown

  const overlays = ui.overlays
  const togglePlugin = (id: string, enabled: boolean): Promise<unknown> => (
    ctx.clientHost.command('program.plugin.setEnabled', { id, enabled })
  )
  ctx.effect(() => {
    const shortcut = (event: globalThis.KeyboardEvent): void => {
      if (
        event.key.toLocaleLowerCase() !== 'p'
        || !event.shiftKey
        || (!event.metaKey && !event.ctrlKey)
      ) return
      event.preventDefault()
      if (!event.repeat) overlays.toggle('plugins')
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, 'ui-surfaces.pluginsShortcut')
  ctx.effect(() => {
    const onOpenSettings = window.__ALTO_DESKTOP__?.onOpenSettings
    return onOpenSettings
      ? onOpenSettings(() => overlays.open('settings'))
      : () => undefined
  }, 'ui-surfaces.nativeSettings')
  const Settings = (props: ClientSurfaceProps) => (
    <SettingsSurface
      {...props}
      session={session}
      host={ctx.clientHost}
      overlays={overlays}
      togglePlugin={togglePlugin}
      program={ctx.clientProgram}
      ui={ui}
    />
  )
  const Plugins = (props: ClientSurfaceProps) => (
    <PluginsSurface
      {...props}
      session={session}
      host={ctx.clientHost}
      overlays={overlays}
      togglePlugin={togglePlugin}
      program={ctx.clientProgram}
      ui={ui}
    />
  )
  const Conversation = (props: ClientSurfaceProps) => (
    <ConversationSurface {...props} session={session} markdown={markdown} ui={ui} />
  )
  const ConversationComponent = (props: ConversationComponentProps) => (
    <ConversationSurface {...props} markdown={markdown} ui={ui} />
  )
  const ContributionRenderer = (props: ClientContributionProps) => (
    <Contribution {...props} command={ctx.clientHost.command} />
  )

  ui.registerStyle(ctx, 'default-interface', String(defaultStyles))
  ui.registerStyle(ctx, 'user-input-requests', String(inputRequestStyles))
  ui.registerStyle(ctx, 'model-defaults', String(modelDefaultsStyles))
  ui.registerContributionRenderer(ctx, ContributionRenderer)
  ui.registerComponent(ctx, CONVERSATION_COMPONENT, ConversationComponent)
  ui.registerSurface(ctx, 'default-settings', Settings)
  ui.registerSurface(ctx, 'default-plugins', Plugins)
  ui.registerSurface(ctx, 'default-conversation', Conversation)
}

uiSurfacesClient.inject = ['clientHost', 'clientUi', 'clientSession', 'clientMarkdown', 'clientProgram']
uiSurfacesClient.resources = {
  provides: {
    surfaces: ['default-settings', 'default-plugins', 'default-conversation'],
    components: [CONVERSATION_COMPONENT],
  },
}

export default uiSurfacesClient
