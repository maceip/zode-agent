import type { Plugin } from 'cordis'

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

interface FocusTarget {
  closest(selector: string): unknown
}

interface EscapeKeyInput {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  timeStamp: number
}

export interface DoubleEscapeResult {
  nextEscapeAt: number | undefined
  interrupt: boolean
}

const DOUBLE_ESCAPE_WINDOW_MS = 600

export function doubleEscapeGesture(
  event: EscapeKeyInput,
  previousEscapeAt: number | undefined,
): DoubleEscapeResult {
  if (
    event.key !== 'Escape'
    || event.ctrlKey
    || event.metaKey
    || event.altKey
    || event.shiftKey
  ) return { nextEscapeAt: undefined, interrupt: false }
  if (event.repeat) return { nextEscapeAt: previousEscapeAt, interrupt: false }
  const elapsed = previousEscapeAt === undefined
    ? Number.POSITIVE_INFINITY
    : event.timeStamp - previousEscapeAt
  if (elapsed >= 0 && elapsed <= DOUBLE_ESCAPE_WINDOW_MS) {
    return { nextEscapeAt: undefined, interrupt: true }
  }
  return { nextEscapeAt: event.timeStamp, interrupt: false }
}

export function shouldFocusComposer(target: unknown): boolean {
  const candidate = target as Partial<FocusTarget> | null
  return typeof candidate?.closest !== 'function'
    || candidate.closest(INTERACTIVE_SELECTOR) === null
}

const hotkeysComposer: Plugin = (ctx) => {
  ctx.effect(() => {
    if (typeof window === 'undefined') return () => undefined
    let previousEscapeAt: number | undefined
    const interrupt = (event: KeyboardEvent): void => {
      const gesture = doubleEscapeGesture(event, previousEscapeAt)
      previousEscapeAt = gesture.nextEscapeAt
      if (
        !gesture.interrupt
        || ctx.clientConversation.snapshot().turn.tag !== 'running'
      ) return
      event.preventDefault()
      event.stopPropagation()
      void ctx.clientConversation.interrupt().catch((error) => {
        console.error('Unable to interrupt the active turn', error)
      })
    }
    window.addEventListener('keydown', interrupt, true)
    return () => window.removeEventListener('keydown', interrupt, true)
  }, 'hotkeys-composer.doubleEscape')

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'chat.new',
    label: 'New chat',
    detail: 'Open a new chat tab.',
    category: 'Navigation',
    binding: { kind: 'leader', key: 'n' },
    enabled: () => ctx.clientWorkspaceLayout.available(),
    run: () => {
      ctx.clientUi.overlays.closeAll()
      ctx.clientWorkspaceLayout.newTab()
    },
  })

  ctx.clientHotkeys.registerAction(ctx, {
    id: 'chat.focus',
    label: 'Focus active chat',
    detail: 'Move focus to the open chat composer from non-interactive page space.',
    category: 'Navigation',
    binding: { kind: 'global', key: 'Tab' },
    enabled: () => shouldFocusComposer(document.activeElement),
    run: () => {
      ctx.clientComposer.focus()
    },
  })
}

hotkeysComposer.inject = ['clientHotkeys', 'clientComposer', 'clientConversation', 'clientUi', 'clientWorkspaceLayout']

export default hotkeysComposer
