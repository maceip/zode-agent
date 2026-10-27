import type { HarnessPlugin, UiSurface } from '../../src/server/plugin-api.js'
import type { ChatAttachment, ChatImage, JsonValue, SkillOption } from '../../src/shared/protocol.js'
import { isRecord } from '../../src/shared/protocol.js'
import { turnInputsFor } from '../../src/server/services/turn-input.js'
import {
  STEER_QUEUE_ADD,
  STEER_QUEUE_DELETE,
  STEER_QUEUE_LIST,
  STEER_QUEUE_REORDER,
  STEER_QUEUE_START,
  STEER_QUEUE_UPDATE,
} from './steer-api.js'

const surface: UiSurface = {
  id: 'default-steer',
  kind: 'steer',
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value
}

function draft(value: unknown): {
  text: string
  images: ChatImage[]
  attachments: ChatAttachment[]
  skills: SkillOption[]
} {
  if (!isRecord(value)) throw new Error('draft is required')
  return {
    text: typeof value.text === 'string' ? value.text : '',
    images: Array.isArray(value.images) ? value.images as ChatImage[] : [],
    attachments: Array.isArray(value.attachments) ? value.attachments as ChatAttachment[] : [],
    skills: Array.isArray(value.skills) ? value.skills as SkillOption[] : [],
  }
}

export function legacyEditedQueueOrder(
  queuedSubmissionIds: readonly string[],
  editedId: string,
  replacementId: string,
): string[] {
  const unique = new Set(queuedSubmissionIds)
  if (unique.size !== queuedSubmissionIds.length) {
    throw new Error('Codex returned duplicate queued submissions')
  }
  if (!unique.has(editedId) || !unique.has(replacementId)) {
    throw new Error('Codex did not return the complete edited queue')
  }
  return queuedSubmissionIds
    .filter((id) => id !== replacementId)
    .flatMap((id) => id === editedId ? [replacementId, editedId] : [id])
}

const steer: HarnessPlugin = (ctx) => {
  ctx.ui.registerSurface(ctx, surface)
  ctx.clientExtensions.registerMethod(ctx, STEER_QUEUE_LIST, async (payload) => {
    if (!isRecord(payload)) throw new Error('queue request is required')
    return await ctx.codex.listQueuedSubmissions(string(payload.threadId, 'threadId')) as JsonValue
  })
  ctx.clientExtensions.registerMethod(ctx, STEER_QUEUE_ADD, async (payload) => {
    if (!isRecord(payload)) throw new Error('queue request is required')
    const queued = await ctx.codex.addQueuedSubmission(
      string(payload.threadId, 'threadId'),
      turnInputsFor(draft(payload.draft)),
      string(payload.clientUserMessageId, 'clientUserMessageId'),
    )
    if (!isRecord(queued)) throw new Error('Codex did not return the queued submission')
    return queued as JsonValue
  })
  ctx.clientExtensions.registerMethod(ctx, STEER_QUEUE_UPDATE, async (payload) => {
    if (!isRecord(payload)) throw new Error('queue request is required')
    const threadId = string(payload.threadId, 'threadId')
    const queuedSubmissionId = string(payload.queuedSubmissionId, 'queuedSubmissionId')
    const input = turnInputsFor(draft(payload.draft))
    const nativeUpdate = (ctx.codex as typeof ctx.codex & {
      updateQueuedSubmission?: (
        threadId: string,
        queuedSubmissionId: string,
        input: ReturnType<typeof turnInputsFor>,
      ) => Promise<unknown>
    }).updateQueuedSubmission
    if (nativeUpdate) {
      const queued = await nativeUpdate.call(ctx.codex, threadId, queuedSubmissionId, input)
      if (!isRecord(queued)) throw new Error('Codex did not return the updated submission')
      return queued as JsonValue
    }

    // The running harness may predate thread/queue/update until Alto restarts.
    // Preserve edit support during that hot-reload window by replacing the
    // queued item and restoring its position through the older queue methods.
    const replacement = await ctx.codex.addQueuedSubmission(
      threadId,
      input,
      `alto-edit-${Date.now()}-${queuedSubmissionId}`,
    )
    if (!isRecord(replacement) || typeof replacement.id !== 'string') {
      throw new Error('Codex did not return the updated submission')
    }
    const replacementId = replacement.id
    try {
      const reorder = async (): Promise<void> => {
        const current = await ctx.codex.listQueuedSubmissions(threadId)
        const ids = current.flatMap((entry) => (
          isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : []
        ))
        await ctx.codex.reorderQueuedSubmissions(
          threadId,
          legacyEditedQueueOrder(ids, queuedSubmissionId, replacementId),
        )
      }
      try {
        await reorder()
      } catch {
        // A concurrent enqueue can invalidate the first complete ordering.
        // Re-read once so the retry includes every current submission.
        await reorder()
      }
      await ctx.codex.deleteQueuedSubmission(threadId, queuedSubmissionId)
    } catch (error) {
      await ctx.codex.deleteQueuedSubmission(threadId, replacementId).catch(() => undefined)
      throw error
    }
    return replacement as JsonValue
  })
  ctx.clientExtensions.registerMethod(ctx, STEER_QUEUE_DELETE, async (payload) => {
    if (!isRecord(payload)) throw new Error('queue request is required')
    await ctx.codex.deleteQueuedSubmission(
      string(payload.threadId, 'threadId'),
      string(payload.queuedSubmissionId, 'queuedSubmissionId'),
    )
    return { deleted: true }
  })
  ctx.clientExtensions.registerMethod(ctx, STEER_QUEUE_REORDER, async (payload) => {
    if (!isRecord(payload) || !Array.isArray(payload.queuedSubmissionIds)) {
      throw new Error('queuedSubmissionIds is required')
    }
    await ctx.codex.reorderQueuedSubmissions(
      string(payload.threadId, 'threadId'),
      payload.queuedSubmissionIds.map((id) => string(id, 'queuedSubmissionId')),
    )
    return { reordered: true }
  })
  ctx.clientExtensions.registerMethod(ctx, STEER_QUEUE_START, async (payload) => {
    if (!isRecord(payload)) throw new Error('queue request is required')
    const response = await ctx.codex.startQueuedSubmission(
      string(payload.threadId, 'threadId'),
      typeof payload.queuedSubmissionId === 'string' ? payload.queuedSubmissionId : undefined,
    )
    return isRecord(response.turn) ? response.turn as JsonValue : {}
  })
}

steer.inject = ['clientExtensions', 'codex', 'ui']

export default steer
