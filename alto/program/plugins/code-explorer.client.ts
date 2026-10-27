import type { Context } from 'cordis'
import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import type {
  ClientCodeExplorerService,
  ClientCodeExplorerSnapshot,
  CodeExplorerContribution,
  CodeExplorerRegistration,
} from './code-explorer-api.js'

export class CodeExplorerRegistry implements ClientCodeExplorerService {
  private readonly contributions = new Map<string, CodeExplorerContribution>()
  private readonly listeners = new Set<() => void>()
  private state: ClientCodeExplorerSnapshot = { revision: 0 }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ClientCodeExplorerSnapshot => this.state

  register(owner: Context, contribution: CodeExplorerContribution): CodeExplorerRegistration {
    let active = false
    const dispose = owner.effect(() => {
      if (this.contributions.has(contribution.id)) {
        throw new Error(`Code explorer "${contribution.id}" is already registered`)
      }
      active = true
      this.contributions.set(contribution.id, contribution)
      this.emit()
      return () => {
        active = false
        if (this.contributions.get(contribution.id) === contribution) {
          this.contributions.delete(contribution.id)
        }
        this.emit()
      }
    }, `clientCodeExplorer.register(${JSON.stringify(contribution.id)})`)
    return { dispose: async () => { if (active) await dispose() } }
  }

  dispose(): void {
    this.contributions.clear()
    this.listeners.clear()
    this.state = { revision: this.state.revision + 1 }
  }

  private emit(): void {
    const explorer = [...this.contributions.values()].toSorted((left, right) => (
      (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id)
    ))[0]
    this.state = {
      revision: this.state.revision + 1,
      ...(explorer ? { explorer } : {}),
    }
    for (const listener of this.listeners) listener()
  }
}

const codeExplorer: BrowserPlugin = (ctx) => {
  const registry = new CodeExplorerRegistry()
  ctx.provide('clientCodeExplorer', registry)
  return () => registry.dispose()
}

codeExplorer.provide = 'clientCodeExplorer'

export default codeExplorer
