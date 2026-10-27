import * as Cordis from 'cordis'
import {
  Context,
  type Fiber,
  type Plugin,
} from 'cordis'
import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import type {
  JsonValue,
  ProgramPluginView,
  UiShellNode,
  UiSnapshot,
  UiSurface,
} from '../shared/protocol.js'
import type {
  ClientDraft,
  ClientComponentRegistration,
  ClientComponentRenderer,
  ClientContributionRegistration,
  ClientContributionRenderer,
  ClientHostService,
  ClientNativeTerminalsService,
  ClientNativeViewsService,
  ClientOverlayOptions,
  ClientOverlays,
  ClientPluginMetadata,
  ClientProgramDiagnostic,
  ClientProgramService,
  ClientProgramSnapshot,
  ClientRootRegistration,
  ClientRootRenderer,
  ClientSettingsPage,
  ClientSettingsPageRegistration,
  ClientSubmitMiddleware,
  ClientSubmitMiddlewareOptions,
  ClientSubmitRequest,
  ClientSubmitRegistration,
  ClientStyleRegistration,
  ClientSurfaceRegistration,
  ClientSurfaceRenderer,
  ClientUiService,
} from './plugin-api.js'
import { clientHost } from './host.js'
import { clientNativeTerminals } from './native-terminals.js'
import { clientNativeViews } from './native-views.js'

declare global {
  // Browser bundles emitted by ProgramRuntime import these exact host instances.
  var __ALTO_BROWSER_HOST__: {
    react: typeof React
    jsxRuntime: typeof JsxRuntime
    cordis: typeof Cordis
  } | undefined
}

globalThis.__ALTO_BROWSER_HOST__ = {
  react: React,
  jsxRuntime: JsxRuntime,
  cordis: Cordis,
}

interface RegisteredRenderer {
  renderer: ClientSurfaceRenderer
  owner: string
}

interface RegisteredComponentRenderer {
  renderer: ClientComponentRenderer<any>
  owner: string
}

interface RegisteredContributionRenderer {
  renderer: ClientContributionRenderer
  owner: string
}

interface RegisteredRootRenderer {
  renderer: ClientRootRenderer
  owner: string
}

interface RegisteredSettingsPage {
  page: ClientSettingsPage
  owner: string
}

interface RegisteredStyle {
  css: string
  element?: HTMLStyleElement
  owner: string
}

interface RegisteredSubmitMiddleware {
  middleware: ClientSubmitMiddleware
  owner: string
  activeTurn: boolean
}

export class OverlayStore implements ClientOverlays {
  private active: string | undefined
  private occludesNativeViews = false
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): string | undefined => this.active

  nativeViewsOccluded = (): boolean => this.occludesNativeViews

  open(id: string, options?: ClientOverlayOptions): void {
    this.set(id, options?.occludesNativeViews ?? true)
  }

  toggle(id: string, options?: ClientOverlayOptions): void {
    if (this.active === id) this.set(undefined, false)
    else this.set(id, options?.occludesNativeViews ?? true)
  }

  close(id: string): void {
    if (this.active === id) this.set(undefined, false)
  }

  closeAll(): void {
    this.set(undefined, false)
  }

  private set(next: string | undefined, occludesNativeViews: boolean): void {
    if (next === this.active && occludesNativeViews === this.occludesNativeViews) return
    this.active = next
    this.occludesNativeViews = Boolean(next) && occludesNativeViews
    for (const listener of this.listeners) listener()
  }
}

export class ClientUiRegistry implements ClientUiService {
  readonly overlays = new OverlayStore()

  private readonly surfaces = new Map<string, RegisteredRenderer>()
  private readonly kinds = new Map<string, RegisteredRenderer>()
  private readonly components = new Map<string, RegisteredComponentRenderer>()
  private contribution?: RegisteredContributionRenderer
  private readonly roots = new Map<string, RegisteredRootRenderer>()
  private readonly settings = new Map<string, RegisteredSettingsPage>()
  private readonly styles = new Map<string, RegisteredStyle>()
  private readonly styleOrder: string[] = []
  private readonly submitMiddlewares: RegisteredSubmitMiddleware[] = []
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private batchDepth = 0
  private batchChanged = false
  private batchView?: {
    surfaces: Map<string, ClientSurfaceRenderer>
    kinds: Map<string, ClientSurfaceRenderer>
    components: Map<string, ClientComponentRenderer<any>>
    contribution: ClientContributionRenderer | undefined
    roots: ReadonlyArray<{ id: string; renderer: ClientRootRenderer }>
    settings: readonly ClientSettingsPage[]
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): number => this.revision

