import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  CODE_TOUR_GENERATE_METHOD,
  parseCodeTourGenerationResponse,
  parseGeneratedCodeTourText,
  type GeneratedCodeTour,
} from '../program/plugins/code-tour-api.js'
import {
  codeTourPaths,
  emptyCodeTour,
  materializeCodeTour,
} from '../program/plugins/code-tour-model.js'
import codeTour, {
  CODE_TOUR_INSTRUCTIONS,
  generateCodeTourText,
  type CodeTourTextGenerationRequest,
} from '../program/plugins/code-tour.js'
import { buildReviewPatch } from '../program/plugins/diff-viewer.js'
import type { DiffReviewDocument } from '../program/plugins/diff-viewer-api.js'
import type { ClientExtensionHandler, HarnessContext } from '../src/server/plugin-api.js'
import type { JsonValue, ModelOption } from '../src/shared/protocol.js'

function documentFor(files: Parameters<typeof buildReviewPatch>[0]): DiffReviewDocument {
  const workspace = '/tmp/project'
  return {
    id: 'tour-test',
    title: 'Add guided review',
    workspace,
    patch: buildReviewPatch(files, workspace),
    createdAt: '2026-08-28T12:00:00.000Z',
  }
}

const generated: GeneratedCodeTour = {
  title: 'How grants become verified',
  overview: 'Start at the boundary, then follow the state transition into the caller.',
  stops: [{
    path: 'src/grant-api.ts',
    label: 'Contract',
    title: 'Separate pending and verified grants',
    markdown: 'The new types prevent callers from treating an unverified grant as authorized.',
  }, {
    path: 'src/grant.ts',
    label: 'State flow',
    title: 'Verify before declassification',
    markdown: 'The implementation now produces `VerifiedGrant` only after every check succeeds.',
  }],
}

