import { Context, type Plugin } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentRegistry,
  agentRegistryPlugin,
  type AgentEventListener,
  type AgentPromptPart,
  type AgentProvider,
  type AgentProviderSnapshot,
  type AgentSession,
  type AgentSessionOptions,
  type AgentTurn,
} from '../src/server/services/agent-registry.js'

class TestProvider implements AgentProvider {
  readonly stop = vi.fn(async () => undefined)
  private readonly listeners = new Set<AgentEventListener>()

  snapshot(): AgentProviderSnapshot {
    return {
      id: 'test-agent',
      label: 'Test Agent',
      protocol: 'acp',
      status: 'ready',
      capabilities: {
        images: false,
        resources: true,
        mcpServers: false,
        sessionHistory: false,
        sessionModes: false,
      },
      activeSessionIds: [],
    }
  }

  async createSession(options: AgentSessionOptions): Promise<AgentSession> {
    return {
      id: 'session-1',
      providerId: 'test-agent',
      cwd: options.cwd,
      createdAt: new Date(0).toISOString(),
    }
  }

  async prompt(sessionId: string, _input: AgentPromptPart[]): Promise<AgentTurn> {
    return {
      id: 'turn-1',
      providerId: 'test-agent',
      sessionId,
      startedAt: new Date(0).toISOString(),
    }
  }

  async cancel(_sessionId: string): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publishReady(): void {
    for (const listener of this.listeners) {
      listener({
        type: 'provider.status',
        providerId: 'test-agent',
        status: 'ready',
        occurredAt: new Date(0).toISOString(),
      })
    }
  }
}

describe('agent registry', () => {
  it('owns providers with their Cordis fiber and forwards normalized events', async () => {
    const ctx = new Context()
    const registryFiber = await ctx.plugin(agentRegistryPlugin)
    const provider = new TestProvider()
    const events = vi.fn()
    const changed = vi.fn()
    ctx.on('agents/event', events)
    ctx.on('agents/changed', changed)

    const feature: Plugin = (owner) => {
      owner.agents.register(owner, provider)
    }
    feature.inject = ['agents']
    const featureFiber = await ctx.plugin(feature)

    expect(ctx.agents).toBeInstanceOf(AgentRegistry)
    expect(ctx.agents.snapshot()).toEqual([provider.snapshot()])
    await expect(ctx.agents.createSession('test-agent', {
      cwd: '/tmp/project',
      permissionMode: 'ask',
    })).resolves.toMatchObject({ id: 'session-1', providerId: 'test-agent' })

    provider.publishReady()
    expect(events).toHaveBeenCalledWith(expect.objectContaining({
      type: 'provider.status',
      providerId: 'test-agent',
    }))
    expect(changed).toHaveBeenCalled()

    await featureFiber.dispose()
    expect(ctx.agents.snapshot()).toEqual([])
    expect(provider.stop).toHaveBeenCalledOnce()
    expect(() => ctx.agents.createSession('test-agent', {
      cwd: '/tmp/project',
      permissionMode: 'ask',
    })).toThrow('unknown agent provider')

    await registryFiber.dispose()
  })
})
