import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'
import type { AgentPromptPart, AgentConfigOption } from '../../src/server/services/agent-registry.js'

export function promptBlock(part: AgentPromptPart): acp.ContentBlock {
  if (part.type === 'text') return { type: 'text', text: part.text }
  if (part.type === 'image') {
    return {
      type: 'image',
      data: part.data,
      mimeType: part.mimeType,
      ...(part.uri ? { uri: part.uri } : {}),
    }
  }
  return {
    type: 'resource_link',
    name: part.name,
    uri: part.uri,
    ...(part.mimeType ? { mimeType: part.mimeType } : {}),
  }
}

export function updateContent(update: acp.SessionUpdate): AgentPromptPart | undefined {
  if (
    update.sessionUpdate !== 'agent_message_chunk'
    && update.sessionUpdate !== 'agent_thought_chunk'
    && update.sessionUpdate !== 'user_message_chunk'
  ) return undefined

  const content = update.content
  if (content.type === 'text') return { type: 'text', text: content.text }
  if (content.type === 'image') {
    return {
      type: 'image',
      data: content.data,
      mimeType: content.mimeType,
      ...(content.uri ? { uri: content.uri } : {}),
    }
  }
  if (content.type === 'resource_link') {
    return {
      type: 'resource',
      uri: content.uri,
      name: content.name,
      ...(content.mimeType ? { mimeType: content.mimeType } : {}),
    }
  }
  if (content.type === 'resource') {
    const resource = content.resource
    return {
      type: 'resource',
      uri: resource.uri,
      name: path.basename(resource.uri) || resource.uri,
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    }
  }
  return undefined
}

export function configOptions(response: { configOptions?: acp.SessionConfigOption[] | null; modes?: acp.SessionModeState | null }): AgentConfigOption[] {
  if (response.configOptions?.length) return response.configOptions.flatMap((option) => option.type !== 'select' ? [] : [{
    id: option.id, name: option.name, ...(option.category ? { category: option.category } : {}),
    currentValue: option.currentValue,
    options: option.options.flatMap((value) => 'group' in value ? value.options : [value])
      .map((value) => ({ value: value.value, name: value.name, ...(value.description ? { description: value.description } : {}) })),
  }])
  return response.modes ? [{ id: '__mode', name: 'Mode', category: 'mode', currentValue: response.modes.currentModeId,
    options: response.modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name })) }] : []
}

export function toolFiles(content: acp.ToolCallContent[] | null | undefined) {
  return content?.flatMap((part) => part.type === 'diff'
    ? [{ path: part.path, oldText: part.oldText ?? null, newText: part.newText }] : [])
}

export function toolContent(content: acp.ToolCallContent[] | null | undefined): string | undefined {
  if (!content) return undefined
  return content.flatMap((part) => {
    if (part.type === 'content' && part.content.type === 'text') return [part.content.text]
    return []
  }).join('\n').slice(0, 40_000)
}