function generationMethod(models: ModelOption[]) {
  let generate!: ClientExtensionHandler
  const generateText = vi.fn(async (_request: CodeTourTextGenerationRequest) => JSON.stringify(generated))
  const workspace = process.cwd()
  const ctx = {
    codex: { snapshot: () => ({ models }), generateText },
    projects: { snapshot: () => ({ projects: [{ roots: [workspace] }] }) },
    clientExtensions: {
      registerMethod: (_owner: unknown, name: string, handler: ClientExtensionHandler) => {
        if (name === CODE_TOUR_GENERATE_METHOD) generate = handler
      },
    },
  }
  ;(codeTour as (ctx: HarnessContext) => void)(ctx as unknown as HarnessContext)
  const document = {
    ...documentFor([{ path: 'src/grant.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }]),
    workspace,
  }
  return {
    generateText,
    generate: (model: string, effort: string) => generate({
      document, paths: ['src/grant.ts'], model, effort,
    } as unknown as JsonValue),
  }
}

describe('code tour source model', () => {
  const listedModel: ModelOption = {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
  }

  it.each([
    ['gpt-6-astra', 'ultra'],
    ['gpt-5.6-sol', 'high'],
  ])('forwards the source settings %s / %s without substituting the catalog default', async (model, effort) => {
    const { generate, generateText } = generationMethod([listedModel])

    await expect(generate(model, effort)).resolves.toEqual({ model, effort, tour: generated })
    expect(generateText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model, effort }))
  })

  it('still checks reasoning efforts when the catalog describes the source model', async () => {
    const { generate, generateText } = generationMethod([listedModel])

    await expect(generate(listedModel.id, 'ultra')).rejects.toThrow('is not supported by gpt-5.6-sol')
    expect(generateText).not.toHaveBeenCalled()
  })

  it('surfaces a model rejection from the app-server', async () => {
    const { generate, generateText } = generationMethod([listedModel])
    const error = new Error('Model is unavailable for this account')
    generateText.mockRejectedValueOnce(error)

    await expect(generate('unavailable-model', 'high')).rejects.toBe(error)
    expect(generateText).toHaveBeenCalledOnce()
  })
})

describe('code tour', () => {
  it('keeps the substantive implementation ahead of integration and tests', () => {
    expect(CODE_TOUR_INSTRUCTIONS).toContain('literate code review tour')
    expect(CODE_TOUR_INSTRUCTIONS).toContain('Build the gist and intuition before')
    expect(CODE_TOUR_INSTRUCTIONS).toContain('Follow the core behavior in execution order')
    expect(CODE_TOUR_INSTRUCTIONS).toContain('Do not narrate syntax or paraphrase the code line by line')
    expect(CODE_TOUR_INSTRUCTIONS).toContain('three contiguous buckets in this exact order')
    expect(CODE_TOUR_INSTRUCTIONS.indexOf('1. Core')).toBeLessThan(
      CODE_TOUR_INSTRUCTIONS.indexOf('2. Integration'),
    )
    expect(CODE_TOUR_INSTRUCTIONS.indexOf('2. Integration')).toBeLessThan(
      CODE_TOUR_INSTRUCTIONS.indexOf('3. Tests'),
    )
    expect(CODE_TOUR_INSTRUCTIONS).toContain('devote most stops and most prose to it')
    expect(CODE_TOUR_INSTRUCTIONS).toContain('two to four short paragraphs')
    expect(CODE_TOUR_INSTRUCTIONS).toContain('**Worth attention:**')
    expect(CODE_TOUR_INSTRUCTIONS).toContain('Do not manufacture concerns')
    expect(CODE_TOUR_INSTRUCTIONS).toContain('Use each changed path at most once')
  })

  it('parses the strict model response and tolerates one accidental JSON fence', () => {
    const output = `\`\`\`json\n${JSON.stringify(generated)}\n\`\`\``

    expect(parseGeneratedCodeTourText(output)).toEqual(generated)
    expect(parseCodeTourGenerationResponse({
      model: 'gpt-5.6-sol',
      effort: 'high',
      tour: generated,
    } as unknown as JsonValue)).toEqual({ model: 'gpt-5.6-sol', effort: 'high', tour: generated })
  })

  it('uses the LLM reading order and binds each explanation to its exact diff', () => {
    const document = documentFor([
      { path: 'src/grant.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+export const verified = true' },
      { path: 'src/grant-api.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+export interface VerifiedGrant {}' },
    ])
    const tour = materializeCodeTour(document, generated, 'gpt-5.6-sol', 'high')

    expect(codeTourPaths(document)).toEqual(['src/grant.ts', 'src/grant-api.ts'])
    expect(tour.stops.map((stop) => stop.path)).toEqual([
      'src/grant-api.ts',
      'src/grant.ts',
    ])
    expect(tour.stops[0]).toMatchObject({
      label: 'Contract',
      heading: 'Separate pending and verified grants',
      additions: 1,
      deletions: 1,
    })
    expect(tour.intro).toContain('How grants become verified')
    expect(tour).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high' })
  })

  it('rejects model stops outside the supplied diff', () => {
    const document = documentFor([
      { path: 'src/grant.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' },
    ])
    expect(() => materializeCodeTour(document, {
      ...generated,
      stops: [{ ...generated.stops[0]!, path: 'src/not-in-diff.ts' }],
    }, 'gpt-5.6-sol', 'high')).toThrow('outside this diff')
  })

  it('keeps the first stop when Codex repeats a file', () => {
    const document = documentFor([
      { path: 'src/grant.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' },
    ])
    const tour = materializeCodeTour(document, {
      ...generated,
      stops: [
        { ...generated.stops[0]!, path: 'src/grant.ts', title: 'First explanation' },
        { ...generated.stops[1]!, path: 'src/grant.ts', title: 'Repeated explanation' },
      ],
    }, 'gpt-5.6-sol', 'high')

    expect(tour.stops).toHaveLength(1)
    expect(tour.stops[0]).toMatchObject({
      path: 'src/grant.ts',
      heading: 'First explanation',
    })
    expect(tour).toMatchObject({ additions: 1, deletions: 1 })
  })

  it('does not call the model for an empty patch', () => {
    const document: DiffReviewDocument = {
      id: 'empty-tour',
      title: 'Working tree changes',
      workspace: '/tmp/project',
      patch: '',
      createdAt: '2026-08-28T12:00:00.000Z',
    }

    expect(emptyCodeTour(document, 'gpt-5.6-sol', 'high')).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'high',
      additions: 0,
      deletions: 0,
      stops: [],
    })
  })

  it('uses the live app-server transport when Alto has not restarted yet', async () => {
    const requests: Array<{ method: string; params: unknown }> = []
    const client = Object.assign(new EventEmitter(), {
      async request(method: string, params: unknown): Promise<unknown> {
        requests.push({ method, params })
        if (method === 'thread/start') return { thread: { id: 'legacy-thread' } }
        if (method === 'turn/start') {
          queueMicrotask(() => client.emit('notification', {
            method: 'turn/completed',
            params: {
              threadId: 'legacy-thread',
              turn: {
                id: 'legacy-turn',
                status: 'completed',
                items: [{
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: '{"title":"Hot-loaded tour"}',
                }],
              },
            },
          }))
          return { turn: { id: 'legacy-turn' } }
        }
        return {}
      },
    })
    const service = {
      client,
      activeTurns: new Map([['legacy-thread', {}]]),
      threadStates: new Map([['legacy-thread', {}]]),
      threadSettings: new Map(),
      threadSummaries: new Map(),
      snapshot: () => ({ status: 'ready' }),
      emit: () => true,
    }

    await expect(generateCodeTourText(service, {
      workspace: '/tmp/project',
      model: 'gpt-5.6-sol',
      effort: 'high',
      instructions: 'Return JSON.',
      prompt: 'Explain this diff.',
      serviceName: 'alto-code-tour',
      additionalContext: {
        code_tour_patch: { kind: 'untrusted', value: '+new behavior' },
      },
    })).resolves.toBe('{"title":"Hot-loaded tour"}')

    expect(requests).toEqual([
      {
        method: 'thread/start',
        params: expect.objectContaining({
          cwd: '/tmp/project',
          model: 'gpt-5.6-sol',
          sandbox: 'read-only',
          approvalPolicy: 'never',
          dynamicTools: [],
          ephemeral: true,
          serviceName: 'alto-code-tour',
        }),
      },
      {
        method: 'turn/start',
        params: expect.objectContaining({
          threadId: 'legacy-thread',
          model: 'gpt-5.6-sol',
          effort: 'high',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
        }),
      },
    ])
    expect(service.activeTurns.has('legacy-thread')).toBe(false)
    expect(service.threadStates.has('legacy-thread')).toBe(false)
  })
})