  renderer(surface: UiSurface): ClientSurfaceRenderer | undefined {
    if (this.batchView) {
      return this.batchView.surfaces.get(surface.id) ?? this.batchView.kinds.get(surface.kind)
    }
    return this.surfaces.get(surface.id)?.renderer
      ?? this.kinds.get(surface.kind)?.renderer
  }

  component<Props>(id: string): ClientComponentRenderer<Props> | undefined {
    if (this.batchView) return this.batchView.components.get(id)
    return this.components.get(id)?.renderer as ClientComponentRenderer<Props> | undefined
  }

  contributionRenderer(): ClientContributionRenderer | undefined {
    if (this.batchView) return this.batchView.contribution
    return this.contribution?.renderer
  }

  rootRenderers(): readonly Readonly<{ id: string; renderer: ClientRootRenderer }>[] {
    if (this.batchView) return this.batchView.roots
    return [...this.roots.entries()].map(([id, entry]) => ({ id, renderer: entry.renderer }))
  }

  settingsPages(): readonly ClientSettingsPage[] {
    if (this.batchView) return this.batchView.settings
    return [...this.settings.values()]
      .map((entry) => entry.page)
      .sort((left, right) => (
        (left.order ?? 100) - (right.order ?? 100)
        || left.label.localeCompare(right.label)
      ))
  }

  hasSurface(id: string): boolean {
    if (this.batchView) return this.batchView.surfaces.has(id)
    return this.surfaces.has(id)
  }

  hasComponent(id: string): boolean {
    if (this.batchView) return this.batchView.components.has(id)
    return this.components.has(id)
  }

  hasRoot(id: string): boolean {
    if (this.batchView) return this.batchView.roots.some((entry) => entry.id === id)
    return this.roots.has(id)
  }

  registerSurface(
    owner: Context,
    id: string,
    renderer: ClientSurfaceRenderer,
  ): ClientSurfaceRegistration {
    return this.registerRenderer(owner, this.surfaces, id, renderer, 'surface')
  }

  registerKind(
    owner: Context,
    kind: string,
    renderer: ClientSurfaceRenderer,
  ): ClientSurfaceRegistration {
    return this.registerRenderer(owner, this.kinds, kind, renderer, 'surface kind')
  }

  registerComponent<Props>(
    owner: Context,
    id: string,
    renderer: ClientComponentRenderer<Props>,
  ): ClientComponentRegistration<Props> {
    return this.registerRenderer(
      owner,
      this.components,
      id,
      renderer as ClientComponentRenderer<any>,
      'component',
    ) as ClientComponentRegistration<Props>
  }

  registerContributionRenderer(
    owner: Context,
    renderer: ClientContributionRenderer,
  ): ClientContributionRegistration {
    const entry: RegisteredContributionRenderer = { renderer, owner: owner.fiber.name }
    let active = false
    const dispose = owner.effect(() => {
      if (this.contribution) throw new Error('a client contribution renderer is already registered')
      active = true
      this.contribution = entry
      this.emitChanged()
      return () => {
        active = false
        if (this.contribution === entry) delete this.contribution
        this.emitChanged()
      }
    }, 'clientUi.registerContributionRenderer()')

    return {
      update: (next) => {
        if (!active) throw new Error('the client contribution renderer is not active')
        entry.renderer = next
        this.emitChanged()
      },
      dispose: async () => dispose(),
    }
  }

  registerRoot(
    owner: Context,
    id: string,
    renderer: ClientRootRenderer,
  ): ClientRootRegistration {
    return this.registerRenderer(owner, this.roots, id, renderer, 'root renderer')
  }

