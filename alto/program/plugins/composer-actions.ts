import type { Context } from 'cordis'
import type { ComponentType } from 'react'
import type { ClientSessionService } from './session-api.js'

export interface ComposerActionProps {
  session: ClientSessionService
}

export interface ComposerAction {
  id: string
  order?: number
  component: ComponentType<ComposerActionProps>
}

export class ComposerActions {
  private actions: readonly ComposerAction[] = []
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): readonly ComposerAction[] => this.actions

  register(owner: Context, action: ComposerAction): () => Promise<void> {
    return owner.effect(() => {
      if (this.actions.some((entry) => entry.id === action.id)) {
        throw new Error(`Composer action "${action.id}" is already registered`)
      }
      this.actions = [...this.actions, action].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      this.changed()
      return () => {
        this.actions = this.actions.filter((entry) => entry !== action)
        this.changed()
      }
    }, `clientComposer.actions.register(${JSON.stringify(action.id)})`)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}
