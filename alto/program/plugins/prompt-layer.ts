import type { HarnessPlugin, TurnDraft } from '../../src/server/plugin-api.js'
import { isAgentChatId } from './agent-chats-api.js'

interface PromptLayerConfig {
  context?: string
}

const responseStyleGuidance = `Alto response formatting defaults:
- Follow explicit user style instructions when they differ from these defaults.
- Lead with a direct answer in plain prose. Use short paragraphs that each develop one idea while preserving technical precision and necessary qualifications.
- Use bold selectively for short terms or takeaways, rather than whole sentences or long spans.
- Use descriptive Markdown headings when a longer answer needs sections. Prefer ## for main sections and ### for subsections; avoid numbered headings unless the sections describe an ordered sequence.
- Use inline code for exact identifiers, commands, and paths, rather than ordinary technical terms.
- Keep short mathematical symbols inline. Put full equations in display math, with opening and closing $$ delimiters on separate lines and blank lines around the block. Explain the notation in words.
- Use lists for short, parallel facts or ordered steps. Develop extended arguments in connected paragraphs.`

// app-server truncates each additionalContext value above 1,000 approximate
// tokens, calculated as 4,000 UTF-8 bytes. Keep the original text intact across
// entries, preferring line boundaries so individual instructions stay together.
function applicationContext(key: string, text: string): NonNullable<TurnDraft['additionalContext']> {
  const entries: NonNullable<TurnDraft['additionalContext']> = {}
  let remaining = text
  let part = 1
  while (remaining) {
    let bytes = 0
    let end = 0
    let lineEnd = 0
    for (const character of remaining) {
      const size = Buffer.byteLength(character, 'utf8')
      if (bytes + size > 4_000) break
      bytes += size
      end += character.length
      if (character === '\n') lineEnd = end
    }
    if (end < remaining.length && lineEnd > 0) end = lineEnd
    const name = part === 1 ? key : `${key}_${String(part).padStart(3, '0')}`
    entries[name] = { kind: 'application', value: remaining.slice(0, end) }
    remaining = remaining.slice(end)
    part += 1
  }
  return entries
}

const promptLayer: HarnessPlugin<PromptLayerConfig> = (ctx, config) => {
  const context = config.context?.trim()
  if (!context) return

  ctx.on('codex/turn/prepare', async (draft: TurnDraft, next) => {
    const prepared = await next()
    return {
      ...prepared,
      additionalContext: {
        ...prepared.additionalContext,
        ...applicationContext('cordis_program', context),
        ...(isAgentChatId(draft.threadId ?? '')
          ? applicationContext('cordis_response_style', responseStyleGuidance)
          : {}),
      },
    }
  })
}

promptLayer.inject = ['turnProgram']

export default promptLayer
