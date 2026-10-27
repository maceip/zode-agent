import type { Context, Plugin } from 'cordis'
import type { TurnDraft } from '../plugin-api.js'

export class TurnProgram {
  constructor(private readonly root: Context) {}

  async prepare(input: TurnDraft): Promise<TurnDraft> {
    const draft = structuredClone(input)
    return Promise.resolve(
      this.root.waterfall('codex/turn/prepare', draft, () => draft),
    )
  }
}

export const turnProgramPlugin: Plugin = (ctx: Context) => {
  ctx.provide('turnProgram', new TurnProgram(ctx.root))
}

turnProgramPlugin.provide = 'turnProgram'