  registerSettingsPage(
    owner: Context,
    page: ClientSettingsPage,
  ): ClientSettingsPageRegistration {
    const id = page.id.trim()
    if (!id) throw new Error('client settings page id cannot be empty')
    if (!page.label.trim()) throw new Error(`client settings page "${id}" needs a label`)
    const entry: RegisteredSettingsPage = { page: { ...page, id }, owner: owner.fiber.name }
    let active = false
    const dispose = owner.effect(() => {
      if (this.settings.has(id)) throw new Error(`client settings page "${id}" is already registered`)
      active = true
      this.settings.set(id, entry)
      this.emitChanged()
      return () => {
        active = false
        if (this.settings.get(id) === entry) this.settings.delete(id)
        this.emitChanged()
      }
    }, `clientUi.registerSettingsPage(${JSON.stringify(id)})`)

    return {
      update: (next) => {
        if (!active) throw new Error(`client settings page "${id}" is not active`)
        if (next.id !== id) throw new Error('a client settings page cannot change its id')
        if (!next.label.trim()) throw new Error(`client settings page "${id}" needs a label`)
        entry.page = next
        this.emitChanged()
      },
      dispose: async () => dispose(),
    }
  }

  registerStyle(
    owner: Context,
    id: string,
    css: string,
  ): ClientStyleRegistration {
    const entry: RegisteredStyle = { css, owner: owner.fiber.name }
    let active = false
    const dispose = owner.effect(() => {
      if (this.styles.has(id)) throw new Error(`client style "${id}" is already registered`)
      active = true
      this.styles.set(id, entry)
      this.mountStyle(id, entry)
      this.emitChanged()
      return () => {
        active = false
        if (this.styles.get(id) === entry) this.styles.delete(id)
        entry.element?.remove()
        delete entry.element
        this.emitChanged()
      }
    }, `clientUi.registerStyle(${JSON.stringify(id)})`)

    return {
      update: (next) => {
        if (!active) throw new Error(`client style "${id}" is not active`)
        entry.css = next
        if (entry.element) entry.element.textContent = next
        this.emitChanged()
      },
      dispose: async () => dispose(),
    }
  }

  registerSubmitMiddleware(
    owner: Context,
    middleware: ClientSubmitMiddleware,
    options: ClientSubmitMiddlewareOptions = {},
  ): ClientSubmitRegistration {
    const entry = {
      middleware,
      owner: owner.fiber.name,
      activeTurn: options.activeTurn ?? false,
    }
    const dispose = owner.effect(() => {
      this.submitMiddlewares.push(entry)
      this.emitChanged()
      return () => {
        const index = this.submitMiddlewares.indexOf(entry)
        if (index >= 0) this.submitMiddlewares.splice(index, 1)
        this.emitChanged()
      }
    }, 'clientUi.registerSubmitMiddleware()')

    return { dispose: async () => dispose() }
  }

  canSubmitDuringTurn(): boolean {
    return this.submitMiddlewares.some((entry) => entry.activeTurn)
  }

  async submit(
    draft: ClientDraft,
    fallback: (draft: ClientDraft) => Promise<void>,
    request: ClientSubmitRequest = { mode: 'queue' },
  ): Promise<void> {
    const middlewares = [...this.submitMiddlewares]
    const dispatch = async (index: number, nextDraft: ClientDraft): Promise<void> => {
      const entry = middlewares[index]
      if (!entry) {
        await fallback(nextDraft)
        return
      }
      await entry.middleware(
        nextDraft,
        (forwarded) => dispatch(index + 1, forwarded),
        request,
      )
    }
    await dispatch(0, draft)
  }

