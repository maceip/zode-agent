import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, type Plugin as BuildPlugin } from 'esbuild'
import { watch, type FSWatcher } from 'chokidar'
import type { Context, Fiber, Plugin } from 'cordis'
import type {
  FiberStateName,
  JsonValue,
  ProgramFileView,
  ProgramPluginView,
  ProgramProposal,
  ProgramSnapshot,
} from '../../shared/protocol.js'
import { errorMessage } from '../../shared/protocol.js'
import {
  entriesOf,
  mountProgramExtension,
  parseProgramExtension,
  parseProgramProfile,
  setProgramEntryEnabled,
  scopeKey,
  type Isolation,
  type ProgramEntry,
  type ProgramExtension,
  type ProgramProfile,
} from '../program-profile.js'

interface CompiledPlugin {
  id: string
  module: string
  plugin: Plugin
  inject: string[]
  provides: string[]
  protocolVersion: number
  codeHash: string
  sourcePaths: string[]
  sourceFingerprint: string
  loadedAt: string
}

interface CompiledClient {
  id: string
  module: string
  codeHash: string
  outputPath: string
  sourcePaths: string[]
  sourceFingerprint: string
  loadedAt: string
}

interface CompiledProgram {
  server: Map<string, CompiledPlugin>
  client: Map<string, CompiledClient>
}

export type ClientProgramActivator = (snapshot: ProgramSnapshot) => Promise<void>

interface LiveComponent extends CompiledPlugin {
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

export interface ProgramRuntimeOptions {
  projectRoot: string
  programRoot?: string
  profile?: string
  pluginDirectories?: string[]
  watch?: boolean
}

interface ExternalPluginDirectory {
  alias: string
  root: string
  manifestPath: string
}

interface LoadedProgramProfile {
  profile: ProgramProfile
  profileText: string
  sourceText: string
}

const EXTERNAL_PLUGIN_MANIFEST = 'alto-plugins.json'
const EXTERNAL_PATH_PREFIX = '@external/'

const STATE_NAMES: FiberStateName[] = [
  'pending',
  'loading',
  'active',
  'failed',
  'disposed',
  'unloading',
]

const programEntryScope: Plugin = () => undefined

const REACT_EXPORTS = [
  'Activity',
  'Children',
  'Component',
  'Fragment',
  'Profiler',
  'PureComponent',
  'StrictMode',
  'Suspense',
  'act',
  'cache',
  'cacheSignal',
  'captureOwnerStack',
  'cloneElement',
  'createContext',
  'createElement',
  'createRef',
  'forwardRef',
  'isValidElement',
  'lazy',
  'memo',
  'startTransition',
  'unstable_useCacheRefresh',
  'use',
  'useActionState',
  'useCallback',
  'useContext',
  'useDebugValue',
  'useDeferredValue',
  'useEffect',
  'useEffectEvent',
  'useId',
  'useImperativeHandle',
  'useInsertionEffect',
  'useLayoutEffect',
  'useMemo',
  'useOptimistic',
  'useReducer',
  'useRef',
  'useState',
  'useSyncExternalStore',
  'useTransition',
  'version',
] as const

const CORDIS_EXPORTS = [
  'Context',
  'CordisError',
  'DisposableList',
  'EventsService',
  'Fiber',
  'FiberState',
  'Inject',
  'Logger',
  'LoggerLevel',
  'LoggerService',
  'RegistryService',
  'Service',
  'ValidationError',
  'buildOuterStack',
  'c16',
  'c256',
  'composeError',
  'createCallable',
  'defaultFormatters',
  'getPropertyDescriptor',
  'getTraceable',
  'isBailed',
  'isConstructor',
  'isObject',
  'joinPrototype',
  'resolveConfig',
  'symbols',
  'withProps',
] as const

function hostExports(source: 'react' | 'cordis', names: readonly string[]): string {
  return [
    `const source = globalThis.__ALTO_BROWSER_HOST__?.${source}`,
    `if (!source) throw new Error('Alto browser host is not initialized')`,
    ...(source === 'react' ? ['export default source'] : []),
    ...names.map((name) => `export const ${name} = source.${name}`),
  ].join('\n')
}

function browserHostModules(): BuildPlugin {
  return {
    name: 'alto-browser-host',
    setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'cordis-host' }))
      builder.onResolve({ filter: /^react\/(?:jsx-runtime|jsx-dev-runtime)$/ }, ({ path: module }) => ({
        path: module,
        namespace: 'cordis-host',
      }))
      builder.onResolve({ filter: /^cordis$/ }, () => ({ path: 'cordis', namespace: 'cordis-host' }))
      builder.onLoad({ filter: /.*/, namespace: 'cordis-host' }, ({ path: module }) => {
        if (module === 'react') return { contents: hostExports('react', REACT_EXPORTS), loader: 'js' }
        if (module === 'cordis') return { contents: hostExports('cordis', CORDIS_EXPORTS), loader: 'js' }
        return {
          contents: [
            `const runtime = globalThis.__ALTO_BROWSER_HOST__?.jsxRuntime`,
            `if (!runtime) throw new Error('Alto JSX host is not initialized')`,
            'export const Fragment = runtime.Fragment',
            'export const jsx = runtime.jsx',
            'export const jsxs = runtime.jsxs',
            'export const jsxDEV = runtime.jsxDEV',
          ].join('\n'),
          loader: 'js',
        }
      })
    },
  }
}

