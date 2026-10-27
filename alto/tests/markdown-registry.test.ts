import { Context, type Plugin } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownRendererRegistry } from '../program/plugins/markdown.client.js'
import {
  openMarkdownFileLink,
  resolveMarkdownCodeBlock,
  resolveMarkdownFileLink,
} from '../program/plugins/markdown-api.js'

describe('Markdown renderer registry', () => {
  it('selects the highest-priority renderer and restores the previous one on teardown', async () => {
    const context = new Context()
    const registry = new MarkdownRendererRegistry()
    const Default = () => 'default'
    const Override = () => 'override'
    const defaultPlugin: Plugin = (ctx) => {
      registry.registerCodeBlock(ctx, { id: 'default', component: Default })
    }
    const overridePlugin: Plugin = (ctx) => {
      registry.registerCodeBlock(ctx, { id: 'override', component: Override, priority: 10 })
    }
    const defaultFiber = await context.plugin(defaultPlugin)
    const overrideFiber = await context.plugin(overridePlugin)

    try {
      expect(resolveMarkdownCodeBlock(registry.snapshot().codeBlocks, 'typescript')?.component)
        .toBe(Override)

      await overrideFiber.dispose()

      expect(resolveMarkdownCodeBlock(registry.snapshot().codeBlocks, 'typescript')?.component)
        .toBe(Default)
    } finally {
      await defaultFiber.dispose()
      registry.dispose()
    }
  })

  it('falls through language-specific renderers without replacing ordinary code blocks', async () => {
    const context = new Context()
    const registry = new MarkdownRendererRegistry()
    const Default = () => 'default'
    const Mermaid = () => 'mermaid'
    const defaultFiber = await context.plugin((ctx) => {
      registry.registerCodeBlock(ctx, { id: 'default', component: Default })
    })
    const mermaidFiber = await context.plugin((ctx) => {
      registry.registerCodeBlock(ctx, {
        id: 'mermaid',
        component: Mermaid,
        languages: ['mermaid'],
        priority: 100,
      })
    })

    try {
      expect(resolveMarkdownCodeBlock(registry.snapshot().codeBlocks, 'MERMAID')?.component)
        .toBe(Mermaid)
      expect(resolveMarkdownCodeBlock(registry.snapshot().codeBlocks, 'typescript')?.component)
        .toBe(Default)

      await mermaidFiber.dispose()

      expect(resolveMarkdownCodeBlock(registry.snapshot().codeBlocks, 'mermaid')?.component)
        .toBe(Default)
    } finally {
      await defaultFiber.dispose()
      registry.dispose()
    }
  })

  it('removes math syntax and rendering together when its fiber unloads', async () => {
    const context = new Context()
    const registry = new MarkdownRendererRegistry()
    const Math = () => 'math'
    const plugin: Plugin = (ctx) => {
      registry.registerMath(ctx, {
        id: 'math',
        component: Math,
        remarkPlugins: [],
      })
    }
    const fiber = await context.plugin(plugin)

    try {
      expect(registry.snapshot().math?.component).toBe(Math)

      await fiber.dispose()

      expect(registry.snapshot().math).toBeUndefined()
    } finally {
      registry.dispose()
    }
  })

  it('removes file-link behavior when its fiber unloads', async () => {
    const context = new Context()
    const registry = new MarkdownRendererRegistry()
    const plugin: Plugin = (ctx) => {
      registry.registerFileLink(ctx, {
        id: 'markdown-files',
        extensions: ['.md', '.markdown'],
        open: () => undefined,
      })
    }
    const fiber = await context.plugin(plugin)

    try {
      expect(resolveMarkdownFileLink(registry.snapshot().fileLinks, '/tmp/report.MD')?.id)
        .toBe('markdown-files')

      await fiber.dispose()

      expect(resolveMarkdownFileLink(registry.snapshot().fileLinks, '/tmp/report.md'))
        .toBeUndefined()
    } finally {
      registry.dispose()
    }
  })

  it('lets a file-link handler match extensionless source files', async () => {
    const context = new Context()
    const registry = new MarkdownRendererRegistry()
    const fiber = await context.plugin((ctx) => {
      registry.registerFileLink(ctx, {
        id: 'source-files',
        matches: (filePath) => filePath.endsWith('/Makefile'),
        open: () => undefined,
      })
    })

    try {
      expect(resolveMarkdownFileLink(registry.snapshot().fileLinks, '/tmp/project/Makefile')?.id)
        .toBe('source-files')
      expect(resolveMarkdownFileLink(registry.snapshot().fileLinks, '/tmp/project/image.png'))
        .toBeUndefined()
    } finally {
      await fiber.dispose()
      registry.dispose()
    }
  })
})

it('tries matching file handlers in priority order when an editor declines a link', () => {
  const editor = vi.fn().mockReturnValue(false)
  const viewer = vi.fn()
  const unrelated = vi.fn()
  const handlers = [
    { id: 'pdf', extensions: ['.pdf'], open: unrelated },
    { id: 'editor', extensions: ['.rs'], open: editor },
    { id: 'source', extensions: ['.rs'], open: viewer },
  ]
  const details = { label: 'main.rs', path: '/repo/main.rs', line: 5 }
  const origin = {} as HTMLElement
  expect(openMarkdownFileLink(handlers, details, origin)).toBe(true)
  expect(viewer).toHaveBeenCalledWith(details, origin)
  expect(unrelated).not.toHaveBeenCalled()
  viewer.mockClear()
  editor.mockReturnValue(true)
  expect(openMarkdownFileLink(handlers, details, origin)).toBe(true)
  expect(viewer).not.toHaveBeenCalled()
  expect(openMarkdownFileLink(handlers, { label: 'image.png', path: '/repo/image.png' }, origin)).toBe(false)
})