  async batch<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.batchDepth === 0) {
      // Host events can render React while fibers are between disposal and
      // activation. Keep reads on the published components until the batch
      // finishes, so those renders cannot unmount panes through a missing UI.
      this.batchView = {
        surfaces: new Map([...this.surfaces].map(([id, entry]) => [id, entry.renderer])),
        kinds: new Map([...this.kinds].map(([id, entry]) => [id, entry.renderer])),
        components: new Map([...this.components].map(([id, entry]) => [id, entry.renderer])),
        contribution: this.contribution?.renderer,
        roots: this.rootRenderers(),
        settings: this.settingsPages(),
      }
    }
    this.batchDepth += 1
    try {
      return await operation()
    } finally {
      this.batchDepth -= 1
      if (this.batchDepth === 0) delete this.batchView
      if (this.batchDepth === 0 && this.batchChanged) {
        this.batchChanged = false
        this.flush()
      }
    }
  }

  private registerRenderer<Key extends string, Renderer>(
    owner: Context,
    registry: Map<Key, { renderer: Renderer; owner: string }>,
    key: Key,
    renderer: Renderer,
    label: string,
  ): { update(renderer: Renderer): void; dispose(): Promise<void> } {
    const entry = { renderer, owner: owner.fiber.name }
    let active = false
    const dispose = owner.effect(() => {
      if (registry.has(key)) throw new Error(`client ${label} "${key}" is already registered`)
      active = true
      registry.set(key, entry)
      this.emitChanged()
      return () => {
        active = false
        if (registry.get(key) === entry) registry.delete(key)
        this.emitChanged()
      }
    }, `clientUi.register(${JSON.stringify(key)})`)

    return {
      update: (next) => {
        if (!active) throw new Error(`client ${label} "${key}" is not active`)
        entry.renderer = next
        this.emitChanged()
      },
      dispose: async () => dispose(),
    }
  }

  private mountStyle(id: string, entry: RegisteredStyle): void {
    if (typeof document === 'undefined') return
    const element = document.createElement('style')
    element.dataset.cordisPluginStyle = id
    element.textContent = entry.css

    let index = this.styleOrder.indexOf(id)
    if (index < 0) {
      index = this.styleOrder.push(id) - 1
    }
    const successor = this.styleOrder
      .slice(index + 1)
      .map((nextId) => this.styles.get(nextId)?.element)
      .find((candidate) => candidate !== undefined)
    if (successor) document.head.insertBefore(element, successor)
    else document.head.append(element)
    entry.element = element
  }

  private emitChanged(): void {
    if (this.batchDepth > 0) {
      this.batchChanged = true
      return
    }
    this.flush()
  }

  private flush(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}

interface ClientModule {
  default: Plugin
}

interface CompiledClientPlugin {
  id: string
  module: string
  hash: string
  plugin: Plugin
  metadata: ClientPluginMetadata
}

interface DesiredEntry extends ProgramPluginView {
  children: DesiredEntry[]
}

interface LiveComponent extends CompiledClientPlugin {
  fiber: Fiber
  configKey: string
}

interface LiveEntry {
  id: string
  scopeKey: string
  scopeFiber: Fiber
  component?: LiveComponent
  children: Map<string, LiveEntry>
}

export type BrowserProgramState = ClientProgramSnapshot

type ClientModuleLoader = (url: string) => Promise<ClientModule>

const entryScope: Plugin = () => undefined

function configKey(config: JsonValue): string {
  return JSON.stringify(config)
}

function entryScopeKey(entry: ProgramPluginView): string {
  return JSON.stringify({
    isolate: Object.entries(entry.isolate).sort(([left], [right]) => left.localeCompare(right)),
    intercept: Object.entries(entry.intercept).sort(([left], [right]) => left.localeCompare(right)),
  })
}

function pluginTree(plugins: ProgramPluginView[]): DesiredEntry[] {
  const entries = new Map<string, DesiredEntry>()
  for (const plugin of plugins) entries.set(plugin.id, { ...plugin, children: [] })
  const roots: DesiredEntry[] = []
  for (const plugin of plugins) {
    const entry = entries.get(plugin.id)
    if (!entry) continue
    const parent = plugin.parentId ? entries.get(plugin.parentId) : undefined
    if (parent) parent.children.push(entry)
    else roots.push(entry)
  }
  return roots
}

function isPlugin(value: unknown): value is Plugin {
  return typeof value === 'function'
    || (typeof value === 'object' && value !== null && typeof (value as { apply?: unknown }).apply === 'function')
}

function pluginInject(plugin: Plugin): string[] {
  const inject = plugin.inject
  if (!inject) return []
  return Array.isArray(inject) ? [...inject] as string[] : Object.keys(inject)
}

function pluginProvides(plugin: Plugin): string[] {
  const provide = plugin.provide
  if (!provide) return []
  return Array.isArray(provide) ? [...provide] : [provide]
}

interface ActiveShellResources {
  outlets: Set<string>
  slots: Set<string>
  surfaces: Set<string>
}

function collectShellResources(
  node: UiShellNode,
  regions: ReadonlyMap<string, UiShellNode>,
  resources: ActiveShellResources,
): void {
  switch (node.type) {
    case 'box':
      for (const child of node.children) collectShellResources(child, regions, resources)
      break
    case 'outlet': {
      resources.outlets.add(node.name)
      const replacement = regions.get(node.name)
      if (replacement) collectShellResources(replacement, regions, resources)
      else if (node.fallback) collectShellResources(node.fallback, regions, resources)
      break
    }
    case 'slot':
      resources.slots.add(node.name)
      break
    case 'surface':
      resources.surfaces.add(node.id)
      break
    default:
      break
  }
}

