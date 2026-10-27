import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { HarnessPlugin } from '../../src/server/plugin-api.js'
import { readProgramChange } from './staged-program-files.js'

const changeInputSchema = (projectRoot: string) => ({
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'files'],
  properties: {
    summary: {
      type: 'string',
      description: 'A concrete description of the behavior this change adds or modifies.',
    },
    files: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        oneOf: [{ required: ['content'] }, { required: ['sourcePath'] }],
        properties: {
          path: {
            type: 'string',
            description: 'cordis.json or a program-relative path ending in .ts, .tsx, .js, .mjs, or .css.',
          },
          content: {
            type: 'string',
            description: 'The complete replacement file contents.',
          },
          sourcePath: {
            type: 'string',
            description: `Read complete contents from a file staged under ${path.join(projectRoot, '.codex-cordis', 'staging')}. Use a path relative to that directory instead of repeating its contents in this call. Stage files there with your normal file tools; never edit live program files directly.`,
          },
        },
      },
    },
  },
})

const controlPlane: HarnessPlugin = (ctx) => {
  const program = ctx.program

  ctx.tools.register(ctx, {
    name: 'cordis_authoring_skill',
    description: 'Load the alto-authoring skill before modifying Alto plugins, UI, shell, or Cordis composition. Returns the full authoring contract; inspect cordis_runtime_status separately for live state.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  }, () => readFile(path.join(program.projectRoot, 'program', 'skills', 'alto-authoring', 'SKILL.md'), 'utf8'))

  ctx.tools.register(ctx, {
    name: 'cordis_runtime_status',
    description: 'Inspect the active Cordis program, shell slots, plugin states, dynamic tools, declarative UI contributions, and staged proposals. Call this before adding or moving UI.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  }, () => program.runtimeSummary())

  ctx.tools.register(ctx, {
    name: 'cordis_reprogram',
    description: 'Atomically replace Cordis program files. Prefer sourcePath for files already staged so their contents do not have to be generated again. Turns that started with full access hot-reload immediately; ask, auto, and unverified turns create an approval proposal. Compilation or activation failure restores the previous files and fibers.',
    inputSchema: changeInputSchema(program.projectRoot),
  }, async (call) => {
    const { summary, files } = await readProgramChange(call, program.projectRoot)
    const permissionMode = ctx.codex.permissionModeForTurn(call.threadId, call.turnId) ?? call.permissionMode
    if (permissionMode !== 'full') {
      const proposal = program.stageProposal(summary, files, 'agent')
      return {
        proposalId: proposal.id,
        status: 'awaiting-user-approval',
        permissionMode: permissionMode ?? 'unverified',
        summary: proposal.summary,
        files: proposal.files.map((file) => file.path),
      }
    }
    const snapshot = await program.applyChange(summary, files)
    return {
      status: 'applied',
      summary,
      revision: snapshot.revision,
      files: files.map((file) => file.path),
    }
  })

  ctx.tools.register(ctx, {
    name: 'cordis_propose_change',
    description: 'Optionally stage Cordis program replacements for explicit review instead of applying them. Use only when the user asks to review or approve a change first.',
    inputSchema: changeInputSchema(program.projectRoot),
  }, async (call) => {
    const { summary, files } = await readProgramChange(call, program.projectRoot)
    const proposal = program.stageProposal(summary, files, 'agent')
    return {
      proposalId: proposal.id,
      status: 'awaiting-user-approval',
      summary: proposal.summary,
      files: proposal.files.map((file) => file.path),
    }
  })
}

controlPlane.inject = ['tools', 'program', 'codex']

export default controlPlane
