import type { Plugin } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type {
  ProgramPluginView,
  UiSurface,
} from '../src/shared/protocol.js'
import type {
  BrowserPlugin,
  ClientContributionRenderer,
  ClientSurfaceRenderer,
} from '../src/client/plugin-api.js'
import type { ComposerDraft } from '../program/plugins/ui/composer.js'
import { BrowserProgramRuntime, OverlayStore } from '../src/client/plugin-runtime.js'

const surface: UiSurface = {
  id: 'test-surface',
  kind: 'brand',
}

function view(hash: string, url: string, enabled = true): ProgramPluginView {
  return {
    id: 'browser-test',
    name: 'Browser Test',
    description: 'Exercises the browser plugin runtime.',
    protocolVersion: 1,
    depth: 0,
    enabled,
    effectiveEnabled: enabled,
    state: enabled ? 'active' : 'disabled',
    inject: [],
    provides: [],
    config: {},
    isolate: {},
    intercept: {},
    ...(enabled ? {
      client: {
        module: 'plugins/browser-test.client.tsx',
        hash,
        url,
        loadedAt: '2026-08-18T00:00:00.000Z',
      },
    } : {}),
  }
}

function namedView(
  id: string,
  hash: string,
  url: string,
  enabled = true,
): ProgramPluginView {
  return {
    ...view(hash, url, enabled),
    id,
    name: id,
  }
}

function renderer(name: string): ClientSurfaceRenderer {
  const component = () => name
  component.displayName = name
  return component
}

function clientPlugin(
  component: ClientSurfaceRenderer,
  disposed: () => void,
): Plugin {
  const plugin: Plugin = (ctx) => {
    ctx.clientUi.registerSurface(ctx, surface.id, component)
    return () => disposed()
  }
  plugin.inject = ['clientUi']
  return plugin
}

