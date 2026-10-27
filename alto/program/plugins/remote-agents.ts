import path from 'node:path'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import type { RemoteAgentRegistryService } from '../../src/server/services/remote-agent-api.js'
import { RemoteAgentProvider } from './remote-agent-provider.js'

const remoteAgents: HarnessPlugin = (ctx) => {
  const service: RemoteAgentRegistryService = {
    register(owner, backend) {
      if (!/^[a-z][a-z0-9-]*$/.test(backend.id)) throw new Error('Invalid remote backend ID')
      for (const agent of backend.agents) {
        if (!/^[a-z][a-z0-9-]*$/.test(agent.id)) throw new Error('Invalid remote agent ID')
        ctx.agents.register(owner, new RemoteAgentProvider(backend, agent,
          path.join(ctx.program.projectRoot, '.codex-cordis', 'remote-agents', `${backend.id}-${agent.id}`)))
      }
    },
  }
  ctx.provide('remoteAgents', service)
}
remoteAgents.inject = ['agents', 'program']
remoteAgents.provide = 'remoteAgents'
export default remoteAgents
