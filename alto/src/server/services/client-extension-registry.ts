import type { Context, Plugin } from 'cordis'
import type { JsonValue } from '../../shared/protocol.js'

export type ClientExtensionHandler = (
  payload: JsonValue | undefined,
) => JsonValue | Promise<JsonValue>

export interface ClientExtensionMethodRegistration {
  dispose(): Promise<void>
}

export interface ClientExtensionStateRegistration {
  update(value: JsonValue): void
  dispose(): Promise<void>
}

interface RegisteredMethod {
  owner: string
  handler: ClientExtensionHandler
}

interface RegisteredState {
  owner: string
  value: JsonValue
}

export class ClientExtensionRegistry {
  private readonly methods = new Map<string, RegisteredMethod>()
  private readonly states = new Map<string, RegisteredState>()

  constructor(private readonly root: Context) {}

  registerMethod(
    owner: Context,
    name: string,
    handler: ClientExtensionHandler,
  ): ClientExtensionMethodRegistration {
    this.assertName(name)
    const entry = { owner: owner.fiber.name, handler }
    const dispose = owner.effect(() => {
      if (this.methods.has(name)) throw new Error(`client extension method "${name}" is already registered`)
      this.methods.set(name, entry)
      return () => {
        if (this.methods.get(name) === entry) this.methods.delete(name)
      }
    }, `clientExtensions.registerMethod(${JSON.stringify(name)})`)
    return { dispose: async () => dispose() }
  }

  registerState(
    owner: Context,
    name: string,
    value: JsonValue,
  ): ClientExtensionStateRegistration {
    this.assertName(name)
    const entry: RegisteredState = {
      owner: owner.fiber.name,
      value: structuredClone(value),
    }
    let active = false
    const dispose = owner.effect(() => {
      if (this.states.has(name)) throw new Error(`client extension state "${name}" is already registered`)
      active = true
      this.states.set(name, entry)
      this.emitChanged()
      return () => {
        active = false
        if (this.states.get(name) === entry) this.states.delete(name)
        this.emitChanged()
      }
    }, `clientExtensions.registerState(${JSON.stringify(name)})`)
    return {
      update: (next) => {
        if (!active) throw new Error(`client extension state "${name}" is not active`)
        entry.value = structuredClone(next)
        this.emitChanged()
      },
      dispose: async () => dispose(),
    }
  }

  async call(name: string, payload: JsonValue | undefined): Promise<JsonValue> {
    const method = this.methods.get(name)
    if (!method) throw new Error(`unknown client extension method: ${name}`)
    return method.handler(payload === undefined ? undefined : structuredClone(payload))
  }

  snapshot(): Record<string, JsonValue> {
    return Object.fromEntries(
      [...this.states.entries()].map(([name, entry]) => [name, structuredClone(entry.value)]),
    )
  }

  describe(): {
    methods: Array<{ name: string; owner: string }>
    states: Array<{ name: string; owner: string }>
  } {
    return {
      methods: [...this.methods].map(([name, entry]) => ({ name, owner: entry.owner })),
      states: [...this.states].map(([name, entry]) => ({ name, owner: entry.owner })),
    }
  }

  private assertName(name: string): void {
    if (!/^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/i.test(name) || name.length > 160) {
      throw new Error(`invalid client extension name: ${name}`)
    }
  }

  private emitChanged(): void {
    this.root.emit('clientExtensions/changed', this.snapshot())
  }
}

export const clientExtensionRegistryPlugin: Plugin = (ctx) => {
  ctx.provide('clientExtensions', new ClientExtensionRegistry(ctx.root))
}

clientExtensionRegistryPlugin.provide = 'clientExtensions'

declare module 'cordis' {
  interface Events {
    'clientExtensions/changed'(snapshot: Record<string, JsonValue>): void
  }
}
