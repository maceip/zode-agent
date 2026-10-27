import { randomBytes } from 'node:crypto'
import { Context, type Fiber } from 'cordis'
import { agentRegistryPlugin } from './services/agent-registry.js'
import { codexAgentProviderPlugin } from './services/codex-agent-provider.js'
import { codexServicePlugin } from './services/codex-service.js'
import { clientExtensionRegistryPlugin } from './services/client-extension-registry.js'
import { programRuntimePlugin } from './services/program-runtime.js'
import { projectRegistryPlugin } from './services/project-registry.js'
import { configuredPluginDirectories } from './plugin-directories.js'
import { toolRegistryPlugin } from './services/tool-registry.js'
import { turnProgramPlugin } from './services/turn-program.js'
import { uiRegistryPlugin } from './services/ui-registry.js'
import {
  controlSessionUrl,
  webGatewayPlugin,
  type WebGatewayAddress,
} from './services/web-gateway.js'

export interface HarnessOptions {
  projectRoot: string
  pluginDirectories?: string[]
  host?: string
  port?: number
  development?: boolean
  watch?: boolean
}

export interface HarnessApp {
  origin: string
  url: string
  close(): Promise<void>
}

export async function startHarness(options: HarnessOptions): Promise<HarnessApp> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 4317
  const controlSecret = randomBytes(32).toString('base64url')
  const ctx = new Context()
  const fibers: Fiber[] = []
  let gatewayAddress: WebGatewayAddress | undefined
  let closed = false

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const fiber of [...fibers].reverse()) {
      await fiber.dispose().catch((error: unknown) => console.error(error))
    }
  }

  try {
    fibers.push(await ctx.plugin(agentRegistryPlugin))
    fibers.push(await ctx.plugin(toolRegistryPlugin))
    fibers.push(await ctx.plugin(clientExtensionRegistryPlugin))
    fibers.push(await ctx.plugin(turnProgramPlugin))
    fibers.push(await ctx.plugin(uiRegistryPlugin))
    fibers.push(await ctx.plugin(projectRegistryPlugin, { projectRoot: options.projectRoot }))
    // Codex provides the captured per-turn permission mode used by program
    // plugins. Its dynamic tool definition is stable, so the live program can
    // still load after the service without changing the App Server contract.
    fibers.push(await ctx.plugin(codexServicePlugin, { projectRoot: options.projectRoot }))
    // This adapter makes Codex discoverable through the provider contract for
    // new plugins. Existing chats still use CodexService directly.
    fibers.push(await ctx.plugin(codexAgentProviderPlugin))
    fibers.push(await ctx.plugin(programRuntimePlugin, {
      projectRoot: options.projectRoot,
      pluginDirectories: await configuredPluginDirectories(
        options.projectRoot,
        options.pluginDirectories,
      ),
      watch: options.watch ?? true,
    }))
    fibers.push(await ctx.plugin(webGatewayPlugin, {
      projectRoot: options.projectRoot,
      controlSecret,
      host,
      port,
      onListening: (address) => {
        gatewayAddress = address
      },
      ...(options.development === undefined ? {} : { development: options.development }),
    }))
  } catch (error) {
    await close()
    throw error
  }

  if (!gatewayAddress) {
    await close()
    throw new Error('Alto web gateway did not report its listening address')
  }
  const origin = `http://${gatewayAddress.host}:${gatewayAddress.port}`
  return {
    origin,
    url: controlSessionUrl(origin, controlSecret),
    close,
  }
}
