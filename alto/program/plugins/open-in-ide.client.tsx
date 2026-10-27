import { SquareCode, X } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { BrowserPlugin, ClientHostService } from '../../src/client/plugin-api.js'
import { clientStyles } from '../../src/client/plugin-api.js'
import type { ComposerActionProps } from './composer-actions.js'
import type { ClientEditorService } from './editor-pane-api.js'
import type { ClientWorkContextsService } from './work-contexts-client-api.js'
import { IDE_OPTIONS, OPEN_IN_IDE, isIdeId, type IdeId } from './open-in-ide-api.js'
import { SettingsRow } from './ui/settings.js'
import styles from './open-in-ide.css'

const STORAGE_KEY = 'alto.open-in-ide'

export class IdePreference {
  private ide: IdeId
  private readonly listeners = new Set<() => void>()

  constructor(fallback: IdeId = 'vscode', private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    this.ide = fallback
    try {
      const stored = storage?.getItem(STORAGE_KEY)
      if (isIdeId(stored)) this.ide = stored
    } catch { /* Keep the configured default when storage is unavailable. */ }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  snapshot = (): IdeId => this.ide
  set(ide: IdeId): void {
    if (ide === this.ide) return
    this.ide = ide
    try { this.storage?.setItem(STORAGE_KEY, ide) } catch { /* Still apply for this window. */ }
    for (const listener of this.listeners) listener()
  }
}

export type EditorDestination = 'pane' | 'external'

export class EditorDestinationPreference {
  private value: EditorDestination
  private readonly listeners = new Set<() => void>()
  constructor(fallback: EditorDestination = 'pane', private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    this.value = fallback
    try {
      const stored = storage?.getItem('alto.editor.destination')
      if (stored === 'pane' || stored === 'external') this.value = stored
    } catch { /* Keep the configured default. */ }
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  snapshot = (): EditorDestination => this.value
  set(value: EditorDestination): void {
    if (this.value === value) return
    this.value = value
    try { this.storage?.setItem('alto.editor.destination', value) } catch { /* Keep the choice in memory. */ }
    for (const listener of this.listeners) listener()
  }
}

export function OpenInIdeButton({ session, host, contexts, preference, destination, editors }: ComposerActionProps & {
  host: ClientHostService
  contexts: ClientWorkContextsService
  preference: IdePreference
  destination: EditorDestinationPreference
  editors: ClientEditorService
}): ReactNode {
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  const work = useSyncExternalStore(contexts.subscribe, contexts.snapshot)
  const selected = state.threadId ? work.threadTargets[state.threadId] : undefined
  const ideId = useSyncExternalStore(preference.subscribe, preference.snapshot)
  const target = useSyncExternalStore(destination.subscribe, destination.snapshot)
  const ide = IDE_OPTIONS.find((option) => option.id === ideId)!
  const workspace = selected?.location ?? state.session.workspace
  const remote = Boolean(state.remoteLocation || (selected && selected.kind !== 'local'))
  const unavailable = target === 'pane' ? editors.unavailable(session) : remote ? 'Remote workspaces cannot be opened in a local IDE yet.'
    : state.projectScope === 'unscoped' || !workspace ? 'Choose a workspace for this chat first.' : undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const request = useRef(0)
  const pending = useRef(false)
  useEffect(() => {
    setError(undefined)
    setBusy(false)
    pending.current = false
    return () => { request.current++ }
  }, [session, workspace, state.threadId, ideId, target])

  const open = async () => {
    if (pending.current || unavailable) return
    pending.current = true
    const revision = ++request.current
    setBusy(true)
    setError(undefined)
    try {
      if (target === 'pane') editors.open(session)
      else await host.call(OPEN_IN_IDE, { ide: ideId, workspace, remote, ...(state.threadId ? { threadId: state.threadId } : {}) })
    } catch (error) {
      if (request.current === revision) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (request.current === revision) {
        pending.current = false
        setBusy(false)
      }
    }
  }

  return <div className="open-in-ide-control">
    <button type="button" className="composer-workspace-trigger open-in-ide-button"
      aria-label={target === 'pane' ? 'Open Neovim pane' : `Open in ${ide.label}`} aria-busy={busy}
      title={unavailable ?? (target === 'pane' ? `Open Neovim pane (⌘E)\n${workspace}` : `Open in ${ide.label} in a new window\n${workspace}`)}
      disabled={busy || !state.connected || Boolean(unavailable)} onClick={() => void open()}>
      <SquareCode size={14} strokeWidth={1.7} />
      <span>Editor</span>
    </button>
    {error && <div className={`${clientStyles.floatingPanel} open-in-ide-error`} role="alert">
      <span>{error}</span>
      <button type="button" className={clientStyles.iconButton} aria-label="Dismiss IDE error" onClick={() => setError(undefined)}><X size={14} /></button>
    </div>}
  </div>
}

export function IdeSettings({ preference, destination }: { preference: IdePreference; destination: EditorDestinationPreference }): ReactNode {
  const target = useSyncExternalStore(destination.subscribe, destination.snapshot)
  const selected = useSyncExternalStore(preference.subscribe, preference.snapshot)
  return <section className="settings-section">
    <h2>Editor</h2>
    <div className="settings-card">
      <SettingsRow as="label" label="Editor button" description="Choose where the composer’s Editor button opens this chat’s workspace. ⌘E always opens a Neovim pane.">
        <select aria-label="Editor button destination" value={target} onChange={(event) => {
          if (event.target.value === 'pane' || event.target.value === 'external') destination.set(event.target.value)
        }}>
          <option value="pane">Neovim pane</option>
          <option value="external">External editor</option>
        </select>
      </SettingsRow>
      <SettingsRow as="label" label="External editor" description="Used when the Editor button is set to open an external editor.">
        <select aria-label="Preferred IDE" value={selected} onChange={(event) => {
          if (isIdeId(event.target.value)) preference.set(event.target.value)
        }}>
          {IDE_OPTIONS.map((ide) => <option value={ide.id} key={ide.id}>{ide.label}</option>)}
        </select>
      </SettingsRow>
    </div>
  </section>
}

const openInIde: BrowserPlugin<{ ide?: IdeId; destination?: EditorDestination }> = (ctx, config) => {
  const host = ctx.clientHost
  const contexts = ctx.clientWorkContexts
  let storage: Storage | undefined
  try { storage = window.localStorage } catch { /* The preference can remain in memory. */ }
  const preference = new IdePreference(isIdeId(config?.ide) ? config.ide : 'vscode', storage)
  const destination = new EditorDestinationPreference(config?.destination === 'external' ? 'external' : 'pane', storage)
  const editors = ctx.clientEditor
  ctx.clientComposer.actions.register(ctx, {
    id: 'open-in-ide', order: 100,
    component: (props) => <OpenInIdeButton {...props} host={host} contexts={contexts} preference={preference} destination={destination} editors={editors} />,
  })
  ctx.clientUi.registerSettingsPage(ctx, {
    id: 'open-in-ide', label: 'Editor', placement: 'general', order: 30,
    keywords: ['IDE', 'editor', 'code', 'cursor', 'zed', 'workspace', 'neovim', 'pane'],
    renderer: () => <IdeSettings preference={preference} destination={destination} />,
  })
  ctx.clientUi.registerStyle(ctx, 'open-in-ide', String(styles))
}

openInIde.inject = ['clientEditor', 'clientComposer', 'clientHost', 'clientUi', 'clientWorkContexts']
export default openInIde
