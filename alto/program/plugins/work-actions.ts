import { isAgentChatId } from './agent-chats-api.js'
import { requireAgentChats } from './agent-chats-access.js'
import type { Context } from 'cordis'
import type { DynamicToolCall, HarnessPlugin } from '../../src/server/plugin-api.js'
import { isRecord, type JsonValue, type PermissionMode, type ThreadSummary } from '../../src/shared/protocol.js'
import type { WorkCheckout, WorkTarget } from './work-contexts-api.js'

type PanePlacement = 'current' | 'right' | 'below'

function requireFullAccess(ctx: Context, call: DynamicToolCall): PermissionMode {
  const permissionMode = ctx.codex.permissionModeForTurn(call.threadId, call.turnId) ?? call.permissionMode
  if (permissionMode !== 'full') {
    throw new Error(
      'Creating or selecting a work target requires a turn that started with Full access. '
      + `This turn started with ${permissionMode ?? 'an unverified permission mode'}.`,
    )
  }
  return permissionMode
}

function localCheckouts(ctx: Context): WorkCheckout[] {
  return ctx.workContexts.snapshot().workstreams
    .flatMap((workstream) => workstream.checkouts)
    .filter((checkout) => checkout.kind === 'local')
}

async function sourceCheckout(
  ctx: Context,
  call: DynamicToolCall,
  requestedId: string | undefined,
): Promise<{ checkout: WorkCheckout; capturedRef?: string }> {
  await ctx.workContexts.refresh()
  if (requestedId) {
    const requested = ctx.workContexts.checkout(requestedId)
    if (!requested || requested.kind !== 'local') {
      throw new Error(`Local source checkout ${JSON.stringify(requestedId)} is not available`)
    }
    return { checkout: requested }
  }

  const target = ctx.workContexts.targetForThread(call.threadId)
  if (target?.kind === 'local') {
    const checkout = ctx.workContexts.checkout(target.checkoutId)
    if (checkout?.kind === 'local') return { checkout }
  }

  const thread = isAgentChatId(call.threadId) ? (await requireAgentChats(ctx).open(call.threadId)).summary : await ctx.codex.threadSummary(call.threadId)
  const byPath = thread ? ctx.workContexts.localCheckoutForPath(thread.cwd) : undefined
  if (thread?.gitInfo?.branch) {
    const projectId = byPath?.projectId ?? target?.projectId
    const candidates = localCheckouts(ctx).filter((checkout) => (
      (!projectId || checkout.projectId === projectId)
      && checkout.branch === thread.gitInfo?.branch
    ))
    const exact = thread.gitInfo.sha
      ? candidates.find((checkout) => !checkout.head || checkout.head === thread.gitInfo?.sha)
      : candidates[0]
    if (exact) return { checkout: exact }
    if (byPath) {
      return {
        checkout: byPath,
        capturedRef: thread.gitInfo.sha ?? thread.gitInfo.branch,
      }
    }
  }
  if (byPath) return { checkout: byPath }

  if (target) {
    const sameProject = localCheckouts(ctx).filter((checkout) => checkout.projectId === target.projectId)
    const sameBranch = sameProject.find((checkout) => checkout.branch === target.branch)
    if (sameBranch) return { checkout: sameBranch }
    const primary = sameProject.find((checkout) => checkout.primary)
    if (primary) return { checkout: primary }
  }

  const candidates = localCheckouts(ctx)
  if (candidates.length === 1) return { checkout: candidates[0] as WorkCheckout }
  throw new Error('Alto could not infer the source checkout. Call work/list and pass sourceCheckoutId.')
}