describe('browser Cordis program runtime', () => {
  it('distinguishes modal overlays from lightweight HUDs for native panes', () => {
    const overlays = new OverlayStore()

    overlays.open('leader-hud', { occludesNativeViews: false })
    expect(overlays.snapshot()).toBe('leader-hud')
    expect(overlays.nativeViewsOccluded()).toBe(false)

    overlays.open('settings')
    expect(overlays.snapshot()).toBe('settings')
    expect(overlays.nativeViewsOccluded()).toBe(true)

    overlays.close('settings')
    expect(overlays.snapshot()).toBeUndefined()
    expect(overlays.nativeViewsOccluded()).toBe(false)
  })

  it('removes the contribution interpreter with its owning browser fiber', async () => {
    const renderer: ClientContributionRenderer = () => 'contribution'
    const plugin: Plugin = (ctx) => {
      ctx.clientUi.registerContributionRenderer(ctx, renderer)
    }
    plugin.inject = ['clientUi']
    const runtime = new BrowserProgramRuntime(async () => ({ default: plugin }))

    await runtime.reconcile(1, [view('contribution', '/contribution.mjs')])
    expect(runtime.ui.contributionRenderer()).toBe(renderer)

    await runtime.reconcile(2, [view('disabled', '/disabled.mjs', false)])
    expect(runtime.ui.contributionRenderer()).toBeUndefined()
    await runtime.dispose()
  })

  it('adds and removes root renderers with their owning browser fiber', async () => {
    const root = () => 'root overlay'
    const plugin: Plugin = (ctx) => {
      ctx.clientUi.registerRoot(ctx, 'test-root', root)
    }
    plugin.inject = ['clientUi']
    const runtime = new BrowserProgramRuntime(async () => ({ default: plugin }))

    await runtime.reconcile(1, [view('root', '/root.mjs')])
    expect(runtime.ui.rootRenderers()).toEqual([{ id: 'test-root', renderer: root }])

    await runtime.reconcile(2, [view('disabled', '/disabled.mjs', false)])
    expect(runtime.ui.rootRenderers()).toEqual([])
    await runtime.dispose()
  })

  it('adds and removes settings pages with their owning browser fiber', async () => {
    const settings = () => 'theme settings'
    const plugin: Plugin = (ctx) => {
      ctx.clientUi.registerSettingsPage(ctx, {
        id: 'theme',
        label: 'Theme',
        group: 'Personal',
        order: 20,
        renderer: settings,
      })
    }
    plugin.inject = ['clientUi']
    const runtime = new BrowserProgramRuntime(async () => ({ default: plugin }))

    await runtime.reconcile(1, [view('settings', '/settings.mjs')])
    expect(runtime.ui.settingsPages()).toEqual([expect.objectContaining({
      id: 'theme',
      label: 'Theme',
      renderer: settings,
    })])

    await runtime.reconcile(2, [view('disabled', '/disabled.mjs', false)])
    expect(runtime.ui.settingsPages()).toEqual([])
    await runtime.dispose()
  })

  it('publishes named component replacements to mounted consumers', async () => {
    const first = () => 'first component'
    const second = () => 'second component'
    const componentPlugin = (component: typeof first): BrowserPlugin => {
      const plugin: BrowserPlugin = (ctx) => {
        ctx.clientUi.registerComponent(ctx, 'chat.test', component)
      }
      plugin.inject = ['clientUi']
      return plugin
    }
    const modules = new Map<string, { default: BrowserPlugin }>([
      ['/first-component.mjs', { default: componentPlugin(first) }],
      ['/second-component.mjs', { default: componentPlugin(second) }],
    ])
    const runtime = new BrowserProgramRuntime(async (url) => {
      const module = modules.get(url)
      if (!module) throw new Error(`missing test module: ${url}`)
      return module
    })
    const changed = vi.fn()
    const unsubscribe = runtime.ui.subscribe(changed)

    await runtime.reconcile(1, [view('first-component', '/first-component.mjs')])
    expect(runtime.ui.component('chat.test')).toBe(first)
    changed.mockClear()

    await runtime.reconcile(2, [view('second-component', '/second-component.mjs')])
    expect(runtime.ui.component('chat.test')).toBe(second)
    expect(changed).toHaveBeenCalledOnce()

    unsubscribe()
    await runtime.dispose()
  })

  it('keeps the published renderers readable while a replacement is activating', async () => {
    const first = () => 'first'
    const second = () => 'second'
    let finish!: () => void
    let started!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const activating = new Promise<void>((resolve) => { started = resolve })
    const plugin = (component: typeof first, wait = false): BrowserPlugin => {
      const result: BrowserPlugin = async (ctx) => {
        if (wait) { started(); await pending }
        ctx.clientUi.registerSurface(ctx, surface.id, component)
        ctx.clientUi.registerComponent(ctx, 'chat.test', component)
        ctx.clientUi.registerRoot(ctx, 'test-root', component)
      }
      result.inject = ['clientUi']
      return result
    }
    const runtime = new BrowserProgramRuntime(async (url) => ({
      default: url === '/first.mjs' ? plugin(first) : plugin(second, true),
    }))
    try {
      await runtime.reconcile(1, [view('first', '/first.mjs')])
      const revision = runtime.ui.snapshot()
      const replacement = runtime.reconcile(2, [view('second', '/second.mjs')])
      await activating
      try {
        // Host events can render React even when UI notifications are batched.
        expect(runtime.ui.snapshot()).toBe(revision)
        expect(runtime.ui.renderer(surface)).toBe(first)
        expect(runtime.ui.component('chat.test')).toBe(first)
        expect(runtime.ui.rootRenderers()).toEqual([{ id: 'test-root', renderer: first }])
      } finally {
        finish()
        await replacement
      }
      expect(runtime.ui.renderer(surface)).toBe(second)
      expect(runtime.ui.component('chat.test')).toBe(second)
      await runtime.reconcile(3, [view('disabled', '/disabled.mjs', false)])
      expect(runtime.ui.renderer(surface)).toBeUndefined()
      expect(runtime.ui.component('chat.test')).toBeUndefined()
    } finally {
      finish()
      await runtime.dispose()
    }
  })

  it('adds and removes submit middleware with its owning browser fiber', async () => {
    const intercepted = vi.fn()
    const fallback = vi.fn(async (_draft: ComposerDraft) => undefined)
    const plugin: Plugin = (ctx) => {
      ctx.clientUi.registerSubmitMiddleware(ctx, async (draft, _next, request) => {
        intercepted(draft, request)
      }, { activeTurn: true })
    }
    plugin.inject = ['clientUi']
    const runtime = new BrowserProgramRuntime(async () => ({ default: plugin }))
    const draft: ComposerDraft = { text: 'queue me', images: [], attachments: [], skills: [] }

    await runtime.reconcile(1, [view('middleware', '/middleware.mjs')])
    expect(runtime.ui.canSubmitDuringTurn()).toBe(true)
    await runtime.ui.submit(draft, fallback, { mode: 'steer' })
    expect(intercepted).toHaveBeenCalledWith(draft, { mode: 'steer' })
    expect(fallback).not.toHaveBeenCalled()

    await runtime.reconcile(2, [view('disabled', '/disabled.mjs', false)])
    expect(runtime.ui.canSubmitDuringTurn()).toBe(false)
    await runtime.ui.submit(draft, fallback)
    expect(fallback).toHaveBeenCalledWith(draft)
    await runtime.dispose()
  })

  it('mounts and removes styles with their owning browser fiber', async () => {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const remove = vi.fn()
    const append = vi.fn()
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => ({ dataset: {}, textContent: '', remove }),
        head: { append },
      } as unknown as Document,
    })

    const styled: Plugin = (ctx) => {
      ctx.clientUi.registerStyle(ctx, 'test-style', '.test { color: purple; }')
    }
    styled.inject = ['clientUi']
    const runtime = new BrowserProgramRuntime(async () => ({ default: styled }))

    try {
      await runtime.reconcile(1, [view('styled', '/styled.mjs')])
      expect(append).toHaveBeenCalledOnce()
      expect(append.mock.calls[0]?.[0]).toMatchObject({
        dataset: { cordisPluginStyle: 'test-style' },
        textContent: '.test { color: purple; }',
      })

      await runtime.reconcile(2, [view('disabled', '/disabled.mjs', false)])
      expect(remove).toHaveBeenCalledOnce()
    } finally {
      await runtime.dispose()
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else delete (globalThis as { document?: Document }).document
    }
  })

  it('preserves stylesheet cascade order when an earlier plugin hot-swaps', async () => {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    type FakeStyle = {
      dataset: Record<string, string>
      textContent: string
      remove(): void
    }
    const mounted: FakeStyle[] = []
    const createStyle = (): FakeStyle => {
      const element: FakeStyle = {
        dataset: {},
        textContent: '',
        remove: () => {
          const index = mounted.indexOf(element)
          if (index >= 0) mounted.splice(index, 1)
        },
      }
      return element
    }
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: createStyle,
        head: {
          append: (element: FakeStyle) => mounted.push(element),
          insertBefore: (element: FakeStyle, successor: FakeStyle) => {
            mounted.splice(mounted.indexOf(successor), 0, element)
          },
        },
      } as unknown as Document,
    })

    const stylePlugin = (id: string, css: string): Plugin => {
      const plugin: Plugin = (ctx) => {
        ctx.clientUi.registerStyle(ctx, id, css)
      }
      plugin.inject = ['clientUi']
      return plugin
    }
    const modules = new Map<string, { default: Plugin }>([
      ['/base-v1.mjs', { default: stylePlugin('base', '.label { font-size: 12px; }') }],
      ['/base-v2.mjs', { default: stylePlugin('base', '.label { font-size: 13px; }') }],
      ['/sidebar.mjs', { default: stylePlugin('sidebar', '.label { font-size: 19px; }') }],
    ])
    const runtime = new BrowserProgramRuntime(async (url) => {
      const module = modules.get(url)
      if (!module) throw new Error(`missing test module: ${url}`)
      return module
    })

    try {
      const sidebar = namedView('sidebar', 'sidebar', '/sidebar.mjs')
      await runtime.reconcile(1, [
        namedView('base', 'base-v1', '/base-v1.mjs'),
        sidebar,
      ])
      await runtime.reconcile(2, [
        namedView('base', 'base-v2', '/base-v2.mjs'),
        sidebar,
      ])

      expect(mounted.map((element) => element.dataset.cordisPluginStyle))
        .toEqual(['base', 'sidebar'])
      expect(mounted.map((element) => element.textContent))
        .toEqual(['.label { font-size: 13px; }', '.label { font-size: 19px; }'])
    } finally {
      await runtime.dispose()
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else delete (globalThis as { document?: Document }).document
    }
  })

  it('hot-swaps one client fiber, tears it down, and restores it after activation failure', async () => {
    const firstRenderer = renderer('first')
    const secondRenderer = renderer('second')
    const firstDisposed = vi.fn()
    const secondDisposed = vi.fn()
    const modules = new Map<string, { default: Plugin }>([
      ['/first.mjs', { default: clientPlugin(firstRenderer, firstDisposed) }],
      ['/second.mjs', { default: clientPlugin(secondRenderer, secondDisposed) }],
      ['/broken.mjs', { default: (() => { throw new Error('client exploded') }) as Plugin }],
    ])
    const runtime = new BrowserProgramRuntime(async (url) => {
      const module = modules.get(url)
      if (!module) throw new Error(`missing test module: ${url}`)
      return module
    })

    await runtime.reconcile(1, [view('first', '/first.mjs')])
    expect(runtime.ui.renderer(surface)).toBe(firstRenderer)

    await runtime.reconcile(2, [view('second', '/second.mjs')])
    expect(firstDisposed).toHaveBeenCalledOnce()
    expect(runtime.ui.renderer(surface)).toBe(secondRenderer)

    await expect(runtime.reconcile(3, [view('missing', '/missing.mjs')]))
      .rejects.toThrow('previous UI was restored')
    expect(secondDisposed).not.toHaveBeenCalled()
    expect(runtime.ui.renderer(surface)).toBe(secondRenderer)
    expect(runtime.snapshot()).toMatchObject({
      status: 'failed',
      error: 'missing test module: /missing.mjs',
    })

    await expect(runtime.reconcile(4, [view('broken', '/broken.mjs')]))
      .rejects.toThrow('previous UI was restored')
    expect(secondDisposed).toHaveBeenCalledOnce()
    expect(runtime.ui.renderer(surface)).toBe(secondRenderer)
    expect(runtime.snapshot()).toMatchObject({ status: 'failed', error: 'client exploded' })

    await runtime.reconcile(5, [view('disabled', '/disabled.mjs', false)])
    expect(runtime.ui.renderer(surface)).toBeUndefined()
    await runtime.dispose()
  })

  it('validates declared browser services and resources before activation', async () => {
    const plugin = clientPlugin(renderer('resource'), () => undefined) as BrowserPlugin
    plugin.resources = { provides: { surfaces: [surface.id] } }
    const runtime = new BrowserProgramRuntime(async () => ({ default: plugin }))

    await runtime.reconcile(1, [view('resource', '/resource.mjs')], {
      ui: { regions: [], surfaces: [surface], contributions: [] },
      extensions: {},
    })
    expect(runtime.snapshot().plugins[0]).toMatchObject({
      id: 'browser-test',
      protocolVersion: 1,
      resources: { provides: { surfaces: [surface.id] } },
    })

    await expect(runtime.reconcile(2, [view('resource', '/resource.mjs')], {
      ui: { regions: [], surfaces: [], contributions: [] },
      extensions: {},
    })).rejects.toThrow('has no server descriptor')
    expect(runtime.ui.renderer(surface)).toBeDefined()
    await runtime.dispose()
  })

  it('keeps plugins pending until their browser service dependencies appear', async () => {
    const dependencyMismatch: BrowserPlugin = () => undefined
    dependencyMismatch.inject = ['clientTypo']
    const runtime = new BrowserProgramRuntime(async () => ({ default: dependencyMismatch }))

    await runtime.reconcile(1, [view('dependency', '/dependency.mjs')])
    expect(runtime.snapshot()).toMatchObject({
      status: 'active',
      diagnostics: [{
        pluginId: 'browser-test',
        severity: 'warning',
        message: 'Browser plugin "browser-test" is waiting for service "clientTypo"',
      }],
    })

    const protocolMismatch: BrowserPlugin = () => undefined
    protocolMismatch.protocolVersion = 2
    const protocolRuntime = new BrowserProgramRuntime(async () => ({ default: protocolMismatch }))
    await expect(protocolRuntime.reconcile(1, [view('protocol', '/protocol.mjs')]))
      .rejects.toThrow('implements protocol 2, but the profile requires 1')

    await runtime.dispose()
    await protocolRuntime.dispose()
  })

  it('unloads dependents with a disabled provider and restores them when it returns', async () => {
    const provider: BrowserPlugin = (ctx) => {
      ctx.provide('clientDependencyTest', true)
    }
    provider.provide = 'clientDependencyTest'
    const dependentRoot = () => 'dependent root'
    const dependent: BrowserPlugin = (ctx) => {
      ctx.clientUi.registerRoot(ctx, 'dependent-root', dependentRoot)
    }
    dependent.inject = ['clientUi', 'clientDependencyTest']
    dependent.resources = { provides: { roots: ['dependent-root'] } }
    const modules = new Map<string, { default: BrowserPlugin }>([
      ['/provider.mjs', { default: provider }],
      ['/dependent.mjs', { default: dependent }],
    ])
    const runtime = new BrowserProgramRuntime(async (url) => {
      const module = modules.get(url)
      if (!module) throw new Error(`missing test module: ${url}`)
      return module
    })
    const providerView = namedView('provider', 'provider', '/provider.mjs')
    const dependentView = namedView('dependent', 'dependent', '/dependent.mjs')

    await runtime.reconcile(1, [providerView, dependentView])
    expect(runtime.ui.rootRenderers()).toEqual([{ id: 'dependent-root', renderer: dependentRoot }])

    await runtime.reconcile(2, [
      namedView('provider', 'provider-off', '/provider-off.mjs', false),
      dependentView,
    ])
    expect(runtime.ui.rootRenderers()).toEqual([])
    expect(runtime.snapshot()).toMatchObject({
      status: 'active',
      diagnostics: [{
        pluginId: 'dependent',
        severity: 'warning',
        message: 'Browser plugin "dependent" is waiting for service "clientDependencyTest"',
      }],
    })

    await runtime.reconcile(3, [providerView, dependentView])
    expect(runtime.ui.rootRenderers()).toEqual([{ id: 'dependent-root', renderer: dependentRoot }])
    expect(runtime.snapshot().diagnostics).toEqual([])
    await runtime.dispose()
  })
})