export class BrowserProgramRuntime implements ClientProgramService {
  readonly ui = new ClientUiRegistry()

  private readonly root = new Context()
  private readonly live = new Map<string, LiveEntry>()
  private readonly realms = new Map<string, symbol>()
  private readonly listeners = new Set<() => void>()
  private readonly load: ClientModuleLoader
  private serviceFiber?: Fiber
  private desired: DesiredEntry[] = []
  private compiled = new Map<string, CompiledClientPlugin>()
  private queue: Promise<void> = Promise.resolve()
  private state: BrowserProgramState = {
    revision: 0,
    status: 'idle',
    plugins: [],
    diagnostics: [],
  }

  constructor(
    load: ClientModuleLoader = async (url) => import(/* @vite-ignore */ url),
    private readonly host: ClientHostService = clientHost,
    private readonly nativeViews: ClientNativeViewsService = clientNativeViews,
    private readonly nativeTerminals: ClientNativeTerminalsService = clientNativeTerminals,
  ) {
    this.load = load
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): BrowserProgramState => this.state

  reconcile(
    revision: number,
    plugins: ProgramPluginView[],
    contract?: {
      ui: UiSnapshot
      extensions: Readonly<Record<string, JsonValue>>
      extensionMethods?: readonly string[]
    },
  ): Promise<void> {
    const run = this.queue.then(() => this.reconcileInternal(revision, plugins, contract))
    this.queue = run.catch(() => undefined)
    return run
  }

  async dispose(): Promise<void> {
    await this.queue
    await this.ui.batch(async () => {
      for (const live of [...this.live.values()].reverse()) await live.scopeFiber.dispose()
      this.live.clear()
    })
    await this.serviceFiber?.dispose()
    delete this.serviceFiber
    this.desired = []
    this.compiled.clear()
    this.setState({
      revision: this.state.revision,
      status: 'idle',
      plugins: [],
      diagnostics: [],
    })
  }

  private async reconcileInternal(
    revision: number,
    plugins: ProgramPluginView[],
    contract?: {
      ui: UiSnapshot
      extensions: Readonly<Record<string, JsonValue>>
      extensionMethods?: readonly string[]
    },
  ): Promise<void> {
    await this.start()
    if (revision === this.state.revision && this.state.status === 'active') return
    this.setState({
      revision,
      status: 'loading',
      plugins: [...this.compiled.values()].map(({ metadata }) => metadata),
      diagnostics: [],
    })
    const nextDesired = pluginTree(plugins)
    const previousDesired = this.desired
    const previousCompiled = this.compiled

    let diagnostics: ClientProgramDiagnostic[] = []
    try {
      const nextCompiled = await this.compile(plugins)
      await this.ui.batch(async () => {
        await this.reconcileEntries(this.root, this.live, nextDesired, nextCompiled)
        await this.settleEntries(this.live)
      })
      const activeCompiled = this.activeCompiled(nextCompiled)
      diagnostics = this.validateDependencies(nextCompiled, activeCompiled)
      if (contract) {
        diagnostics = [
          ...diagnostics,
          ...this.validateResources(
            activeCompiled,
            contract.ui,
            contract.extensions,
            contract.extensionMethods,
          ),
        ]
        const resourceErrors = diagnostics.filter(({ severity }) => severity === 'error')
        if (resourceErrors.length) {
          throw new Error(resourceErrors.map(({ message }) => message).join('; '))
        }
      }
      this.desired = nextDesired
      this.compiled = nextCompiled
    } catch (error) {
      try {
        await this.ui.batch(() => this.reconcileEntries(
          this.root,
          this.live,
          previousDesired,
          previousCompiled,
        ))
      } catch (restoreError) {
        const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError)
        console.error(`Browser plugin rollback failed: ${restoreMessage}`)
      }
      const message = error instanceof Error ? error.message : String(error)
      this.setState({
        revision,
        status: 'failed',
        error: message,
        plugins: [...previousCompiled.values()].map(({ metadata }) => metadata),
        diagnostics: [{ severity: 'error', message }],
      })
      throw new Error(`Browser program activation failed; the previous UI was restored: ${message}`, {
        cause: error,
      })
    }