function pluginInject(plugin: Plugin): string[] {
  const inject = plugin.inject
  if (!inject) return []
  return Array.isArray(inject) ? [...inject] : Object.keys(inject)
}

function pluginProvides(plugin: Plugin): string[] {
  const provide = plugin.provide
  if (!provide) return []
  return Array.isArray(provide) ? [...provide] : [provide]
}

function isPlugin(value: unknown): value is Plugin {
  if (typeof value === 'function') return true
  return typeof value === 'object'
    && value !== null
    && typeof (value as { apply?: unknown }).apply === 'function'
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

function valueKey(value: unknown): string {
  return JSON.stringify(value)
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function directoryAlias(root: string): string {
  const alias = path.basename(root).replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (!alias) throw new Error(`external plugin directory has no usable name: ${root}`)
  return alias
}

function componentOf(entries: Map<string, LiveEntry>, id: string): LiveComponent | undefined {
  for (const live of entries.values()) {
    if (live.id === id) return live.component
    const nested = componentOf(live.children, id)
    if (nested) return nested
  }
  return undefined
}

function liveCompilations(entries: Map<string, LiveEntry>): Map<string, CompiledPlugin> {
  const result = new Map<string, CompiledPlugin>()
  const collect = (values: Map<string, LiveEntry>): void => {
    for (const live of values.values()) {
      if (live.component) result.set(live.id, live.component)
      collect(live.children)
    }
  }
  collect(entries)
  return result
}

export class ProgramRuntime {
  readonly programRoot: string
  readonly profilePath: string
  readonly cacheDir: string
  private readonly externalPluginDirectories: readonly ExternalPluginDirectory[]

  private watcher?: FSWatcher
  private readonly live = new Map<string, LiveEntry>()
  private clients = new Map<string, CompiledClient>()
  private readonly serverCache = new Map<string, CompiledPlugin>()
  private readonly clientCache = new Map<string, CompiledClient>()
  private readonly clientArtifacts = new Map<string, CompiledClient>()
  private currentProfile: ProgramProfile = { version: 2, plugins: [] }
  private currentFingerprint = ''
  private currentProfileSource = ''
  private profileText = '{\n  "version": 2,\n  "plugins": []\n}\n'
  private files: ProgramFileView[] = []
  private revision = 0
  private lastError: string | undefined
  private lastAppliedAt: string | undefined
  private readonly proposals = new Map<string, ProgramProposal>()
  private readonly realms = new Map<string, symbol>()
  private reconcileQueue: Promise<void> = Promise.resolve()
  private transactionQueue: Promise<void> = Promise.resolve()
  private reconcileTimer?: NodeJS.Timeout
  private readonly pendingChangedPaths = new Set<string>()
  private pendingFullRebuild = false
  private toolsChangedTimer?: NodeJS.Timeout
  private clientActivator?: ClientProgramActivator
  private activatingRevision?: number

  constructor(
    private readonly ctx: Context,
    private readonly options: ProgramRuntimeOptions,
  ) {
    this.programRoot = path.resolve(
      options.programRoot ?? path.join(options.projectRoot, 'program'),
    )
    this.profilePath = path.resolve(
      this.programRoot,
      options.profile ?? 'cordis.json',
    )
    const externalRoots = [...new Set((options.pluginDirectories ?? []).map((root) => (
      path.resolve(root)
    )))]
    const aliases = new Set<string>()
    this.externalPluginDirectories = externalRoots.map((root): ExternalPluginDirectory => {
      if (pathIsInside(this.programRoot, root) || pathIsInside(root, this.programRoot)) {
        throw new Error(`external plugin directory must be separate from the Alto program: ${root}`)
      }
      const alias = directoryAlias(root)
      if (aliases.has(alias)) {
        throw new Error(`external plugin directories must have unique names: ${alias}`)
      }
      aliases.add(alias)
      return {
        alias,
        root,
        manifestPath: path.join(root, EXTERNAL_PLUGIN_MANIFEST),
      }
    })
    this.cacheDir = path.join(options.projectRoot, '.codex-cordis', 'cache')
  }

  get projectRoot(): string {
    return this.options.projectRoot
  }

  async start(): Promise<() => Promise<void>> {
    await mkdir(this.cacheDir, { recursive: true })
    await this.reconcile(true)

    this.ctx.on('tools/changed', () => {
      clearTimeout(this.toolsChangedTimer)
      this.toolsChangedTimer = setTimeout(() => this.emitChanged(), 0)
    })

    if (this.options.watch !== false) {
      this.watcher = watch([
        this.profilePath,
        this.programRoot,
        ...this.externalPluginDirectories.map(({ root }) => root),
      ], {
        ignoreInitial: true,
        // Watching installed packages can exhaust macOS's spawn file descriptors.
        // Prune these directories before Chokidar opens a watcher for each file.
        ignored: /(?:^|[/\\])(?:node_modules|\.git)(?:[/\\]|$)/u,
        awaitWriteFinish: {
          stabilityThreshold: 80,
          pollInterval: 20,
        },
      })
      this.watcher.on('all', (event, changedPath) => {
        const contentChange = event === 'change'
        this.scheduleReconcile(contentChange ? path.resolve(changedPath) : undefined)
      })
    }

    return async () => {
      clearTimeout(this.reconcileTimer)
      clearTimeout(this.toolsChangedTimer)
      await this.watcher?.close()
      await this.disposeEntries(this.live)
    }
  }

  private scheduleReconcile(changedPath?: string): void {
    if (changedPath) this.pendingChangedPaths.add(changedPath)
    else this.pendingFullRebuild = true
    clearTimeout(this.reconcileTimer)
    this.reconcileTimer = setTimeout(() => {
      const changedPaths = this.pendingFullRebuild
        ? undefined
        : new Set(this.pendingChangedPaths)
      this.pendingChangedPaths.clear()
      this.pendingFullRebuild = false
      void this.reconcile(false, false, changedPaths).catch((error) => this.recordError(error))
    }, 100)
  }

  reconcile(
    force = false,
    reuseCompiled = false,
    changedPaths?: ReadonlySet<string>,
  ): Promise<void> {
    const changes = changedPaths
      ? new Set([...changedPaths].map((changedPath) => path.resolve(changedPath)))
      : undefined
    const run = this.reconcileQueue.then(() => this.reconcileInternal(
      force,
      reuseCompiled,
      changes,
    ))
    this.reconcileQueue = run.catch(() => undefined)
    return run
  }

  setClientActivator(activator: ClientProgramActivator): () => void {
    if (this.clientActivator) throw new Error('a client program activator is already registered')
    this.clientActivator = activator
    return () => {
      if (this.clientActivator === activator) delete this.clientActivator
    }
  }

  isActivating(): boolean {
    return this.activatingRevision !== undefined
  }

  commandRevision(): number {
    return this.activatingRevision ?? this.revision
  }

  private externalModulePath(directory: ExternalPluginDirectory, modulePath: string): string {
    if (path.isAbsolute(modulePath)) {
      throw new Error(`external plugin modules must use relative paths: ${modulePath}`)
    }
    const absolute = path.resolve(directory.root, modulePath)
    if (!pathIsInside(directory.root, absolute) || absolute === directory.root) {
      throw new Error(`external plugin path escapes ${directory.root}: ${modulePath}`)
    }
    const relative = path.relative(directory.root, absolute).split(path.sep).join('/')
    return `${EXTERNAL_PATH_PREFIX}${directory.alias}/${relative}`
  }

  private externalEntry(
    directory: ExternalPluginDirectory,
    entry: ProgramEntry,
  ): ProgramEntry {
    return {
      ...structuredClone(entry),
      ...(entry.module ? { module: this.externalModulePath(directory, entry.module) } : {}),
      ...(entry.client ? { client: this.externalModulePath(directory, entry.client) } : {}),
      children: entry.children.map((child) => this.externalEntry(directory, child)),
    }
  }

  private externalExtension(
    directory: ExternalPluginDirectory,
    extension: ProgramExtension,
  ): ProgramExtension {
    return {
      version: 1,
      mounts: extension.mounts.map((mount) => ({
        ...(mount.parent ? { parent: mount.parent } : {}),
        plugins: mount.plugins.map((entry) => this.externalEntry(directory, entry)),
      })),
    }
  }

  private async loadProfile(): Promise<LoadedProgramProfile> {
    const profileText = await readFile(this.profilePath, 'utf8')
    let profile = parseProgramProfile(profileText)
    const sources = [profileText]
    for (const directory of this.externalPluginDirectories) {
      const manifestText = await readFile(directory.manifestPath, 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `external plugin directory is missing ${EXTERNAL_PLUGIN_MANIFEST}: ${directory.root}`,
          )
        }
        throw error
      })
      const extension = this.externalExtension(
        directory,
        parseProgramExtension(manifestText),
      )
      profile = mountProgramExtension(profile, extension)
      sources.push(directory.manifestPath, manifestText)
    }
    return { profile, profileText, sourceText: sources.join('\0') }
  }

  private async reconcileInternal(
    force: boolean,
    reuseCompiled: boolean,
    changedPaths?: ReadonlySet<string>,
  ): Promise<void> {
    const loaded = await this.loadProfile()
    const nextProfileText = loaded.profileText
    if (
      !force
      && loaded.sourceText === this.currentProfileSource
      && (changedPaths
        ? !this.currentSourcePaths().some((sourcePath) => changedPaths.has(sourcePath))
        : await this.currentSourcesUnchanged())
    ) return
    const nextProfile = loaded.profile
    if (changedPaths) this.invalidateCompiled(changedPaths)
    const compiled = await this.compileProfile(nextProfile, reuseCompiled, changedPaths)
    const sourceFiles = await this.readSourceFiles(nextProfile, compiled, changedPaths)
    const fingerprint = this.fingerprint(loaded.sourceText, sourceFiles)
    if (!force && fingerprint === this.currentFingerprint) return

    const candidateRevision = this.revision + 1
    const previousProfile = this.currentProfile
    const previousCompiled = liveCompilations(this.live)
    this.activatingRevision = candidateRevision
    try {
      await this.withUiBatch(() => this.reconcileEntries(
        this.ctx,
        this.live,
        nextProfile.plugins,
        compiled.server,
      ))
      if (this.clientActivator) {
        await this.clientActivator(this.snapshotFor(
          nextProfile,
          compiled.client,
          candidateRevision,
          nextProfileText,
          sourceFiles,
        ))
      }
    } catch (error) {
      try {
        await this.withUiBatch(() => this.reconcileEntries(
          this.ctx,
          this.live,
          previousProfile.plugins,
          previousCompiled,
        ))
      } catch (restoreError) {
        this.recordError(new Error(
          `Program rollback failed: ${errorMessage(restoreError)}`,
          { cause: restoreError },
        ))
      }
      delete this.activatingRevision
      this.emitChanged()
      throw new Error(
        `Program activation failed; the previous program was restored: ${errorMessage(error)}`,
        { cause: error },
      )
    }

    this.currentProfile = nextProfile
    this.clients = compiled.client
    if (!reuseCompiled && !changedPaths) {
      this.serverCache.clear()
      this.clientCache.clear()
    }
    for (const [id, component] of compiled.server) this.serverCache.set(id, component)
    for (const [id, component] of compiled.client) this.clientCache.set(id, component)
    const profileIds = new Set(entriesOf(nextProfile).map(({ entry }) => entry.id))
    for (const id of this.serverCache.keys()) {
      if (!profileIds.has(id)) this.serverCache.delete(id)
    }
    for (const id of this.clientCache.keys()) {
      if (!profileIds.has(id)) this.clientCache.delete(id)
    }
    this.currentFingerprint = fingerprint
    this.currentProfileSource = loaded.sourceText
    this.profileText = nextProfileText
    this.files = sourceFiles
    this.lastError = undefined
    this.lastAppliedAt = new Date().toISOString()
    this.revision = candidateRevision
    delete this.activatingRevision
    this.emitChanged()
    await this.pruneCache()
  }

  private async withUiBatch<T>(operation: () => Promise<T>): Promise<T> {
    const ui = this.ctx.root.get('ui', false)
    return ui ? ui.batch(operation) : operation()
  }

  private async currentSourcesUnchanged(): Promise<boolean> {
    const matches = await Promise.all(this.files.map(async (file) => {
      try {
        return await readFile(this.resolveProgramPath(file.path), 'utf8') === file.content
      } catch {
        return false
      }
    }))
    return matches.every(Boolean)
  }

  private currentSourcePaths(): string[] {
    return this.files.map((file) => this.resolveProgramPath(file.path))
  }

  private invalidateCompiled(changedPaths: ReadonlySet<string>): void {
    for (const [id, compiled] of this.serverCache) {
      if (compiled.sourcePaths.some((sourcePath) => changedPaths.has(sourcePath))) {
        this.serverCache.delete(id)
      }
    }
    for (const [id, compiled] of this.clientCache) {
      if (compiled.sourcePaths.some((sourcePath) => changedPaths.has(sourcePath))) {
        this.clientCache.delete(id)
      }
    }
  }

  private async cachedSourcesUnchanged(
    cached: CompiledPlugin | CompiledClient,
  ): Promise<boolean> {
    try {
      return await this.sourceFingerprint(cached.sourcePaths) === cached.sourceFingerprint
    } catch {
      return false
    }
  }

  private async cachedProgramSourcesUnchanged(): Promise<boolean> {
    const cached = [
      ...this.serverCache.values(),
      ...this.clientCache.values(),
    ]
    return (await Promise.all(cached.map((compiled) => (
      this.cachedSourcesUnchanged(compiled)
    )))).every(Boolean)
  }

  private async sourceFingerprint(sourcePaths: string[]): Promise<string> {
    const paths = [...sourcePaths].sort()
    const contents = await Promise.all(paths.map((sourcePath) => readFile(sourcePath)))
    const hash = createHash('sha256')
    for (let index = 0; index < paths.length; index += 1) {
      hash.update(paths[index] ?? '').update(contents[index] ?? Buffer.alloc(0))
    }
    return hash.digest('hex')
  }

  private async compileProfile(
    profile: ProgramProfile,
    reuseCompiled: boolean,
    changedPaths?: ReadonlySet<string>,
  ): Promise<CompiledProgram> {
    const previousServer = liveCompilations(this.live)
    const server = new Map<string, CompiledPlugin>()
    const client = new Map<string, CompiledClient>()
    await Promise.all(entriesOf(profile).map(async ({ entry, active }) => {
      if (!active) return
      if (entry.module) {
        const cached = this.serverCache.get(entry.id)
        const cachedMatches = cached?.module === entry.module
          && cached.protocolVersion === (entry.protocolVersion ?? 1)
        const cachedValid = cachedMatches && (changedPaths
          ? !cached.sourcePaths.some((sourcePath) => changedPaths.has(sourcePath))
          : reuseCompiled && await this.cachedSourcesUnchanged(cached))
        if (cached && cachedValid) server.set(entry.id, cached)
        else server.set(entry.id, await this.compilePlugin(entry, previousServer.get(entry.id)))
      }
      if (entry.client) {
        const cached = this.clientCache.get(entry.id)
        const cachedMatches = cached?.module === entry.client
        const cachedValid = cachedMatches && (changedPaths
          ? !cached.sourcePaths.some((sourcePath) => changedPaths.has(sourcePath))
          : reuseCompiled && await this.cachedSourcesUnchanged(cached))
        const cachedExists = cachedValid
          ? await access(cached.outputPath).then(() => true, () => false)
          : false
        if (cached && cachedExists) client.set(entry.id, cached)
        else client.set(entry.id, await this.compileClient(entry, this.clients.get(entry.id)))
      }
    }))
    return { server, client }
  }

  private async compilePlugin(
    entry: ProgramEntry,
    previous?: CompiledPlugin,
  ): Promise<CompiledPlugin> {
    if (!entry.module) throw new Error(`program entry "${entry.id}" has no module`)
    const sourcePath = this.resolveProgramPath(entry.module)
    const result = await build({
      absWorkingDir: this.options.projectRoot,
      entryPoints: [sourcePath],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      packages: 'external',
      sourcemap: 'inline',
      legalComments: 'none',
      logLevel: 'silent',
    })
    const output = result.outputFiles?.[0]
    if (!output) throw new Error(`plugin "${entry.id}" did not produce a bundle`)
    const codeHash = createHash('sha256').update(output.contents).digest('hex')
    const sourcePaths = Object.keys(result.metafile?.inputs ?? {})
      .map((input) => path.resolve(this.options.projectRoot, input))
      .filter((input) => this.isProgramPath(input))
    const sourceFingerprint = await this.sourceFingerprint(sourcePaths)
    if (
      previous
      && previous.module === entry.module
      && previous.codeHash === codeHash
      && previous.protocolVersion === (entry.protocolVersion ?? 1)
    ) return { ...previous, sourcePaths, sourceFingerprint }

    const token = `${Date.now()}-${randomUUID()}`
    const outputPath = path.join(
      this.cacheDir,
      `${entry.id}-${codeHash.slice(0, 12)}-${token}.mjs`,
    )
    await writeFile(outputPath, output.contents)
    const module = await import(`${pathToFileURL(outputPath).href}?v=${token}`)
    const plugin = module.default as unknown
    if (!isPlugin(plugin)) {
      throw new Error(`plugin "${entry.id}" must default-export a Cordis plugin`)
    }
    const protocolVersion = (plugin as Plugin & { protocolVersion?: number }).protocolVersion ?? 1
    if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
      throw new Error(`plugin "${entry.id}" has an invalid protocol version`)
    }
    if (protocolVersion !== (entry.protocolVersion ?? 1)) {
      throw new Error(
        `plugin "${entry.id}" implements protocol ${protocolVersion}, but the profile requires ${entry.protocolVersion ?? 1}`,
      )
    }

    return {
      id: entry.id,
      module: entry.module,
      plugin,
      inject: pluginInject(plugin),
      provides: pluginProvides(plugin),
      protocolVersion,
      codeHash,
      sourcePaths,
      sourceFingerprint,
      loadedAt: new Date().toISOString(),
    }
  }

  private async compileClient(
    entry: ProgramEntry,
    previous?: CompiledClient,
  ): Promise<CompiledClient> {
    if (!entry.client) throw new Error(`program entry "${entry.id}" has no browser module`)
    const sourcePath = this.resolveProgramPath(entry.client)
    const result = await build({
      absWorkingDir: this.options.projectRoot,
      entryPoints: [sourcePath],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      loader: { '.css': 'text', '.woff2': 'dataurl' },
      sourcemap: 'inline',
      legalComments: 'none',
      logLevel: 'silent',
      plugins: [browserHostModules()],
    })
    const output = result.outputFiles?.find((file) => file.path.endsWith('.js'))
      ?? result.outputFiles?.[0]
    if (!output) throw new Error(`browser plugin "${entry.id}" did not produce a bundle`)
    const codeHash = createHash('sha256').update(output.contents).digest('hex')
    const sourcePaths = Object.keys(result.metafile?.inputs ?? {})
      .map((input) => path.resolve(this.options.projectRoot, input))
      .filter((input) => this.isProgramPath(input))
    const sourceFingerprint = await this.sourceFingerprint(sourcePaths)
    const previousExists = previous
      ? await access(previous.outputPath).then(() => true, () => false)
      : false
    if (
      previous
      && previous.module === entry.client
      && previous.codeHash === codeHash
      && previousExists
    ) return { ...previous, sourcePaths, sourceFingerprint }

    const outputPath = path.join(
      this.cacheDir,
      `browser-${entry.id}-${codeHash.slice(0, 16)}.mjs`,
    )
    await writeFile(outputPath, output.contents)
    const compiled: CompiledClient = {
      id: entry.id,
      module: entry.client,
      codeHash,
      outputPath,
      sourcePaths,
      sourceFingerprint,
      loadedAt: new Date().toISOString(),
    }
    this.clientArtifacts.set(`${entry.id}:${codeHash}`, compiled)
    return compiled
  }

  private async reconcileEntries(
    parent: Context,
    current: Map<string, LiveEntry>,
    desired: ProgramEntry[],
    compiled: Map<string, CompiledPlugin>,
  ): Promise<void> {
    const wanted = new Map(desired.map((entry) => [entry.id, entry]))
    for (const [id, live] of [...current]) {
      const entry = wanted.get(id)
      if (entry?.enabled) continue
      await live.scopeFiber.dispose()
      current.delete(id)
    }

    for (const entry of desired) {
      if (!entry.enabled) continue
      let live = current.get(entry.id)
      if (live && live.scopeKey !== scopeKey(entry)) {
        await live.scopeFiber.dispose()
        current.delete(entry.id)
        live = undefined
      }

      if (!live) {
        const mounted = await this.mountEntry(parent, entry, compiled)
        current.set(entry.id, mounted)
        continue
      }
      await this.reconcileComponent(live, entry, compiled.get(entry.id))
      await this.reconcileEntries(
        live.scopeFiber.ctx,
        live.children,
        entry.children,
        compiled,
      )
    }
  }

  private async mountEntry(
    parent: Context,
    entry: ProgramEntry,
    compiled: Map<string, CompiledPlugin>,
  ): Promise<LiveEntry> {
    const scoped = this.scopeContext(parent, entry)
    const scopeFiber = scoped.plugin(programEntryScope)
    await scopeFiber
    const live: LiveEntry = {
      id: entry.id,
      scopeKey: scopeKey(entry),
      scopeFiber,
      children: new Map(),
    }

    try {
      await this.reconcileComponent(live, entry, compiled.get(entry.id))
      await this.reconcileEntries(
        scopeFiber.ctx,
        live.children,
        entry.children,
        compiled,
      )
      return live
    } catch (error) {
      await scopeFiber.dispose()
      throw error
    }
  }

  private scopeContext(parent: Context, entry: ProgramEntry): Context {
    let context = parent
    for (const [name, isolation] of Object.entries(entry.isolate)) {
      context = context.isolate(name, this.realm(entry.id, name, isolation))
    }
    for (const [name, config] of Object.entries(entry.intercept)) {
      context = context.intercept(name, structuredClone(config))
    }
    return context
  }

  private realm(entryId: string, name: string, isolation: Isolation): symbol {
    const key = isolation === true
      ? `entry:${entryId}:${name}`
      : `shared:${name}:${isolation}`
    let realm = this.realms.get(key)
    if (!realm) {
      realm = Symbol(key)
      this.realms.set(key, realm)
    }
    return realm
  }

  private async reconcileComponent(
    live: LiveEntry,
    entry: ProgramEntry,
    compiled: CompiledPlugin | undefined,
  ): Promise<void> {
    const current = live.component
    if (!compiled) {
      if (current) {
        await current.fiber.dispose()
        delete live.component
      }
      return
    }

    const nextConfigKey = valueKey(entry.config)
    if (!current) {
      live.component = await this.mountComponent(live.scopeFiber.ctx, compiled, entry.config)
      return
    }

    if (current.module !== compiled.module || current.codeHash !== compiled.codeHash) {
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
    compiled: CompiledPlugin,
    config: JsonValue,
  ): Promise<LiveComponent> {
    const fiber = context.plugin(compiled.plugin, structuredClone(config))
    try {
      await fiber
      return { ...compiled, fiber, configKey: valueKey(config) }
    } catch (error) {
      await fiber.dispose()
      throw error
    }
  }

  private async disposeEntries(entries: Map<string, LiveEntry>): Promise<void> {
    for (const live of [...entries.values()].reverse()) await live.scopeFiber.dispose()
    entries.clear()
  }

  private async readSourceFiles(
    profile: ProgramProfile,
    compiled: CompiledProgram,
    changedPaths?: ReadonlySet<string>,
  ): Promise<ProgramFileView[]> {
    const paths = new Set<string>()
    for (const { entry } of entriesOf(profile)) {
      if (entry.module) paths.add(this.resolveProgramPath(entry.module))
      if (entry.client) paths.add(this.resolveProgramPath(entry.client))
    }
    for (const candidate of [
      ...compiled.server.values(),
      ...compiled.client.values(),
    ]) {
      for (const sourcePath of candidate.sourcePaths) paths.add(sourcePath)
    }

    const files: ProgramFileView[] = []
    const currentFiles = new Map(this.files.map((file) => [
      this.resolveProgramPath(file.path),
      file.content,
    ]))
    for (const absolute of paths) {
      files.push({
        path: this.relativeProgramPath(absolute),
        content: changedPaths
          && !changedPaths.has(absolute)
          && currentFiles.has(absolute)
          ? currentFiles.get(absolute)!
          : await readFile(absolute, 'utf8'),
      })
    }
    return files.sort((left, right) => left.path.localeCompare(right.path))
  }

  private fingerprint(profileText: string, files: ProgramFileView[]): string {
    const hash = createHash('sha256').update(profileText)
    for (const file of files) hash.update(file.path).update(file.content)
    return hash.digest('hex')
  }

  private isProgramPath(absolute: string): boolean {
    return pathIsInside(this.programRoot, absolute)
      || this.externalPluginDirectories.some(({ root }) => pathIsInside(root, absolute))
  }

  private resolveProgramPath(relativePath: string): string {
    if (relativePath.startsWith(EXTERNAL_PATH_PREFIX)) {
      const [alias, ...parts] = relativePath.slice(EXTERNAL_PATH_PREFIX.length).split('/')
      const directory = this.externalPluginDirectories.find((candidate) => candidate.alias === alias)
      if (!directory || parts.length === 0) {
        throw new Error(`unknown external plugin path: ${relativePath}`)
      }
      const absolute = path.resolve(directory.root, ...parts)
      if (!pathIsInside(directory.root, absolute) || absolute === directory.root) {
        throw new Error(`external plugin path escapes its directory: ${relativePath}`)
      }
      return absolute
    }
    const absolute = path.resolve(this.programRoot, relativePath)
    const relative = path.relative(this.programRoot, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`program path escapes the program directory: ${relativePath}`)
    }
    return absolute
  }

  private relativeProgramPath(absolutePath: string): string {
    if (pathIsInside(this.programRoot, absolutePath)) {
      return path.relative(this.programRoot, absolutePath).split(path.sep).join('/')
    }
    for (const directory of this.externalPluginDirectories) {
      if (!pathIsInside(directory.root, absolutePath)) continue
      const relative = path.relative(directory.root, absolutePath).split(path.sep).join('/')
      return `${EXTERNAL_PATH_PREFIX}${directory.alias}/${relative}`
    }
    throw new Error(`program source is outside the configured plugin directories: ${absolutePath}`)
  }

  private validateWritablePath(relativePath: string): string {
    const normalized = relativePath.split(path.sep).join('/')
    if (normalized === 'cordis.json') return this.profilePath
    if (!/^[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|css)$/.test(normalized)) {
      throw new Error(`program changes may only edit cordis.json or program-relative code and stylesheet files: ${relativePath}`)
    }
    return this.resolveProgramPath(normalized)
  }

  async applyProgram(profileText: string, files: ProgramFileView[]): Promise<void> {
    await this.applyFiles([
      { path: 'cordis.json', content: profileText },
      ...files,
    ])
  }

  async applyChange(summary: string, files: ProgramFileView[]): Promise<ProgramSnapshot> {
    if (!summary.trim()) throw new Error('a program change needs a summary')
    await this.applyFiles(files)
    return this.snapshot()
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<ProgramSnapshot> {
    return this.transaction(async () => {
      const profileText = await readFile(this.profilePath, 'utf8')
      const nextProfileText = setProgramEntryEnabled(profileText, id, enabled)
      if (nextProfileText !== profileText) {
        await this.applyFilesNow([{
          path: 'cordis.json',
          content: nextProfileText,
        }])
      }
      return this.snapshot()
    })
  }

  private applyFiles(files: ProgramFileView[]): Promise<void> {
    return this.transaction(() => this.applyFilesNow(files))
  }

  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.transactionQueue.then(operation)
    this.transactionQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private async applyFilesNow(files: ProgramFileView[]): Promise<void> {
    const unique = new Map<string, string>()
    for (const file of files) {
      if (file.content.length > 500_000) {
        throw new Error(`program file is too large: ${file.path}`)
      }
      unique.set(this.validateWritablePath(file.path), file.content)
    }
    if (unique.size > 24) throw new Error('a program change may edit at most 24 files')

    const backups = new Map<string, string | null>()
    for (const absolute of unique.keys()) {
      try {
        backups.set(absolute, await readFile(absolute, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        backups.set(absolute, null)
      }
    }

    try {
      for (const [absolute, content] of unique) await this.writeAtomic(absolute, content)
      const profileOnly = [...unique.keys()].every((absolute) => absolute === this.profilePath)
      const sourcesChangedOutsideTransaction = profileOnly && !(
        await this.currentSourcesUnchanged()
        && await this.cachedProgramSourcesUnchanged()
      )
      const changedPaths = sourcesChangedOutsideTransaction
        || [...backups.values()].some((content) => content === null)
        ? undefined
        : new Set(unique.keys())
      await this.reconcile(true, false, changedPaths)
    } catch (error) {
      for (const [absolute, content] of backups) {
        if (content === null) await rm(absolute, { force: true })
        else await this.writeAtomic(absolute, content)
      }
      await this.reconcile(true, true).catch((restoreError) => {
        this.recordError(new Error(
          `Program rollback failed: ${errorMessage(restoreError)}`,
        ))
      })
      throw error
    }
  }

  private async writeAtomic(absolute: string, content: string): Promise<void> {
    await mkdir(path.dirname(absolute), { recursive: true })
    const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, absolute)
  }

  stageProposal(
    summary: string,
    files: ProgramFileView[],
    source: ProgramProposal['source'] = 'agent',
  ): ProgramProposal {
    if (!summary.trim()) throw new Error('a program proposal needs a summary')
    for (const file of files) this.validateWritablePath(file.path)
    const proposal: ProgramProposal = {
      id: randomUUID(),
      summary: summary.trim(),
      createdAt: new Date().toISOString(),
      files: files.map((file) => ({ ...file })),
      source,
    }
    this.proposals.set(proposal.id, proposal)
    this.emitChanged()
    return proposal
  }

  async resolveProposal(id: string, decision: 'accept' | 'decline'): Promise<void> {
    const proposal = this.proposals.get(id)
    if (!proposal) throw new Error(`unknown program proposal: ${id}`)
    if (decision === 'accept') await this.applyFiles(proposal.files)
    this.proposals.delete(id)
    this.emitChanged()
  }

  private recordError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    this.lastError = normalized.message
    this.ctx.root.emit('program/error', normalized)
    this.emitChanged()
  }

  private emitChanged(): void {
    if (this.isActivating()) return
    this.ctx.root.emit('program/changed', this.snapshot())
  }

  snapshot(): ProgramSnapshot {
    return this.snapshotFor(
      this.currentProfile,
      this.clients,
      this.revision,
      this.profileText,
      this.files,
    )
  }

  private snapshotFor(
    profile: ProgramProfile,
    clients: Map<string, CompiledClient>,
    revision: number,
    profileText: string,
    files: ProgramFileView[],
  ): ProgramSnapshot {
    const plugins: ProgramPluginView[] = entriesOf(profile).map(({
      entry,
      parentId,
      depth,
      active,
    }) => {
      const component = componentOf(this.live, entry.id)
      const client = clients.get(entry.id)
      const scope = this.liveEntry(entry.id)
      const fiber = component?.fiber ?? scope?.scopeFiber
      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        protocolVersion: entry.protocolVersion ?? 1,
        ...(entry.module ? { module: entry.module } : {}),
        ...(client ? {
          client: {
            module: client.module,
            hash: client.codeHash,
            url: `/__cordis/client/${encodeURIComponent(client.id)}/${client.codeHash}.mjs`,
            loadedAt: client.loadedAt,
          },
        } : {}),
        ...(parentId ? { parentId } : {}),
        depth,
        enabled: entry.enabled,
        effectiveEnabled: active,
        state: active
          ? STATE_NAMES[fiber?.state ?? 0] ?? 'pending'
          : 'disabled',
        inject: component?.inject ?? [],
        provides: component?.provides ?? [],
        config: asJson(entry.config),
        isolate: structuredClone(entry.isolate),
        intercept: structuredClone(entry.intercept),
        ...(component?.loadedAt ? { loadedAt: component.loadedAt } : {}),
      }
    })

    return {
      revision,
      profileText,
      plugins,
      files: files.map((file) => ({ ...file })),
      tools: this.ctx.root.get('tools', false)?.list() ?? [],
      extensionMethods: this.ctx.root.get('clientExtensions', false)
        ?.describe().methods.map(({ name }) => name) ?? [],
      proposals: [...this.proposals.values()].map((proposal) => structuredClone(proposal)),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastAppliedAt ? { lastAppliedAt: this.lastAppliedAt } : {}),
    }
  }

  private liveEntry(id: string): LiveEntry | undefined {
    const find = (entries: Map<string, LiveEntry>): LiveEntry | undefined => {
      for (const live of entries.values()) {
        if (live.id === id) return live
        const nested = find(live.children)
        if (nested) return nested
      }
      return undefined
    }
    return find(this.live)
  }

  runtimeSummary(): Record<string, unknown> {
    const snapshot = this.snapshot()
    return {
      revision: snapshot.revision,
      plugins: snapshot.plugins,
      tools: snapshot.tools,
      ui: this.ctx.root.get('ui', false)?.describe() ?? [],
      proposals: snapshot.proposals.map(({ id, summary, createdAt, source }) => ({
        id,
        summary,
        createdAt,
        source,
      })),
      lastError: snapshot.lastError ?? null,
      lastAppliedAt: snapshot.lastAppliedAt ?? null,
    }
  }

  async clientBundle(id: string, hash: string): Promise<Buffer | undefined> {
    const artifact = this.clientArtifacts.get(`${id}:${hash}`)
    if (!artifact) return undefined
    try {
      return await readFile(artifact.outputPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.clientArtifacts.delete(`${id}:${hash}`)
      return undefined
    }
  }

  private async pruneCache(): Promise<void> {
    const entries = await readdir(this.cacheDir, { withFileTypes: true })
    const activeClientFiles = new Set(
      [...this.clients.values(), ...this.clientCache.values()]
        .map((client) => path.basename(client.outputPath)),
    )
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
      .map((entry) => ({ name: entry.name }))
    const stale = files.filter((file) => !activeClientFiles.has(file.name))

    await Promise.all(stale.map((file) => (
      rm(path.join(this.cacheDir, file.name), { force: true })
    )))

    const removed = new Set(stale.map((file) => file.name))
    for (const [key, artifact] of this.clientArtifacts) {
      if (removed.has(path.basename(artifact.outputPath))) this.clientArtifacts.delete(key)
    }
  }
}

export const programRuntimePlugin: Plugin<ProgramRuntimeOptions> = async (
  ctx: Context,
  options: ProgramRuntimeOptions,
) => {
  const runtime = new ProgramRuntime(ctx, options)
  ctx.provide('program', runtime)
  return runtime.start()
}

programRuntimePlugin.provide = 'program'
