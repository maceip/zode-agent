// Native host focus returns asynchronously. Only finish the request if this
// editor still owns DOM focus; the user may have selected another control or
// split while the desktop process was handling it.
export function focusComposerEditor(
  editor: HTMLElement,
  isCurrent: () => boolean = () => true,
): () => void {
  let cancelled = false
  const cancel = (): void => { cancelled = true }
  if (!editor.isConnected || !editor.isContentEditable || !isCurrent()) return cancel

  const document = editor.ownerDocument
  editor.focus({ preventScroll: true })
  if (document.activeElement !== editor) return cancel

  const hostFocus = document.defaultView?.__ALTO_DESKTOP__?.nativeViews.focusHost
  if (hostFocus) {
    void hostFocus().then(() => {
      if (cancelled || !isCurrent() || !editor.isConnected
        || !editor.isContentEditable || document.activeElement !== editor) return
      editor.focus({ preventScroll: true })
    }).catch(() => undefined)
  }
  return cancel
}
