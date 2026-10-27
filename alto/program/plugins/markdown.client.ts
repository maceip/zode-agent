import { createMarkdownContentRenderer } from './markdown-content.js'
import type { Context } from 'cordis'
import type { BrowserPlugin, ClientUiService } from '../../src/client/plugin-api.js'
import type {
  ClientMarkdownService,
  ClientMarkdownSnapshot,
  MarkdownCodeBlockRegistration,
  MarkdownCodeBlockRenderer,
  MarkdownFileLinkHandler,
  MarkdownFileLinkRegistration,
  MarkdownMathRegistration,
  MarkdownMathRenderer,
} from './markdown-api.js'
import styles from './markdown.css'

interface PrioritizedRenderer {
  id: string
  priority?: number
}

function prioritized<T extends PrioritizedRenderer>(renderers: Map<string, T>): readonly T[] {
  return [...renderers.values()].toSorted((left, right) => (
    (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id)
  ))
}

function preferred<T extends PrioritizedRenderer>(renderers: Map<string, T>): T | undefined {
  return prioritized(renderers)[0]
}

export class MarkdownRendererRegistry implements ClientMarkdownService {
  private readonly codeBlocks = new Map<string, MarkdownCodeBlockRenderer>()
  private readonly fileLinks = new Map<string, MarkdownFileLinkHandler>()
  private readonly math = new Map<string, MarkdownMathRenderer>()
  private readonly listeners = new Set<() => void>()
  private state: ClientMarkdownSnapshot = { revision: 0, codeBlocks: [], fileLinks: [] }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientMarkdownSnapshot => this.state

  registerCodeBlock(
    owner: Context,
    renderer: MarkdownCodeBlockRenderer,
  ): MarkdownCodeBlockRegistration {
    let active = false
    const dispose = owner.effect(() => {
      if (this.codeBlocks.has(renderer.id)) {
        throw new Error(`Markdown code-block renderer "${renderer.id}" is already registered`)
      }
      active = true
      this.codeBlocks.set(renderer.id, renderer)
      this.emit()
      return () => {
        active = false
        if (this.codeBlocks.get(renderer.id) === renderer) this.codeBlocks.delete(renderer.id)
        this.emit()
      }
    }, `clientMarkdown.registerCodeBlock(${JSON.stringify(renderer.id)})`)

    return {
      dispose: async () => {
        if (active) await dispose()
      },
    }
  }

  registerMath(
    owner: Context,
    renderer: MarkdownMathRenderer,
  ): MarkdownMathRegistration {
    let active = false
    const dispose = owner.effect(() => {
      if (this.math.has(renderer.id)) {
        throw new Error(`Markdown math renderer "${renderer.id}" is already registered`)
      }
      active = true
      this.math.set(renderer.id, renderer)
      this.emit()
      return () => {
        active = false
        if (this.math.get(renderer.id) === renderer) this.math.delete(renderer.id)
        this.emit()
      }
    }, `clientMarkdown.registerMath(${JSON.stringify(renderer.id)})`)

    return {
      dispose: async () => {
        if (active) await dispose()
      },
    }
  }

  registerFileLink(
    owner: Context,
    handler: MarkdownFileLinkHandler,
  ): MarkdownFileLinkRegistration {
    let active = false
    const dispose = owner.effect(() => {
      if (this.fileLinks.has(handler.id)) {
        throw new Error(`Markdown file-link handler "${handler.id}" is already registered`)
      }
      active = true
      this.fileLinks.set(handler.id, handler)
      this.emit()
      return () => {
        active = false
        if (this.fileLinks.get(handler.id) === handler) this.fileLinks.delete(handler.id)
        this.emit()
      }
    }, `clientMarkdown.registerFileLink(${JSON.stringify(handler.id)})`)

    return {
      dispose: async () => {
        if (active) await dispose()
      },
    }
  }

  dispose(): void {
    this.codeBlocks.clear()
    this.fileLinks.clear()
    this.math.clear()
    this.listeners.clear()
    this.state = { revision: this.state.revision + 1, codeBlocks: [], fileLinks: [] }
  }

  private emit(): void {
    const codeBlocks = prioritized(this.codeBlocks)
    const fileLinks = prioritized(this.fileLinks)
    const math = preferred(this.math)
    this.state = {
      revision: this.state.revision + 1,
      codeBlocks,
      fileLinks,
      ...(math ? { math } : {}),
    }
    for (const listener of this.listeners) listener()
  }
}

const markdownClient: BrowserPlugin = (ctx) => {
  const ui = ctx.get('clientUi') as ClientUiService
  ui.registerStyle(ctx, 'markdown-typography', String(styles))
  const registry = new MarkdownRendererRegistry()
  ctx.provide('clientMarkdown', registry)
  ui.registerComponent(ctx, 'markdown.content', createMarkdownContentRenderer(registry))
  return () => registry.dispose()
}

markdownClient.inject = ['clientUi']
markdownClient.provide = 'clientMarkdown'
markdownClient.resources = { provides: { components: ['markdown.content'] } }

export default markdownClient
