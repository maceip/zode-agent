function textBeforeCaret(root: HTMLElement, range: Range): { text: string; node: Text; offset: number } | undefined {
  let node = range.startContainer
  let offset = range.startOffset
  if (node.nodeType !== Node.TEXT_NODE) {
    const preceding = node.childNodes[offset - 1]
    if (!preceding || preceding.nodeType !== Node.TEXT_NODE) return
    node = preceding
    offset = preceding.textContent?.length ?? 0
  }
  if (!root.contains(node) || node.parentElement?.closest('pre, code, [contenteditable="false"]')) return
  return { text: (node as Text).data.slice(0, offset), node: node as Text, offset }
}

export function formatMarkdownInput(root: HTMLElement, event: InputEvent): boolean {
  if (!event.cancelable || event.defaultPrevented || event.isComposing || event.inputType !== 'insertText'
    || !event.data) return false
  const selection = root.ownerDocument.getSelection()
  if (!selection?.isCollapsed || !selection.rangeCount) return false
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return false
  const element = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element : range.startContainer.parentElement
  const completed = element?.closest<HTMLElement>('strong[data-markdown-input], em[data-markdown-input]')
  if (completed && root.contains(completed)) {
    const remainder = range.cloneRange()
    remainder.setEnd(completed, completed.childNodes.length)
    if (!remainder.toString()) {
      range.setStartAfter(completed)
      range.collapse(true)
      const document = root.ownerDocument
      const parent = completed.parentElement
      if (document.queryCommandState('bold') !== !!parent?.closest('strong, b')) document.execCommand('bold')
      if (document.queryCommandState('italic') !== !!parent?.closest('em, i')) document.execCommand('italic')
    }
  }
  if (!event.data.endsWith('*')) return false
  const before = textBeforeCaret(root, range)
  if (!before) return false

  const text = before.text + event.data
  const match = /(^|[^*])(\*{1,2})([^*\r\n]+)\2$/.exec(text)
  if (!match) return false
  const prefix = match[1]!
  const marker = match[2]!
  const content = match[3]!
  const start = match.index + prefix.length
  if (content.trim() !== content || start > before.offset) return false
  const escapes = /\\+$/.exec(text.slice(0, start))?.[0].length ?? 0
  if (escapes % 2 || text.slice(0, start).includes('`')) return false

  const document = root.ownerDocument
  const formatted = document.createElement(marker.length === 1 ? 'em' : 'strong')
  formatted.setAttribute('data-markdown-input', '')
  formatted.textContent = content

  const wasBold = document.queryCommandState('bold')
  const wasItalic = document.queryCommandState('italic')
  const original = range.cloneRange()
  const replacement = document.createRange()
  replacement.setStart(before.node, start)
  replacement.setEnd(before.node, before.offset)
  selection.removeAllRanges()
  selection.addRange(replacement)
  // Native editing commands keep this replacement in the editor's Undo history.
  if (!document.execCommand('insertHTML', false, formatted.outerHTML)) {
    selection.removeAllRanges()
    selection.addRange(original)
    return false
  }
  event.preventDefault()
  // Text typed after the closing marker should keep the surrounding style.
  if (document.queryCommandState('bold') !== wasBold) document.execCommand('bold')
  if (document.queryCommandState('italic') !== wasItalic) document.execCommand('italic')
  return true
}
