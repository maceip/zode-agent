import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import { isRecord, type JsonValue } from '../../src/shared/protocol.js'
import { TMUX_CLOSE, TMUX_PREPARE } from './tmux-terminals-api.js'

const tmuxTerminals: BrowserPlugin = (ctx) => {
  ctx.clientGhosttyTerminal.registerLauncher(ctx, {
    id: 'tmux',
    async prepare(request) {
      const result = await ctx.clientHost.call(TMUX_PREPARE, request as unknown as JsonValue)
      if (!isRecord(result) || typeof result.command !== 'string' || !result.command) {
        throw new Error('Alto could not attach the saved terminal')
      }
      return { command: result.command }
    },
    async close(identity) {
      await ctx.clientHost.call(TMUX_CLOSE, { identity: { ...identity } })
    },
  })
}

tmuxTerminals.inject = ['clientGhosttyTerminal', 'clientHost']
export default tmuxTerminals
