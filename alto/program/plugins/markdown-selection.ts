export interface MarkdownSelectionBookmark {
  start: number
  quote: string
  prefix: string
  suffix: string
}

export interface MarkdownSelection {
  range: Range
  text: string
  bookmark: MarkdownSelectionBookmark
}

function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest('button, svg, figcaption, [aria-hidden="true"], .markdown-table-resize-handle')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}

export function selectedMarkdown(root: HTMLElement): MarkdownSelection | undefined {
  const selection = window.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed) return
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return
  const nodes = textNodes(root)
  let offset = 0
  let start: number | undefined
  let end = 0
  for (const node of nodes) {
    if (range.intersectsNode(node)) {
      const from = range.startContainer === node ? range.startOffset : 0
      const to = range.endContainer === node ? range.endOffset : node.length
      if (to > from) { start ??= offset + from; end = offset + to }
    }
    offset += node.length
  }
  if (start === undefined) return
  const content = nodes.map(node => node.data).join('')
  const quote = content.slice(start, end)
  if (!quote.trim()) return
  const fragment = document.createElement('div')
  fragment.append(range.cloneContents())
  fragment.querySelectorAll('button, svg, figcaption, [aria-hidden="true"], .markdown-table-resize-handle').forEach(node => node.remove())
  // Keep paragraph and code line breaks in the quoted passage, without toolbar labels.
  fragment.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, pre, tr, br').forEach(node => node.after('\n'))
  return {
    range: range.cloneRange(), text: (fragment.textContent ?? '').trim(),
    bookmark: { start, quote, prefix: content.slice(Math.max(0, start - 48), start), suffix: content.slice(end, end + 48) },
  }
}

export function restoreMarkdownSelection(root: HTMLElement, bookmark: MarkdownSelectionBookmark): boolean {
  const nodes = textNodes(root)
  const content = nodes.map(node => node.data).join('')
  let start = bookmark.start
  if (content.slice(start, start + bookmark.quote.length) !== bookmark.quote) {
    const context = bookmark.prefix + bookmark.quote + bookmark.suffix
    const found = content.indexOf(context)
    if (found < 0 || content.indexOf(context, found + 1) !== -1) return false
    start = found + bookmark.prefix.length
  }
  const end = start + bookmark.quote.length
  const range = document.createRange()
  let offset = 0
  let started = false
  for (const node of nodes) {
    if (!started && start < offset + node.length) { range.setStart(node, start - offset); started = true }
    if (started && end <= offset + node.length) {
      range.setEnd(node, end - offset)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return true
    }
    offset += node.length
  }
  return false
}

export function markdownSelectionQuote(path: string, text: string): string {
  return `From ${path}:\n\n${text.trim().split('\n').map(line => `> ${line}`).join('\n')}`
}
