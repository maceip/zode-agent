import type { Context, Plugin } from 'cordis'
import type {
  UiAction,
  UiContribution,
  UiShell,
  UiShellRegion,
  UiSnapshot,
  UiSurface,
} from '../../shared/protocol.js'
import {
  normalizeAction,
  normalizeContribution,
  normalizeShell,
  normalizeShellRegion,
  normalizeSurface,
} from './ui-language.js'

export type UiActionHandler = (action: UiAction) => unknown | Promise<unknown>

export interface UiRegistration {
  update(contribution: UiContribution): void
  dispose(): Promise<void>
}

export interface UiShellRegistration {
  update(shell: UiShell): void
  dispose(): Promise<void>
}

export interface UiShellRegionRegistration {
  update(region: UiShellRegion): void
  dispose(): Promise<void>
}

export interface UiSurfaceRegistration {
  update(surface: UiSurface): void
  dispose(): Promise<void>
}

interface RegisteredContribution {
  contribution: UiContribution
  handler?: UiActionHandler
  owner: string
}

interface RegisteredShell {
  shell: UiShell
  owner: string
}

interface RegisteredShellRegion {
  region: UiShellRegion
  owner: string
}

interface RegisteredSurface {
  surface: UiSurface
  owner: string
}

function contributionHasActions(contribution: UiContribution): boolean {
  const visit = (nodes: UiContribution['nodes']): boolean => nodes.some((node) => (
    node.type === 'button'
    || ((node.type === 'row' || node.type === 'group') && visit(node.children))
  ))
  return visit(contribution.nodes)
}

export class UiRegistry {
  private readonly entries = new Map<string, RegisteredContribution>()
  private readonly regions = new Map<string, RegisteredShellRegion>()
  private readonly regionOutlets = new Map<string, string>()
  private readonly surfaces = new Map<string, RegisteredSurface>()
  private shellEntry?: RegisteredShell
  private batchDepth = 0
  private batchChanged = false

  constructor(private readonly root: Context) {}

  register(
    owner: Context,
    contribution: UiContribution,
    handler?: UiActionHandler,
  ): UiRegistration {
    const initial = normalizeContribution(contribution)
    if (contributionHasActions(initial) && !handler) {
      throw new Error(`UI contribution "${initial.id}" declares actions without a handler`)
    }
    let active = false

    const dispose = owner.effect(() => {
      if (this.entries.has(initial.id)) {
        throw new Error(`UI contribution "${initial.id}" is already registered`)
      }
      active = true
      this.entries.set(initial.id, {
        contribution: initial,
        ...(handler ? { handler } : {}),
        owner: owner.fiber.name,
      })
      this.emitChanged()
      return () => {
        active = false
        this.entries.delete(initial.id)
        this.emitChanged()
      }
    }, `ui.register(${JSON.stringify(initial.id)})`)

    return {
      update: (next) => {
        if (!active) throw new Error(`UI contribution "${initial.id}" is not active`)
        const normalized = normalizeContribution(next)
        if (normalized.id !== initial.id) {
          throw new Error('a UI contribution cannot change its id while active')
        }
        this.entries.set(initial.id, {
          contribution: normalized,
          ...(handler ? { handler } : {}),
          owner: owner.fiber.name,
        })
        this.emitChanged()
      },
      dispose: async () => {
        await dispose()
      },
    }
  }

  registerShell(owner: Context, shell: UiShell): UiShellRegistration {
    const entry: RegisteredShell = {
      shell: normalizeShell(shell),
      owner: owner.fiber.name,
    }
    let active = false

    const dispose = owner.effect(() => {
      if (this.shellEntry) {
        throw new Error(`UI shell "${this.shellEntry.shell.id}" is already registered`)
      }
      active = true
      this.shellEntry = entry
      this.emitChanged()
      return () => {
        active = false
        if (this.shellEntry === entry) delete this.shellEntry
        this.emitChanged()
      }
    }, `ui.registerShell(${JSON.stringify(entry.shell.id)})`)

    return {
      update: (next) => {
        if (!active) throw new Error(`UI shell "${entry.shell.id}" is not active`)
        const normalized = normalizeShell(next)
        if (normalized.id !== entry.shell.id) {
          throw new Error('a UI shell cannot change its id while active')
        }
        entry.shell = normalized
        this.emitChanged()
      },
      dispose: async () => {
        await dispose()
      },
    }
  }

  registerSurface(owner: Context, surface: UiSurface): UiSurfaceRegistration {
    const entry: RegisteredSurface = {
      surface: normalizeSurface(surface),
      owner: owner.fiber.name,
    }
    let active = false
    const dispose = owner.effect(() => {
      if (this.surfaces.has(entry.surface.id)) {
        throw new Error(`UI surface "${entry.surface.id}" is already registered`)
      }
      active = true
      this.surfaces.set(entry.surface.id, entry)
      this.emitChanged()
      return () => {
        active = false
        if (this.surfaces.get(entry.surface.id) === entry) {
          this.surfaces.delete(entry.surface.id)
        }
        this.emitChanged()
      }
    }, `ui.registerSurface(${JSON.stringify(entry.surface.id)})`)

    return {
      update: (next) => {
        if (!active) throw new Error(`UI surface "${entry.surface.id}" is not active`)
        const normalized = normalizeSurface(next)
        if (normalized.id !== entry.surface.id) {
          throw new Error('a UI surface cannot change its id while active')
        }
        entry.surface = normalized
        this.emitChanged()
      },
      dispose: async () => {
        await dispose()
      },
    }
  }

