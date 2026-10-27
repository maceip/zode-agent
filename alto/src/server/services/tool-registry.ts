import type { Context, Plugin } from 'cordis'
import type { DynamicToolSpec } from '../../shared/protocol.js'
import { errorMessage, isRecord } from '../../shared/protocol.js'
import type {
  DynamicToolCall,
  DynamicToolHandler,
  DynamicToolHandlerResult,
  DynamicToolResult,
} from '../plugin-api.js'

interface RegisteredTool {
  spec: DynamicToolSpec
  handler: DynamicToolHandler
  owner: string
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
export const DISPATCHER_NAME = 'cordis'

const DISPATCHER_SPEC: DynamicToolSpec = {
  name: DISPATCHER_NAME,
  description: 'Discover and invoke the live Cordis tool set. Call list whenever capabilities may have changed; invoke resolves the current owning fiber at call time.',
  inputSchema: {
    type: 'object',
    required: ['operation'],
    properties: {
      operation: {
        type: 'string',
        enum: ['list', 'describe', 'invoke'],
      },
      tool: {
        type: 'string',
        description: 'Tool name, or namespace/name for a namespaced tool.',
      },
      arguments: {
        type: 'object',
        description: 'Arguments passed to the selected live tool.',
        additionalProperties: true,
      },
    },
    additionalProperties: false,
  },
}

function toolKey(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}/${name}` : name
}

function toolAddress(value: string): { name: string; namespace?: string } {
  const parts = value.split('/')
  if (parts.length === 1 && TOOL_NAME.test(parts[0] ?? '')) return { name: parts[0] ?? '' }
  const [namespace, name] = parts
  if (
    parts.length === 2
    && namespace
    && name
    && TOOL_NAME.test(namespace)
    && TOOL_NAME.test(name)
  ) return { namespace, name }
  throw new Error('tool must be a name or namespace/name')
}

function asToolResult(value: DynamicToolHandlerResult): DynamicToolResult {
  if (
    isRecord(value)
    && typeof value.success === 'boolean'
    && Array.isArray(value.contentItems)
  ) {
    return value as unknown as DynamicToolResult
  }

  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value, null, 2)
  return {
    success: true,
    contentItems: [{ type: 'inputText', text }],
  }
}

export class DynamicToolRegistry {
  private readonly entries = new Map<string, RegisteredTool>()

  constructor(private readonly root: Context) {}

  register(
    owner: Context,
    spec: DynamicToolSpec,
    handler: DynamicToolHandler,
  ): () => Promise<void> {
    this.validateSpec(spec)
    const key = toolKey(spec.namespace, spec.name)
    if (key === DISPATCHER_NAME) {
      throw new Error(`dynamic tool name "${DISPATCHER_NAME}" is reserved`)
    }

    return owner.effect(() => {
      if (this.entries.has(key)) {
        throw new Error(`dynamic tool "${key}" is already registered`)
      }
      this.entries.set(key, {
        spec: structuredClone(spec),
        handler,
        owner: owner.fiber.name,
      })
      this.root.emit('tools/changed')
      return () => {
        this.entries.delete(key)
        this.root.emit('tools/changed')
      }
    }, `tools.register(${JSON.stringify(key)})`)
  }

  private validateSpec(spec: DynamicToolSpec): void {
    if (!TOOL_NAME.test(spec.name)) {
      throw new Error(`invalid dynamic tool name "${spec.name}"`)
    }
    if (spec.namespace && !TOOL_NAME.test(spec.namespace)) {
      throw new Error(`invalid dynamic tool namespace "${spec.namespace}"`)
    }
    if (!spec.description.trim()) {
      throw new Error(`dynamic tool "${spec.name}" needs a description`)
    }
    if (!isRecord(spec.inputSchema)) {
      throw new Error(`dynamic tool "${spec.name}" needs an object input schema`)
    }
  }

  list(): DynamicToolSpec[] {
    return [...this.entries.values()]
      .map(({ spec }) => structuredClone(spec))
      .sort((left, right) => toolKey(left.namespace, left.name)
        .localeCompare(toolKey(right.namespace, right.name)))
  }

  describe(): Array<DynamicToolSpec & { owner: string }> {
    return [...this.entries.values()]
      .map(({ spec, owner }) => ({ ...structuredClone(spec), owner }))
      .sort((left, right) => toolKey(left.namespace, left.name)
        .localeCompare(toolKey(right.namespace, right.name)))
  }

  toAppServerSpecs(): Array<Record<string, unknown>> {
    return [{
      type: 'function',
      name: DISPATCHER_SPEC.name,
      description: DISPATCHER_SPEC.description,
      inputSchema: structuredClone(DISPATCHER_SPEC.inputSchema),
    }]
  }

  async execute(call: DynamicToolCall): Promise<DynamicToolResult> {
    if (!call.namespace && call.tool === DISPATCHER_NAME) {
      return this.executeDispatcher(call)
    }
    return this.executeRegistered(call)
  }

  private async executeDispatcher(call: DynamicToolCall): Promise<DynamicToolResult> {
    if (!isRecord(call.arguments) || typeof call.arguments.operation !== 'string') {
      return asToolResult({
        operation: 'error',
        message: 'operation must be list, describe, or invoke',
      })
    }

    const operation = call.arguments.operation
    if (operation === 'list') {
      return asToolResult({
        tools: this.describe().map(({ owner: _owner, ...spec }) => ({
          name: toolKey(spec.namespace, spec.name),
          description: spec.description,
        })),
      })
    }

    if (typeof call.arguments.tool !== 'string') {
      return asToolResult({ operation: 'error', message: 'tool must be a string' })
    }
    let address: { name: string; namespace?: string }
    try {
      address = toolAddress(call.arguments.tool)
    } catch (error) {
      return {
        success: false,
        contentItems: [{ type: 'inputText', text: errorMessage(error) }],
      }
    }

    const key = toolKey(address.namespace, address.name)
    const entry = this.entries.get(key)
    if (!entry) {
      return {
        success: false,
        contentItems: [{
          type: 'inputText',
          text: `Dynamic tool "${key}" is not installed. Call ${DISPATCHER_NAME} with operation "list" to refresh capabilities.`,
        }],
      }
    }
    if (operation === 'describe') {
      return asToolResult({
        name: key,
        description: entry.spec.description,
        inputSchema: entry.spec.inputSchema,
      })
    }
    if (operation !== 'invoke') {
      return asToolResult({
        operation: 'error',
        message: 'operation must be list, describe, or invoke',
      })
    }

    return this.executeRegistered({
      ...call,
      tool: address.name,
      ...(address.namespace ? { namespace: address.namespace } : { namespace: null }),
      arguments: call.arguments.arguments ?? {},
    })
  }

  private async executeRegistered(call: DynamicToolCall): Promise<DynamicToolResult> {
    const key = toolKey(call.namespace ?? undefined, call.tool)
    const entry = this.entries.get(key)
    if (!entry) {
      return {
        success: false,
        contentItems: [{
          type: 'inputText',
          text: `Dynamic tool "${key}" belongs to this task's older tool set and is not installed. `
            + 'Codex App Server cannot attach replacement dynamic tools after a task starts. '
            + 'Do not emulate Alto workspace actions with shell commands, browser automation, '
            + 'Codex task controls, or a Terminal pane. Start a new Alto chat to receive the stable '
            + 'cordis dispatcher and current live capabilities.',
        }],
      }
    }

    try {
      return asToolResult(await entry.handler(call))
    } catch (error) {
      return {
        success: false,
        contentItems: [{ type: 'inputText', text: errorMessage(error) }],
      }
    }
  }
}

export const toolRegistryPlugin: Plugin = (ctx: Context) => {
  ctx.provide('tools', new DynamicToolRegistry(ctx.root))
}

toolRegistryPlugin.provide = 'tools'

declare module 'cordis' {
  interface Events {
    'tools/changed'(): void
  }
}