function stringArgument(
  value: Record<string, unknown>,
  key: string,
  required = false,
): string | undefined {
  const candidate = value[key]
  if (candidate === undefined && !required) return undefined
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${key} is required`)
  return candidate.trim()
}

function threadSummary(
  id: string,
  checkout: Pick<WorkCheckout, 'branch' | 'location' | 'projectId'>,
  execution: string,
  workspace = checkout.location,
): ThreadSummary {
  const timestamp = Math.floor(Date.now() / 1_000)
  return {
    id,
    title: checkout.branch,
    preview: execution === 'local' ? 'Local branch work' : `Remote work with ${execution}`,
    cwd: workspace,
    createdAt: timestamp,
    updatedAt: timestamp,
    recencyAt: timestamp,
    projectId: checkout.projectId,
  }
}

async function newThread(
  ctx: Context,
  checkout: WorkCheckout,
  execution: string,
  workspace = checkout.location,
  parentThreadId?: string,
): Promise<ThreadSummary> {
  if (parentThreadId && isAgentChatId(parentThreadId)) {
    const chats = requireAgentChats(ctx)
    const parent = await chats.open(parentThreadId)
    const chat = await chats.create(parent.summary.providerId, workspace, 'full')
    await chats.rename(chat.summary.id, checkout.branch)
    return { ...chat.summary, projectId: checkout.projectId }
  }
  const response = await ctx.codex.startThread({
    workspace,
    permissionMode: 'full',
  })
  const id = response.thread?.id
  if (!id) throw new Error('Codex did not create a thread for the new work target')
  return threadSummary(id, checkout, execution, workspace)
}

function localWorkspaceFor(ctx: Context, checkout: WorkCheckout): WorkCheckout {
  if (checkout.kind === 'local') return checkout
  const candidates = localCheckouts(ctx).filter((candidate) => candidate.projectId === checkout.projectId)
  const workspace = candidates.find((candidate) => candidate.branch === checkout.branch)
    ?? candidates.find((candidate) => candidate.primary)
  if (!workspace) throw new Error('The remote checkout no longer has a local Alto workspace')
  return workspace
}

async function openPane(
  ctx: Context,
  anchorThreadId: string,
  placement: Exclude<PanePlacement, 'current'>,
  thread: ThreadSummary,
) {
  return ctx.workspaceCommands.openPane({
    anchorThreadId,
    direction: placement === 'below' ? 'vertical' : 'horizontal',
    kind: 'chat',
    thread,
    workspace: thread.cwd,
    ...(thread.projectId ? { projectId: thread.projectId } : {}),
  })
}

function conciseTarget(target: WorkTarget | undefined): Record<string, unknown> | undefined {
  if (!target) return undefined
  return {
    checkoutId: target.checkoutId,
    kind: target.kind,
    branch: target.branch,
    label: target.label,
    location: target.location,
    projectId: target.projectId,
    status: target.status,
  }
}

const workActions: HarnessPlugin = (ctx) => {
  ctx.tools.register(ctx, {
    namespace: 'work',
    name: 'list',
    description: 'List Alto workstreams, local and remote checkouts, registered remote providers, stable checkout IDs, and the invoking chat\'s selected execution target. Call this before choosing among ambiguous checkouts.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  }, async (call) => {
    const snapshot = await ctx.workContexts.refresh()
    return {
      currentTarget: conciseTarget(snapshot.threadTargets[call.threadId]),
      providers: snapshot.providers,
      workstreams: snapshot.workstreams.map((workstream) => ({
        projectId: workstream.projectId,
        branch: workstream.branch,
        repository: workstream.repository,
        checkouts: workstream.checkouts.map((checkout) => ({
          id: checkout.id,
          kind: checkout.kind,
          label: checkout.label,
          location: checkout.location,
          primary: checkout.primary,
          dirty: checkout.dirty,
          status: checkout.status,
        })),
      })),
      problem: snapshot.problem,
    }
  })

  ctx.tools.register(ctx, {
    namespace: 'work',
    name: 'select',
    description: 'Select an existing local or remote checkout for this chat, or open it as an independent chat in a new pane. This changes where subsequent repository work executes and requires Full access.',
    inputSchema: {
      type: 'object',
      required: ['checkoutId'],
      properties: {
        checkoutId: { type: 'string' },
        open: {
          type: 'string',
          enum: ['current', 'right', 'below'],
          default: 'current',
        },
      },
      additionalProperties: false,
    },
  }, async (call) => {
    requireFullAccess(ctx, call)
    if (isAgentChatId(call.threadId)) requireAgentChats(ctx)
    const args = isRecord(call.arguments) ? call.arguments : {}
    const checkoutId = stringArgument(args, 'checkoutId', true) as string
    const checkout = ctx.workContexts.checkout(checkoutId)
    if (!checkout) throw new Error(`Checkout ${JSON.stringify(checkoutId)} is no longer available`)
    const placement: PanePlacement = args.open === 'right' || args.open === 'below'
      ? args.open
      : 'current'
    if (isAgentChatId(call.threadId) && (placement === 'current' || checkout.kind !== 'local')) {
      throw new Error('ACP work targets require a new local pane. Choose open right or below with a local checkout.')
    }
    if (placement === 'current') {
      await ctx.workContexts.setThreadTarget(call.threadId, checkout)
      return { threadId: call.threadId, target: conciseTarget(ctx.workContexts.targetForThread(call.threadId)) }
    }
    const workspace = localWorkspaceFor(ctx, checkout)
    const thread = await newThread(
      ctx,
      checkout,
      checkout.kind,
      workspace.location,
      call.threadId,
    )
    await ctx.workContexts.setThreadTarget(thread.id, checkout)
    const pane = await openPane(ctx, call.threadId, placement, thread)
    return { threadId: thread.id, pane, target: conciseTarget(ctx.workContexts.targetForThread(thread.id)) }
  })

  ctx.tools.register(ctx, {
    namespace: 'work',
    name: 'create',
    description: 'Create a branch from an explicit Git base, target it locally or with a registered remote provider, and optionally open it as an independent chat pane. Call work/list to discover provider IDs. Use baseRef "origin/main" when the user asks for a branch off origin/main. Side effects require Full access.',
    inputSchema: {
      type: 'object',
      required: ['branch', 'execution'],
      properties: {
        branch: { type: 'string', description: 'New branch name.' },
        baseRef: { type: 'string', description: 'Exact Git base reference, for example origin/main. Omit to use the source checkout HEAD.' },
        execution: { type: 'string', description: 'Use "local" or a provider ID returned by work/list.' },
        localPlacement: {
          type: 'string',
          enum: ['worktree', 'checkout'],
          default: 'worktree',
          description: 'For local execution, create a separate worktree or switch the selected checkout.',
        },
        open: {
          type: 'string',
          enum: ['current', 'right', 'below'],
          default: 'current',
          description: 'Target this chat or open an independent chat pane.',
        },
        sourceCheckoutId: { type: 'string', description: 'Stable ID from work/list. Omit when Alto can infer it from this chat.' },
        providerOptions: {
          type: 'object',
          description: 'Optional provider-specific settings. Omit unless the provider documents them.',
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    },
  }, async (call) => {
    requireFullAccess(ctx, call)
    if (isAgentChatId(call.threadId)) requireAgentChats(ctx)
    const args = isRecord(call.arguments) ? call.arguments : {}
    const branch = stringArgument(args, 'branch', true) as string
    const baseRef = stringArgument(args, 'baseRef')
    const execution = stringArgument(args, 'execution', true) as string
    const provider = execution === 'local'
      ? undefined
      : ctx.workContexts.snapshot().providers.find((candidate) => candidate.id === execution)
    if (execution !== 'local' && !provider) {
      throw new Error(`work provider ${JSON.stringify(execution)} is not available; call work/list for current provider IDs`)
    }
    const placement: PanePlacement = args.open === 'right' || args.open === 'below'
      ? args.open
      : 'current'
    if (isAgentChatId(call.threadId) && (placement === 'current' || execution !== 'local')) {
      throw new Error('ACP work targets require a new local pane. Choose local execution and open right or below.')
    }
    const sourceSelection = await sourceCheckout(
      ctx,
      call,
      typeof args.sourceCheckoutId === 'string' ? args.sourceCheckoutId.trim() : undefined,
    )
    const source = sourceSelection.checkout
    const effectiveBaseRef = baseRef ?? sourceSelection.capturedRef

    if (execution === 'local') {
      const localPlacement = args.localPlacement === 'checkout' ? 'checkout' : 'worktree'
      const checkout = await ctx.workContexts.createLocalBranch(
        source.id,
        branch,
        localPlacement,
        effectiveBaseRef,
      )
      if (placement === 'current') {
        await ctx.workContexts.setThreadTarget(call.threadId, checkout)
        return {
          threadId: call.threadId,
          created: { branch, baseRef: effectiveBaseRef, execution, localPlacement },
          target: conciseTarget(ctx.workContexts.targetForThread(call.threadId)),
        }
      }
      const thread = await newThread(ctx, checkout, execution, checkout.location, call.threadId)
      await ctx.workContexts.setThreadTarget(thread.id, checkout)
      const pane = await openPane(ctx, call.threadId, placement, thread)
      return {
        threadId: thread.id,
        pane,
        created: { branch, baseRef: effectiveBaseRef, execution, localPlacement },
        target: conciseTarget(ctx.workContexts.targetForThread(thread.id)),
      }
    }

    const targetThread = placement === 'current'
      ? { id: call.threadId }
      : await newThread(ctx, source, execution)
    const providerOptions = isRecord(args.providerOptions)
      ? args.providerOptions as Record<string, JsonValue>
      : undefined
    const checkout = await ctx.workContexts.createProviderBranchTarget(
      execution,
      targetThread.id,
      source.id,
      branch,
      effectiveBaseRef,
      providerOptions,
    )
    if (placement === 'current') {
      return {
        threadId: call.threadId,
        created: { branch, baseRef: effectiveBaseRef, execution },
        target: conciseTarget(ctx.workContexts.targetForThread(call.threadId)),
      }
    }
    const target = ctx.workContexts.targetForThread(targetThread.id)
    const thread = threadSummary(targetThread.id, {
      branch,
      location: source.location,
      projectId: source.projectId,
    }, execution)
    const pane = await openPane(ctx, call.threadId, placement, thread)
    return {
      threadId: targetThread.id,
      pane,
      created: { branch, baseRef: effectiveBaseRef, execution },
      target: conciseTarget(target ?? { ...checkout, checkoutId: checkout.id, updatedAt: new Date().toISOString() }),
    }
  })
}

workActions.inject = ['codex', 'tools', 'workContexts', 'workspaceCommands']

export default workActions
