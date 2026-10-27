const STATUS_REFRESH_INTERVAL_MS = 60_000

export function startWorktreeStatusRefresh(
  refresh: () => Promise<void>,
  visibility: Pick<Document, 'hidden' | 'hasFocus' | 'addEventListener' | 'removeEventListener'> = document,
  focus: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  let disposed = false
  let pending = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const active = (): boolean => !disposed && !visibility.hidden && visibility.hasFocus()
  const update = (): void => {
    clearTimeout(timer)
    if (!active() || pending) return
    pending = true
    void Promise.resolve().then(() => {
      if (active()) return refresh()
    }).catch(() => undefined).finally(() => {
      pending = false
      if (active()) timer = setTimeout(update, STATUS_REFRESH_INTERVAL_MS)
    })
  }
  visibility.addEventListener('visibilitychange', update)
  focus.addEventListener('focus', update)
  focus.addEventListener('blur', update)
  update()
  return () => {
    disposed = true
    clearTimeout(timer)
    visibility.removeEventListener('visibilitychange', update)
    focus.removeEventListener('focus', update)
    focus.removeEventListener('blur', update)
  }
}