    this.setState({
      revision,
      status: 'active',
      plugins: [...this.compiled.values()].map(({ metadata }) => metadata),
      diagnostics,
    })
  }

  validate(
    ui: UiSnapshot,
    extensions: Readonly<Record<string, JsonValue>>,
    extensionMethods: readonly string[] = [],
  ): ClientProgramDiagnostic[] {
    const activeCompiled = this.activeCompiled(this.compiled)
    return [
      ...this.validateDependencies(this.compiled, activeCompiled),
      ...this.validateResources(activeCompiled, ui, extensions, extensionMethods),
    ]
  }

  private async start(): Promise<void> {
    if (this.serviceFiber) return
    const registry = this.ui
    const host = this.host
    const nativeViews = this.nativeViews
    const nativeTerminals = this.nativeTerminals
    const service: Plugin = (ctx) => {
      ctx.provide('clientUi', registry)
      ctx.provide('clientHost', host)
      ctx.provide('clientNativeViews', nativeViews)
      ctx.provide('clientNativeTerminals', nativeTerminals)
      ctx.provide('clientProgram', this)
    }
    service.provide = [
      'clientUi',
      'clientHost',
      'clientNativeViews',
      'clientNativeTerminals',
      'clientProgram',
    ]
    this.serviceFiber = await this.root.plugin(service)
  }

  private async compile(plugins: ProgramPluginView[]): Promise<Map<string, CompiledClientPlugin>> {
    const compiled = new Map<string, CompiledClientPlugin>()
    await Promise.all(plugins.map(async (entry) => {
      if (!entry.effectiveEnabled || !entry.client) return
      const previous = this.compiled.get(entry.id)
      if (
        previous?.hash === entry.client.hash
        && previous.module === entry.client.module
        && previous.metadata.protocolVersion === entry.protocolVersion
        && previous.metadata.serverModule === entry.module
      ) {
        compiled.set(entry.id, previous)
        return
      }
      const module = await this.load(entry.client.url)
      if (!isPlugin(module.default)) {
        throw new Error(`browser module "${entry.client.module}" must default-export a Cordis plugin`)
      }
      const browserPlugin = module.default as import('./plugin-api.js').BrowserPlugin
      const protocolVersion = browserPlugin.protocolVersion ?? 1
      if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
        throw new Error(`browser plugin "${entry.id}" has an invalid protocol version`)
      }
      if (protocolVersion !== entry.protocolVersion) {
        throw new Error(
          `browser plugin "${entry.id}" implements protocol ${protocolVersion}, but the profile requires ${entry.protocolVersion}`,
        )
      }
      compiled.set(entry.id, {
        id: entry.id,
        module: entry.client.module,
        hash: entry.client.hash,
        plugin: module.default,
        metadata: {
          id: entry.id,
          module: entry.client.module,
          hash: entry.client.hash,
          ...(entry.module ? { serverModule: entry.module } : {}),
          protocolVersion,
          inject: pluginInject(module.default),
          provides: pluginProvides(module.default),
          resources: structuredClone(
            browserPlugin.resources ?? {},
          ),
        },
      })
    }))
    return compiled
  }

  private validateDependencies(
    compiled: Map<string, CompiledClientPlugin>,
    active: Map<string, CompiledClientPlugin>,
  ): ClientProgramDiagnostic[] {
    const available = new Set([
      'clientUi',
      'clientHost',
      'clientNativeViews',
      'clientNativeTerminals',
      'clientProgram',
    ])
    for (const { metadata } of active.values()) {
      for (const service of metadata.provides) available.add(service)
    }

    const diagnostics: ClientProgramDiagnostic[] = []
    for (const { metadata } of compiled.values()) {
      for (const service of metadata.inject) {
        if (available.has(service)) continue
        diagnostics.push({
          pluginId: metadata.id,
          severity: 'warning',
          message: `Browser plugin "${metadata.id}" is waiting for service "${service}"`,
        })
      }
    }
    return diagnostics
  }

  private validateResources(
    compiled: Map<string, CompiledClientPlugin>,
    snapshot: UiSnapshot,
    extensions: Readonly<Record<string, JsonValue>>,
    extensionMethods: readonly string[] = [],
  ): ClientProgramDiagnostic[] {
    const diagnostics: ClientProgramDiagnostic[] = []
    const surfaces = new Map(snapshot.surfaces.map((surface) => [surface.id, surface]))
    const regions = new Map(snapshot.regions.map((region) => [region.outlet, region.root]))
    const shellResources: ActiveShellResources = {
      outlets: new Set(),
      slots: new Set(),
      surfaces: new Set(),
    }

    if (snapshot.shell) {
      collectShellResources(snapshot.shell.root, regions, shellResources)
      for (const region of snapshot.regions) {
        if (shellResources.outlets.has(region.outlet)) continue
        diagnostics.push({
          severity: 'error',
          message: `UI region "${region.id}" targets missing outlet "${region.outlet}"`,
        })
      }
    } else if (snapshot.regions.length) {
      diagnostics.push({ severity: 'error', message: 'UI regions are active without a shell' })
    }

    for (const id of shellResources.surfaces) {
      const surface = surfaces.get(id)
      if (!surface) {
        diagnostics.push({ severity: 'warning', message: `Shell references missing surface "${id}"` })
      } else if (!this.ui.renderer(surface)) {
        diagnostics.push({ severity: 'warning', message: `Surface "${id}" has no browser renderer` })
      }
    }

    for (const contribution of snapshot.contributions) {
      const slot = contribution.slot ?? 'main'
      if (shellResources.slots.has(slot)) continue
      diagnostics.push({
        severity: 'warning',
        message: `Contribution "${contribution.id}" targets inactive slot "${slot}"`,
      })
    }

    const extensionNames = [...Object.keys(extensions), ...extensionMethods]
    const extensionAvailable = (name: string): boolean => extensionNames.some((candidate) => (
      candidate === name || candidate.startsWith(`${name}.`) || candidate.startsWith(`${name}/`)
    ))

    for (const { metadata } of compiled.values()) {
      const provided = metadata.resources.provides ?? {}
      const required = metadata.resources.requires ?? {}
      for (const id of provided.surfaces ?? []) {
        if (!this.ui.hasSurface(id)) {
          diagnostics.push({
            pluginId: metadata.id,
            severity: 'error',
            message: `Browser plugin "${metadata.id}" declares surface "${id}" but did not register it`,
          })
        }
        if (!surfaces.has(id)) {
          diagnostics.push({
            pluginId: metadata.id,
            severity: 'error',
            message: `Browser surface "${id}" has no server descriptor`,
          })
        }
      }
      for (const id of provided.components ?? []) {
        if (this.ui.hasComponent(id)) continue
        diagnostics.push({
          pluginId: metadata.id,
          severity: 'error',
          message: `Browser plugin "${metadata.id}" declares component "${id}" but did not register it`,
        })
      }
      for (const id of provided.roots ?? []) {
        if (this.ui.hasRoot(id)) continue
        diagnostics.push({
          pluginId: metadata.id,
          severity: 'error',
          message: `Browser plugin "${metadata.id}" declares root "${id}" but did not register it`,
        })
      }
      for (const id of required.surfaces ?? []) {
        const surface = surfaces.get(id)
        if (surface && this.ui.renderer(surface)) continue
        diagnostics.push({
          pluginId: metadata.id,
          severity: 'warning',
          message: `Browser plugin "${metadata.id}" requires missing surface "${id}"`,
        })
      }
      for (const id of required.components ?? []) {
        if (this.ui.hasComponent(id)) continue
        diagnostics.push({
          pluginId: metadata.id,
          severity: 'warning',
          message: `Browser plugin "${metadata.id}" requires missing component "${id}"`,
        })
      }
      for (const name of required.extensions ?? []) {
        if (extensionAvailable(name)) continue
        diagnostics.push({
          pluginId: metadata.id,
          severity: 'warning',
          message: `Browser plugin "${metadata.id}" requires missing extension namespace "${name}"`,
        })
      }
    }
    return diagnostics
  }

  private activeCompiled(
    compiled: Map<string, CompiledClientPlugin>,
  ): Map<string, CompiledClientPlugin> {
    const activeIds = new Set<string>()
    const visit = (entries: Map<string, LiveEntry>): void => {
      for (const live of entries.values()) {
        if (live.component?.fiber.state === Cordis.FiberState.ACTIVE) activeIds.add(live.id)
        visit(live.children)
      }
    }
    visit(this.live)
    return new Map([...compiled].filter(([id]) => activeIds.has(id)))
  }

  private async settleEntries(entries: Map<string, LiveEntry>): Promise<void> {
    for (const live of entries.values()) {
      await live.component?.fiber.await()
      await this.settleEntries(live.children)
    }
  }

  private async reconcileEntries(
    parent: Context,
    current: Map<string, LiveEntry>,
    desired: DesiredEntry[],
    compiled: Map<string, CompiledClientPlugin>,
  ): Promise<void> {
    const wanted = new Map(desired.filter((entry) => entry.effectiveEnabled).map((entry) => [entry.id, entry]))
    for (const [id, live] of [...current]) {
      if (wanted.has(id)) continue
      await live.scopeFiber.dispose()
      current.delete(id)
    }

    for (const entry of desired) {
      if (!entry.effectiveEnabled) continue
      let live = current.get(entry.id)
      const nextScopeKey = entryScopeKey(entry)
      if (live && live.scopeKey !== nextScopeKey) {
        await live.scopeFiber.dispose()
        current.delete(entry.id)
        live = undefined
      }
      if (!live) {
        live = await this.mountEntry(parent, entry, compiled)
        current.set(entry.id, live)
        continue
      }
      await this.reconcileComponent(live, entry, compiled.get(entry.id))
      await this.reconcileEntries(live.scopeFiber.ctx, live.children, entry.children, compiled)
    }
  }

  private async mountEntry(
    parent: Context,
    entry: DesiredEntry,
    compiled: Map<string, CompiledClientPlugin>,
  ): Promise<LiveEntry> {
    const scoped = this.scopeContext(parent, entry)
    const scopeFiber = scoped.plugin(entryScope)
    await scopeFiber
    const live: LiveEntry = {
      id: entry.id,
      scopeKey: entryScopeKey(entry),
      scopeFiber,
      children: new Map(),
    }
    try {
      await this.reconcileComponent(live, entry, compiled.get(entry.id))
      await this.reconcileEntries(scopeFiber.ctx, live.children, entry.children, compiled)
      return live
    } catch (error) {
      await scopeFiber.dispose()
      throw error
    }
  }

  private async reconcileComponent(
    live: LiveEntry,
    entry: DesiredEntry,
    compiled: CompiledClientPlugin | undefined,
  ): Promise<void> {
    const current = live.component
    if (!compiled) {
      if (current) {
        await current.fiber.dispose()
        delete live.component
      }
      return
    }
    const nextConfigKey = configKey(entry.config)
    if (!current) {
      live.component = await this.mountComponent(live.scopeFiber.ctx, compiled, entry.config)
      return
    }
    if (current.module !== compiled.module || current.hash !== compiled.hash) {
      await current.fiber.dispose()
      delete live.component
      live.component = await this.mountComponent(live.scopeFiber.ctx, compiled, entry.config)
      return
    }
    if (current.configKey !== nextConfigKey) {
      current.configKey = nextConfigKey
      current.fiber.update(structuredClone(entry.config), true)
      await current.fiber.await()
    }
  }

  private async mountComponent(
    context: Context,
    compiled: CompiledClientPlugin,
    config: JsonValue,
  ): Promise<LiveComponent> {
    const fiber = context.plugin(compiled.plugin, structuredClone(config))
    try {
      await fiber
      return { ...compiled, fiber, configKey: configKey(config) }
    } catch (error) {
      await fiber.dispose()
      throw error
    }
  }

  private scopeContext(parent: Context, entry: ProgramPluginView): Context {
    let context = parent
    for (const [name, isolation] of Object.entries(entry.isolate)) {
      const key = isolation === true
        ? `entry:${entry.id}:${name}`
        : `shared:${name}:${isolation}`
      let realm = this.realms.get(key)
      if (!realm) {
        realm = Symbol(key)
        this.realms.set(key, realm)
      }
      context = context.isolate(name, realm)
    }
    for (const [name, config] of Object.entries(entry.intercept)) {
      context = context.intercept(name, structuredClone(config))
    }
    return context
  }

  private setState(state: BrowserProgramState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

export const browserProgram = new BrowserProgramRuntime()