  registerShellRegion(
    owner: Context,
    region: UiShellRegion,
  ): UiShellRegionRegistration {
    const entry: RegisteredShellRegion = {
      region: normalizeShellRegion(region),
      owner: owner.fiber.name,
    }
    let active = false
    const dispose = owner.effect(() => {
      if (this.regions.has(entry.region.id)) {
        throw new Error(`UI shell region "${entry.region.id}" is already registered`)
      }
      const occupant = this.regionOutlets.get(entry.region.outlet)
      if (occupant) {
        throw new Error(
          `UI shell outlet "${entry.region.outlet}" is already occupied by "${occupant}"`,
        )
      }
      active = true
      this.regions.set(entry.region.id, entry)
      this.regionOutlets.set(entry.region.outlet, entry.region.id)
      this.emitChanged()
      return () => {
        active = false
        if (this.regions.get(entry.region.id) === entry) {
          this.regions.delete(entry.region.id)
        }
        if (this.regionOutlets.get(entry.region.outlet) === entry.region.id) {
          this.regionOutlets.delete(entry.region.outlet)
        }
        this.emitChanged()
      }
    }, `ui.registerShellRegion(${JSON.stringify(entry.region.id)})`)

    return {
      update: (next) => {
        if (!active) throw new Error(`UI shell region "${entry.region.id}" is not active`)
        const normalized = normalizeShellRegion(next)
        if (normalized.id !== entry.region.id) {
          throw new Error('a UI shell region cannot change its id while active')
        }
        if (normalized.outlet !== entry.region.outlet) {
          throw new Error('a UI shell region cannot change its outlet while active')
        }
        entry.region = normalized
        this.emitChanged()
      },
      dispose: async () => {
        await dispose()
      },
    }
  }

  list(): UiContribution[] {
    return [...this.entries.values()]
      .map(({ contribution }) => structuredClone(contribution))
      .sort((left, right) => (
        (left.order ?? 0) - (right.order ?? 0)
        || left.id.localeCompare(right.id)
      ))
  }

  listSurfaces(): UiSurface[] {
    return [...this.surfaces.values()]
      .map(({ surface }) => structuredClone(surface))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  listShellRegions(): UiShellRegion[] {
    return [...this.regions.values()]
      .map(({ region }) => structuredClone(region))
      .sort((left, right) => (
        left.outlet.localeCompare(right.outlet) || left.id.localeCompare(right.id)
      ))
  }

  describe(): {
    shell: (UiShell & { owner: string }) | null
    regions: Array<UiShellRegion & { owner: string }>
    surfaces: Array<UiSurface & { owner: string }>
    contributions: Array<UiContribution & { owner: string }>
  } {
    return {
      shell: this.shellEntry
        ? { ...structuredClone(this.shellEntry.shell), owner: this.shellEntry.owner }
        : null,
      regions: [...this.regions.values()]
        .map(({ region, owner }) => ({ ...structuredClone(region), owner }))
        .sort((left, right) => (
          left.outlet.localeCompare(right.outlet) || left.id.localeCompare(right.id)
        )),
      surfaces: [...this.surfaces.values()]
        .map(({ surface, owner }) => ({ ...structuredClone(surface), owner }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      contributions: [...this.entries.values()]
        .map(({ contribution, owner }) => ({ ...structuredClone(contribution), owner }))
        .sort((left, right) => (
          (left.order ?? 0) - (right.order ?? 0)
          || left.id.localeCompare(right.id)
        )),
    }
  }

  snapshot(): UiSnapshot {
    return {
      ...(this.shellEntry ? { shell: structuredClone(this.shellEntry.shell) } : {}),
      regions: this.listShellRegions(),
      surfaces: this.listSurfaces(),
      contributions: this.list(),
    }
  }

  async batch<T>(operation: () => T | Promise<T>): Promise<T> {
    this.batchDepth += 1
    try {
      return await operation()
    } finally {
      this.batchDepth -= 1
      if (this.batchDepth === 0 && this.batchChanged) {
        this.batchChanged = false
        this.root.emit('ui/changed', this.snapshot())
      }
    }
  }

  async execute(action: UiAction): Promise<unknown> {
    const entry = this.entries.get(action.contributionId)
    if (!entry) throw new Error(`unknown UI contribution: ${action.contributionId}`)
    if (!entry.handler) {
      throw new Error(`UI contribution "${action.contributionId}" does not handle actions`)
    }
    return entry.handler(normalizeAction(action))
  }

  private emitChanged(): void {
    if (this.batchDepth > 0) {
      this.batchChanged = true
      return
    }
    this.root.emit('ui/changed', this.snapshot())
  }
}

export const uiRegistryPlugin: Plugin = (ctx: Context) => {
  ctx.provide('ui', new UiRegistry(ctx.root))
}

uiRegistryPlugin.provide = 'ui'

declare module 'cordis' {
  interface Events {
    'ui/changed'(snapshot: UiSnapshot): void
  }
}
