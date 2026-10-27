import type {
  BrowserCommand,
  ProjectSnapshot,
  ProgramSnapshot,
  SkillOption,
  ThreadHistoryPage,
  ThreadSummary,
  ThreadView,
} from '../shared/protocol.js'

export type CommandType = BrowserCommand['type']
export type CommandOf<Type extends CommandType> = Extract<BrowserCommand, { type: Type }>
export type CommandArgs<Type extends CommandType> = CommandOf<Type> extends { payload: infer Payload }
  ? [payload: Payload]
  : CommandOf<Type> extends { payload?: infer Payload }
    ? [payload?: Payload]
    : []

interface CommandResults {
  'thread.list': ThreadSummary[]
  'thread.open': ThreadView
  'thread.page': ThreadHistoryPage
  'skill.list': SkillOption[]
  'project.save': ProjectSnapshot
  'project.remove': ProjectSnapshot
  'program.plugin.setEnabled': ProgramSnapshot
  'turn.steer': { turnId: string }
}

export type CommandResult<Type extends CommandType> = Type extends keyof CommandResults
  ? CommandResults[Type]
  : unknown

export type Command = <Type extends CommandType>(
  type: Type,
  ...args: CommandArgs<Type>
) => Promise<CommandResult<Type>>
