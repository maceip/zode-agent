export interface GlobalHotkeyBinding {
  kind: 'global'
  key: string
  ctrl?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
}

export interface LeaderHotkeyPrefix {
  key: string
  label: string
}

export interface LeaderHotkeyBinding {
  kind: 'leader'
  key: string
  prefix?: readonly LeaderHotkeyPrefix[]
}

export type HotkeyBinding =
  | LeaderHotkeyBinding
  | GlobalHotkeyBinding

export interface HotkeyAction {
  id: string
  label: string
  detail?: string
  category: string
  binding: HotkeyBinding
  aliases?: readonly GlobalHotkeyBinding[]
  repeat?: boolean
  enabled?: () => boolean
  run: () => void | Promise<void>
}

export interface ResolvedHotkeyAction extends Omit<HotkeyAction, 'binding' | 'enabled' | 'run'> {
  binding?: HotkeyBinding
  enabled: boolean
}

export interface ClientHotkeysSnapshot {
  revision: number
  leader: string
  pendingLeader: boolean
  leaderPath: readonly string[]
  recordingActionId?: string
  actions: readonly ResolvedHotkeyAction[]
}

export interface HotkeyActionRegistration {
  dispose(): Promise<void>
}

export interface ClientHotkeysService {
  subscribe(listener: () => void): () => void
  snapshot(): ClientHotkeysSnapshot
  registerAction(
    owner: import('cordis').Context,
    action: HotkeyAction,
  ): HotkeyActionRegistration
  open(): void
  setLeader(key: string): void
  setLeaderBinding(actionId: string, key: string | undefined): void
  resetBindings(): void
  beginRecording(actionId: string): void
  cancelRecording(): void
}

declare module 'cordis' {
  interface Context {
    clientHotkeys: ClientHotkeysService
  }
}
