import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type {
  HarnessEvent,
  JsonValue,
  ProgramSnapshot,
  UiSnapshot,
  UiSurface,
} from '../shared/protocol.js'
import { clientHost } from './host.js'
import { browserProgram } from './plugin-runtime.js'
import { KernelRecovery } from './recovery.js'
import {
  contributionIds,
  outletNames,
  ShellTree,
  slotClass,
  themeStyle,
  type ShellBuiltin,
  type ShellContribution,
  type ShellOutlet,
  type ShellSlot,
  type ShellSurface,
} from './shell.js'

async function activateProgram(
  program: ProgramSnapshot,
  ui: UiSnapshot,
  extensions: Readonly<Record<string, JsonValue>>,
): Promise<void> {
  await browserProgram.reconcile(program.revision, program.plugins, {
    ui,
    extensions,
    extensionMethods: program.extensionMethods ?? [],
  })
  clientHost.programActivated(program.revision)
}

async function activateCandidate(
  payload: Extract<HarnessEvent, { type: 'program.candidate' }>['payload'],
): Promise<void> {
  const { program, ui, extensions } = payload
  try {
    await activateProgram(program, ui, extensions)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await clientHost.command('program.client.ready', {
        revision: program.revision,
        success: false,
        error: message,
      })
    } catch (acknowledgementError) {
      console.error(acknowledgementError)
    }
    return
  }
  try {
    await clientHost.command('program.client.ready', {
      revision: program.revision,
      success: true,
    })
  } catch (acknowledgementError) {
    console.error(acknowledgementError)
  }
}

export function App(): ReactNode {
  const hostState = useSyncExternalStore(clientHost.subscribe, clientHost.snapshot)
  const clientUiRevision = useSyncExternalStore(
    browserProgram.ui.subscribe,
    browserProgram.ui.snapshot,
  )
  const browserState = useSyncExternalStore(
    browserProgram.subscribe,
    browserProgram.snapshot,
  )
  const snapshot = hostState.snapshot

  useEffect(() => clientHost.start(), [])

  useEffect(() => {
    const program = snapshot?.program
    if (!program) return
    void activateProgram(program, snapshot.ui, snapshot.extensions).catch((error: unknown) => {
      console.error(error)
    })
  }, [hostState.connectionEpoch])

  useEffect(() => clientHost.onEvent((event) => {
    if (event.type === 'program.updated') {
      const { program, ui, extensions } = event.payload
      void activateProgram(program, ui, extensions).catch((error: unknown) => {
        console.error(error)
      })
      return
    }
    if (event.type !== 'program.candidate') return
    void activateCandidate(event.payload)
  }), [])

  void clientUiRevision

  const shell = snapshot?.ui.shell
  const surfaces = snapshot?.ui.surfaces ?? []
  const regions = snapshot?.ui.regions ?? []
  const contributions = snapshot?.ui.contributions ?? []
  const surfaceMap = useMemo(
    () => new Map(surfaces.map((surface) => [surface.id, surface])),
    [surfaces],
  )
  const liveOutlets = useMemo(
    () => shell ? outletNames(shell.root) : new Set<string>(),
    [shell],
  )
  const liveRegions = useMemo(
    () => regions.filter((region) => liveOutlets.has(region.outlet)),
    [liveOutlets, regions],
  )
  const regionMap = useMemo(
    () => new Map(liveRegions.map((region) => [region.outlet, region])),
    [liveRegions],
  )
  const shellRoots = useMemo(
    () => shell ? [shell.root, ...liveRegions.map((region) => region.root)] : [],
    [liveRegions, shell],
  )
  const directlyPlacedContributions = useMemo(
    () => shellRoots.reduce(
      (ids, root) => contributionIds(root, ids, new Set(regionMap.keys())),
      new Set<string>(),
    ),
    [regionMap, shellRoots],
  )
  const rootRenderers = browserProgram.ui.rootRenderers()

  if (!shell) {
    return (
      <KernelRecovery
        host={clientHost}
        hostState={hostState}
        browserState={browserState}
        required
      />
    )
  }

  const renderFeature = (surface: UiSurface): ReactNode => {
    const Renderer = browserProgram.ui.renderer(surface)
    return Renderer ? <Renderer surface={surface} /> : null
  }

  const renderBuiltin = (node: ShellBuiltin): ReactNode => renderFeature({
    id: `kernel-${node.name}`,
    kind: node.name,
    ...(node.label === undefined ? {} : { label: node.label }),
    ...(node.appearance === undefined ? {} : { appearance: node.appearance }),
  })

  const renderSurface = (node: ShellSurface): ReactNode => {
    const surface = surfaceMap.get(node.id)
    return surface ? renderFeature(surface) : null
  }

  const renderSlot = (node: ShellSlot): ReactNode => {
    const Renderer = browserProgram.ui.contributionRenderer()
    const entries = contributions.filter((contribution) => (
      (contribution.slot ?? 'main') === node.name
      && !directlyPlacedContributions.has(contribution.id)
    ))
    if (!entries.length && !node.title && !node.empty) return null
    return (
      <section className={slotClass(node)} data-ui-slot={node.name}>
        {node.title && <div className="shell-slot-title">{node.title}</div>}
        {Renderer && entries.map((contribution) => (
          <Renderer contribution={contribution} key={contribution.id} />
        ))}
        {!entries.length && node.empty && <div className="shell-slot-empty">{node.empty}</div>}
      </section>
    )
  }

  const renderContribution = (node: ShellContribution): ReactNode => {
    const Renderer = browserProgram.ui.contributionRenderer()
    const contribution = contributions.find((candidate) => candidate.id === node.id)
    if (!contribution || !Renderer) return null
    return (
      <div className={`shell-slot shell-slot-${node.presentation ?? 'cards'} shell-direct-contribution`}>
        <Renderer contribution={contribution} />
      </div>
    )
  }

  const renderOutlet = (node: ShellOutlet): ReactNode => {
    const region = regionMap.get(node.name)
    const root = region?.root ?? node.fallback
    if (!root) return null
    return (
      <ShellTree
        node={root}
        path={region ? `region:${region.id}` : `outlet:${node.name}:fallback`}
        builtin={renderBuiltin}
        contribution={renderContribution}
        outlet={renderOutlet}
        surface={renderSurface}
        slot={renderSlot}
      />
    )
  }

  return (
    <div
      className={`shell-kernel shell-font-${shell.theme?.font ?? 'system'} shell-density-${shell.theme?.density ?? 'comfortable'} shell-corners-${shell.theme?.corners ?? 'soft'}`}
      style={themeStyle(shell.theme)}
      data-shell-id={shell.id}
      data-client-program-state={browserState.status}
    >
      <ShellTree
        node={shell.root}
        builtin={renderBuiltin}
        contribution={renderContribution}
        outlet={renderOutlet}
        surface={renderSurface}
        slot={renderSlot}
      />
      {rootRenderers.map(({ id, renderer: Renderer }) => <Renderer key={id} />)}
      <KernelRecovery host={clientHost} hostState={hostState} browserState={browserState} />
    </div>
  )
}
