import {
  ArrowUp,
  Check,
  Cloud,
  Laptop,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  Plus,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type {
  ChatAttachment,
  ChatImage,
  ComposerCapability,
  ModelOption,
  PermissionMode,
  SkillOption,
} from '../../../src/shared/protocol.js'
import type { ClientSubmitMode } from '../../../src/client/plugin-api.js'
import { requestConversationFollowLatest } from './conversation-scroll.js'
import { focusComposerEditor } from './composer-focus.js'
import { agentSelection } from './agent-selection.js'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGES = 6
const MAX_ATTACHMENTS = 10

export interface SkillQuery {
  start: number
  end: number
  query: string
}

export interface ComposerDraft {
  text: string
  images: ChatImage[]
  attachments: ChatAttachment[]
  skills: SkillOption[]
}

export interface ComposerWorkspaceOption {
  id: string
  label: string
  path: string
}

export function composerInsertsNewline(event: {
  key: string
  metaKey: boolean
  shiftKey: boolean
}): boolean {
  return event.key === 'Enter' && event.shiftKey
}

export function composerSteerShortcut(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): boolean {
  return event.key === 'Enter'
    && event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
}

export function composerCommandSubmitMode(
  event: Parameters<typeof composerSteerShortcut>[0],
  activeTurn: boolean,
  allowSubmitDuringTurn: boolean,
  canSend: boolean,
): ClientSubmitMode | undefined {
  return composerSteerShortcut(event) && activeTurn && allowSubmitDuringTurn && canSend
    ? 'steer'
    : undefined
}

export function composerSubmitMode(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): ClientSubmitMode | undefined {
  if (event.key !== 'Enter' || event.shiftKey || event.metaKey) return undefined
  return event.ctrlKey ? 'steer' : 'queue'
}

export function skillQueryAt(value: string, caret: number): SkillQuery | undefined {
  const match = /(^|\s)\$([A-Za-z0-9:._-]*)$/.exec(value.slice(0, caret))
  if (!match) return undefined
  const start = match.index + (match[1]?.length ?? 0)
  return { start, end: caret, query: match[2] ?? '' }
}

export function insertSkillToken(
  value: string,
  query: SkillQuery,
  name: string,
): { value: string; caret: number } {
  const inserted = `$${name} `
  return {
    value: `${value.slice(0, query.start)}${inserted}${value.slice(query.end).replace(/^ /, '')}`,
    caret: query.start + inserted.length,
  }
}

export function selectedSkillsFor(value: string, skills: SkillOption[]): SkillOption[] {
  const names = new Set<string>()
  const tokens = /(?:^|\s)\$([A-Za-z0-9][A-Za-z0-9:._-]*)/g
  for (const match of value.matchAll(tokens)) {
    if (match[1]) names.add(match[1])
  }
  return skills.filter((skill) => names.has(skill.name))
}

export function composerWorkspaceLabel(
  projectName: string | undefined,
  workspace: string,
): string {
  const namedProject = projectName?.trim()
  if (namedProject) return namedProject

  const normalized = workspace.replaceAll('\\', '/').replace(/\/+$/, '')
  return normalized.split('/').at(-1) || 'No workspace'
}

export function shouldAutoFocusComposer(
  wasAutoFocused: boolean,
  autoFocus: boolean,
  disabled: boolean,
): boolean {
  return autoFocus && !disabled && !wasAutoFocused
}

export function composerExpands(editing: boolean, autoExpand: boolean): boolean {
  return editing && autoExpand
}

export function composerEditorHeight(measuredHeight: number, maxHeight: number): number {
  const minimum = 31
  const contentHeight = Number.isFinite(measuredHeight)
    ? Math.max(minimum, Math.ceil(measuredHeight))
    : minimum
  const ceiling = Number.isFinite(maxHeight)
    ? Math.max(minimum, Math.floor(maxHeight))
    : minimum
  return Math.min(contentHeight, ceiling)
}

export function composerEditorOverflows(measuredHeight: number, maxHeight: number): boolean {
  const contentHeight = Number.isFinite(measuredHeight)
    ? Math.max(31, Math.ceil(measuredHeight))
    : 31
  return contentHeight > composerEditorHeight(measuredHeight, maxHeight)
}

export function composerMeasurementText(value: string): string {
  return value.endsWith('\n') ? `${value}\u200b` : value
}

export function composerInsertionNeedsProjection(text: string): boolean {
  return text.includes('\n')
}

export function composerValueIsExternal(
  value: string,
  receivedValue: string,
  liveValue: string,
  valueRevision: number,
  receivedValueRevision: number,
): boolean {
  return valueRevision !== receivedValueRevision
    || (value !== receivedValue && value !== liveValue)
}

function syncComposerMeasurement(measure: HTMLDivElement | null, value: string): void {
  if (!measure) return
  const text = composerMeasurementText(value)
  if (measure.textContent !== text) measure.textContent = text
}

export function hasMarkdown(value: string): boolean {
  return /(^|\n)\s{0,3}(?:#{1,6}\s|>\s|[-+*]\s|\d+[.)]\s|```|~~~)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*|_[^_\n]+_/m.test(value)
}

export type ComposerTokenKind =
  | 'text'
  | 'strong'
  | 'emphasis'
  | 'strike'
  | 'inline-code'
  | 'code-block'
  | 'link'
  | 'skill'

export interface ComposerToken {
  kind: ComposerTokenKind
  raw: string
}

const COMPOSER_TOKEN = /```[^\n`]*\n[\s\S]*?```|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|\$[A-Za-z][A-Za-z0-9:._-]*|\*[^*\n]+\*|_[^_\n]+_/g

function tokenKind(raw: string): ComposerTokenKind {
  if (raw.startsWith('```')) return 'code-block'
  if (raw.startsWith('**') || raw.startsWith('__')) return 'strong'
  if (raw.startsWith('~~')) return 'strike'
  if (raw.startsWith('`')) return 'inline-code'
  if (raw.startsWith('[')) return 'link'
  if (raw.startsWith('$')) return 'skill'
  return 'emphasis'
}

export function composerTokens(
  value: string,
  skillNames: Iterable<string>,
  markdown = true,
): ComposerToken[] {
  const knownSkills = new Set(skillNames)
  const tokens: ComposerToken[] = []
  let offset = 0

  const appendText = (raw: string): void => {
    if (!raw) return
    const previous = tokens.at(-1)
    if (previous?.kind === 'text') previous.raw += raw
    else tokens.push({ kind: 'text', raw })
  }

  for (const match of value.matchAll(COMPOSER_TOKEN)) {
    const index = match.index
    const raw = match[0]
    appendText(value.slice(offset, index))
    const kind = tokenKind(raw)
    const skillName = kind === 'skill' ? raw.slice(1) : undefined
    const hasBoundary = index === 0 || /\s/.test(value[index - 1] ?? '')
    if (
      (kind === 'skill' && (!hasBoundary || !skillName || !knownSkills.has(skillName)))
      || (kind !== 'skill' && !markdown)
    ) {
      appendText(raw)
    } else {
      tokens.push({ kind, raw })
    }
    offset = index + raw.length
  }
  appendText(value.slice(offset))
  return tokens
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    // A trailing newline in an HTML text node does not create a visible final
    // line in contenteditable. A BR keeps the caret on that line immediately.
    .replaceAll('\n', '<br>')
}

function composerTokenHtml(token: ComposerToken): string {
  const { kind, raw } = token
  if (kind === 'text') return escapeHtml(raw)
  if (kind === 'skill') return `<span class="composer-inline-skill">${escapeHtml(raw)}</span>`
  if (kind === 'strong') {
    return `<strong data-composer-markdown="strong">${escapeHtml(raw.slice(2, -2))}</strong>`
  }
  if (kind === 'emphasis') {
    return `<em data-composer-markdown="emphasis">${escapeHtml(raw.slice(1, -1))}</em>`
  }
  if (kind === 'strike') {
    return `<s data-composer-markdown="strike">${escapeHtml(raw.slice(2, -2))}</s>`
  }
  if (kind === 'inline-code') {
    return `<code data-composer-markdown="inline-code">${escapeHtml(raw.slice(1, -1))}</code>`
  }
  if (kind === 'link') {
    const labelEnd = raw.indexOf('](')
    const url = raw.slice(labelEnd + 2, -1)
    return `<span class="composer-inline-link" data-composer-markdown="link" data-composer-url="${escapeHtml(url)}">${escapeHtml(raw.slice(1, labelEnd))}</span>`
  }

  const firstNewline = raw.indexOf('\n')
  const language = raw.slice(3, firstNewline)
  return `<span class="composer-inline-code-block" data-composer-markdown="code-block" data-composer-language="${escapeHtml(language)}"><code>${escapeHtml(raw.slice(firstNewline + 1, -3))}</code></span>`
}

export function composerHtml(
  value: string,
  skillNames: Iterable<string>,
  markdown = true,
): string {
  const html = composerTokens(value, skillNames, markdown).map(composerTokenHtml).join('')
  // Chromium places a range after a trailing BR on the preceding line. Keep a
  // second, non-serialized BR after it so typed text lands on the new line.
  return value.endsWith('\n')
    ? `${html}<br data-composer-trailing-break>`
    : html
}

interface MarkdownAffixes {
  prefix: string
  suffix: string
  content: Node
}

function markdownAffixes(element: HTMLElement): MarkdownAffixes | undefined {
  const kind = element.dataset.composerMarkdown
  if (kind === 'strong') return { prefix: '**', suffix: '**', content: element }
  if (kind === 'emphasis') return { prefix: '*', suffix: '*', content: element }
  if (kind === 'strike') return { prefix: '~~', suffix: '~~', content: element }
  if (kind === 'inline-code') return { prefix: '`', suffix: '`', content: element }
  if (kind === 'link') {
    return {
      prefix: '[',
      suffix: `](${element.dataset.composerUrl ?? ''})`,
      content: element,
    }
  }
  if (kind === 'code-block') {
    const code = element.querySelector(':scope > code') ?? element
    return {
      prefix: `\`\`\`${element.dataset.composerLanguage ?? ''}\n`,
      suffix: '```',
      content: code,
    }
  }
  return undefined
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''
  if (node.tagName === 'BR') {
    return node.hasAttribute('data-composer-trailing-break') ? '' : '\n'
  }
  const affixes = markdownAffixes(node)
  if (affixes) {
    const content = [...affixes.content.childNodes].map(serializeNode).join('')
    return content ? `${affixes.prefix}${content}${affixes.suffix}` : ''
  }
  const content = [...node.childNodes].map(serializeNode).join('')
  if ((node.tagName === 'DIV' || node.tagName === 'P') && node.nextSibling) return `${content}\n`
  return content
}

function serializeEditor(root: HTMLElement): string {
  const children = [...root.childNodes]
  // After deletion, Chromium can wrap its filler BR in empty block elements.
  // Follow a single-child chain so intentional blank lines keep their siblings.
  let filler: Node = root
  while (filler.childNodes.length === 1) filler = filler.childNodes[0]!
  if (
    filler instanceof HTMLElement
    && filler.tagName === 'BR'
    && !filler.hasAttribute('data-composer-trailing-break')
  ) return ''
  return children.map(serializeNode).join('')
}

function selectionOffset(root: HTMLElement, target: Node | null, targetOffset: number): number {
  if (!target || (target !== root && !root.contains(target))) return serializeEditor(root).length

  const visit = (container: Node, offset: number): number | undefined => {
    if (container === target) {
      if (container.nodeType === Node.TEXT_NODE) return Math.min(targetOffset, container.textContent?.length ?? 0)
      const targetElement = container instanceof HTMLElement ? container : undefined
      let before = targetElement ? markdownAffixes(targetElement)?.prefix.length ?? 0 : 0
      for (let index = 0; index < Math.min(targetOffset, container.childNodes.length); index += 1) {
        const child = container.childNodes[index]
        if (child) before += serializeNode(child).length
      }
      return before
    }

    const element = container instanceof HTMLElement ? container : undefined
    const affixes = element ? markdownAffixes(element) : undefined
    const content = affixes?.content ?? container
    let before = affixes?.prefix.length ?? 0
    for (const child of content.childNodes) {
      if (child === target || child.contains(target)) {
        const inside = visit(child, offset)
        if (inside === undefined) return undefined
        const position = before + inside
        const contentLength = [...content.childNodes]
          .map(serializeNode)
          .join('')
          .length
        const contentEnd = (affixes?.prefix.length ?? 0) + contentLength
        // A visual caret at the end of formatted text belongs after its hidden
        // closing Markdown delimiter. This keeps the next word from inheriting
        // bold, emphasis, code, or link styling.
        return affixes && position === contentEnd
          ? position + affixes.suffix.length
          : position
      }
      before += serializeNode(child).length
    }
    return undefined
  }

  return visit(root, targetOffset) ?? serializeEditor(root).length
}

function caretOffset(root: HTMLElement): number {
  const selection = window.getSelection()
  return selectionOffset(root, selection?.focusNode ?? null, selection?.focusOffset ?? 0)
}

function moveSelection(
  root: HTMLElement,
  alter: 'move' | 'extend',
  direction: 'backward' | 'forward',
  granularity: 'character' | 'word' | 'line' | 'lineboundary',
): number | undefined {
  const selection = window.getSelection()
  if (!selection?.focusNode || !root.contains(selection.focusNode)) return undefined

  const before = caretOffset(root)
  selection.modify(alter, direction, granularity)
  let after = caretOffset(root)

  // Markdown delimiters are hidden in the rich projection. Skip the duplicate
  // logical position at the edge of a styled node so one arrow press always
  // moves one visible character.
  if (granularity === 'character' && after === before) {
    selection.modify(alter, direction, granularity)
    after = caretOffset(root)
  }
  return after
}

function formattedAncestor(root: HTMLElement, node: Node | null): HTMLElement | undefined {
  let element = node instanceof HTMLElement ? node : node?.parentElement
  while (element && element !== root) {
    if (markdownAffixes(element)) return element
    element = element.parentElement
  }
  return undefined
}

function exitFormattedText(root: HTMLElement): boolean {
  const selection = window.getSelection()
  if (!selection?.isCollapsed || !selection.focusNode) return false
  const element = formattedAncestor(root, selection.focusNode)
  const affixes = element ? markdownAffixes(element) : undefined
  if (!element || !affixes || !affixes.content.contains(selection.focusNode)) return false

  const remainder = document.createRange()
  remainder.setStart(selection.focusNode, selection.focusOffset)
  remainder.setEnd(affixes.content, affixes.content.childNodes.length)
  if (remainder.toString()) return false

  const range = document.createRange()
  range.setStartAfter(element)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

function setCaretOffset(root: HTMLElement, requestedOffset: number): void {
  const selection = window.getSelection()
  if (!selection) return
  const target = Math.max(0, Math.min(requestedOffset, serializeEditor(root).length))
  const range = document.createRange()

  const place = (container: Node, remaining: number): boolean => {
    if (container.nodeType === Node.TEXT_NODE) {
      range.setStart(container, Math.min(remaining, container.textContent?.length ?? 0))
      return true
    }

    const element = container instanceof HTMLElement ? container : undefined
    const affixes = element ? markdownAffixes(element) : undefined
    const content = affixes?.content ?? container
    const prefixLength = affixes?.prefix.length ?? 0
    if (remaining < prefixLength) {
      range.setStart(content, 0)
      return true
    }
    remaining -= prefixLength

    for (const child of content.childNodes) {
      const length = serializeNode(child).length
      if (remaining < length) return place(child, remaining)
      if (remaining === length) {
        if (child.nodeType === Node.TEXT_NODE) return place(child, remaining)
        range.setStartAfter(child)
        return true
      }
      remaining -= length
    }
    range.setStart(content, content.childNodes.length)
    return true
  }

  place(root, target)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

function scrollComposerCaretIntoView(
  root: HTMLElement,
  caret: number,
  contentLength: number,
): void {
  window.requestAnimationFrame(() => {
    if (!root.isConnected) return
    if (caret >= contentLength) {
      root.scrollTop = root.scrollHeight
      return
    }

    const selection = window.getSelection()
    if (!selection?.rangeCount || !selection.focusNode || !root.contains(selection.focusNode)) return
    const caretRect = selection.getRangeAt(0).getBoundingClientRect()
    const editorRect = root.getBoundingClientRect()
    const inset = 4
    if (caretRect.bottom > editorRect.bottom - inset) {
      root.scrollTop += caretRect.bottom - editorRect.bottom + inset
    } else if (caretRect.top < editorRect.top + inset) {
      root.scrollTop -= editorRect.top - caretRect.top + inset
    }
  })
}

function insertTextAtCaret(root: HTMLElement, text: string): { value: string; caret: number } {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !selection.anchorNode || !root.contains(selection.anchorNode)) {
    const value = `${serializeEditor(root)}${text}`
    return { value, caret: value.length }
  }
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const inserted = document.createTextNode(text)
  range.insertNode(inserted)
  range.setStartAfter(inserted)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return { value: serializeEditor(root), caret: caretOffset(root) }
}

function filterSkills(skills: SkillOption[], query: string): SkillOption[] {
  const needle = query.toLocaleLowerCase()
  if (!needle) return skills.slice(0, 8)

  const score = (skill: SkillOption): number => {
    const name = skill.name.toLocaleLowerCase()
    const displayName = skill.displayName?.toLocaleLowerCase() ?? ''
    if (name === needle) return 0
    if (name.startsWith(needle)) return 1
    if (displayName.startsWith(needle)) return 2
    if (name.includes(needle)) return 3
    if (displayName.includes(needle)) return 4
    if (
      skill.shortDescription?.toLocaleLowerCase().includes(needle)
      || skill.description.toLocaleLowerCase().includes(needle)
    ) return 5
    return Number.POSITIVE_INFINITY
  }

  return skills
    .map((skill) => ({ skill, score: score(skill) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => left.score - right.score || left.skill.name.localeCompare(right.skill.name))
    .slice(0, 8)
    .map(({ skill }) => skill)
}

function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error(`Could not read ${file.name}`))
    })
    reader.addEventListener('error', () => reject(reader.error ?? new Error(`Could not read ${file.name}`)))
    reader.readAsDataURL(file)
  })
}

function imageError(file: File): string | undefined {
  if (!IMAGE_TYPES.has(file.type)) return `${file.name || 'That file'} is not a supported image.`
  if (file.size > MAX_IMAGE_BYTES) return `${file.name || 'That image'} is larger than 10 MB.`
  return undefined
}

function effortLabel(effort: string | undefined): string {
  if (!effort) return 'Default'
  if (effort.toLocaleLowerCase() === 'xhigh') return 'XHigh'
  return `${effort.charAt(0).toLocaleUpperCase()}${effort.slice(1)}`
}

const permissionOptions: Array<{
  mode: PermissionMode
  label: string
  description: string
}> = [
  { mode: 'ask', label: 'Ask', description: 'Pause when access needs your approval.' },
  { mode: 'auto', label: 'Auto', description: 'Let a reviewer handle boundary requests.' },
  { mode: 'full', label: 'Full access', description: 'Run without a sandbox or approvals.' },
]

function permissionLabel(mode: PermissionMode): string {
  return permissionOptions.find((option) => option.mode === mode)?.label ?? 'Ask'
}

function PermissionIcon({ mode, size = 15 }: { mode: PermissionMode; size?: number }): ReactNode {
  if (mode === 'auto') return <ShieldCheck size={size} />
  if (mode === 'full') return <ShieldAlert size={size} />
  return <Shield size={size} />
}

export function Composer({
  toolbarActions,
  sendLabel,
  value,
  images,
  attachments,
  skills,
  models,
  providers = [],
  providerId = 'codex',
  providerLocked = false,
  agentConfig = [],
  onAgentConfigChange,
  onProviderChange,
  model,
  effort,
  permissionMode,
  workspaceId,
  workspaceLabel,
  workspaceOptions,
  workspaceLocked,
  remoteWorkspace = false,
  capabilities,
  placeholder,
  focusHeight,
  maxHeight,
  valueRevision = 0,
  autoExpand = false,
  autoFocus = false,
  disabled,
  readOnly = disabled,
  sending,
  activeTurn,
  allowSubmitDuringTurn,
  onChange,
  onImagesChange,
  onAttachmentsChange,
  onAttachFile,
  onModelChange,
  onModelsRequest,
  onEffortChange,
  onPermissionModeChange,
  onWorkspaceChange,
  onSubmit,
  onInterrupt,
}: {
  toolbarActions?: ReactNode
  sendLabel?: string | undefined
  value: string
  images: ChatImage[]
  attachments: ChatAttachment[]
  skills: SkillOption[]
  models: ModelOption[]
  providers?: import('../session-api.js').ClientSessionSnapshot['providers'] | undefined
  providerId?: string | undefined
  agentConfig?: import('../../../src/server/services/agent-registry.js').AgentConfigOption[] | undefined
  onAgentConfigChange?: (id: string, value: string) => void
  providerLocked?: boolean
  onProviderChange?: (id: string) => void
  model: string | undefined
  effort: string | undefined
  permissionMode: PermissionMode
  workspaceId: string | undefined
  workspaceLabel: string
  workspaceOptions: ComposerWorkspaceOption[]
  workspaceLocked: boolean
  remoteWorkspace?: boolean
  capabilities: ComposerCapability[]
  placeholder: string
  focusHeight: number
  maxHeight: number
  valueRevision?: number
  autoExpand?: boolean
  autoFocus?: boolean
  disabled: boolean
  readOnly?: boolean
  sending: boolean
  activeTurn: boolean
  allowSubmitDuringTurn: boolean
  onChange: (value: string) => void
  onImagesChange: (images: ChatImage[]) => void
  onAttachmentsChange: (attachments: ChatAttachment[]) => void
  onAttachFile: (file: File) => Promise<ChatAttachment>
  onModelChange: (model: string | undefined) => void
  onModelsRequest?: () => Promise<void>
  onEffortChange: (effort: string | undefined) => void
  onPermissionModeChange: (mode: PermissionMode) => void
  onWorkspaceChange: (id: string) => void
  onSubmit: (draft: ComposerDraft, mode: ClientSubmitMode) => void
  onInterrupt: () => void
}): ReactNode {
  const editor = useRef<HTMLDivElement>(null)
  const editorMeasure = useRef<HTMLDivElement>(null)
  const pendingCaret = useRef<number | undefined>(undefined)
  const fileInput = useRef<HTMLInputElement>(null)
  const modelControl = useRef<HTMLDivElement>(null)
  const permissionControl = useRef<HTMLDivElement>(null)
  const workspaceControl = useRef<HTMLDivElement>(null)
  const locationControl = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)
  const caret = useRef(0)
  const liveValue = useRef(value)
  const receivedValue = useRef(value)
  const receivedValueRevision = useRef(valueRevision)
  const projectionInitialized = useRef(false)
  const [, setCaretRevision] = useState(0)
  const [hasMessage, setHasMessage] = useState(() => Boolean(value.trim()))
  const [activeSkill, setActiveSkill] = useState(0)
  const [dismissedQuery, setDismissedQuery] = useState<string>()
  const [dragging, setDragging] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editorOverflowing, setEditorOverflowing] = useState(false)
  const [instantFocus, setInstantFocus] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string>()
  const [modelPickerPage, setModelPickerPage] = useState<string>()
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string>()
  const [permissionPickerOpen, setPermissionPickerOpen] = useState(false)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [locationPickerOpen, setLocationPickerOpen] = useState(false)
  const selection = agentSelection(providers, providerId)

  const requestModels = async (): Promise<void> => {
    if (!onModelsRequest || modelsLoading) return
    setModelsLoading(true)
    setModelsError(undefined)
    try {
      await onModelsRequest()
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : String(error))
    } finally {
      setModelsLoading(false)
    }
  }

  const updateLiveValue = (nextValue: string): void => {
    const hadMessage = Boolean(liveValue.current.trim())
    liveValue.current = nextValue
    syncComposerMeasurement(editorMeasure.current, nextValue)
    const nextHasMessage = Boolean(nextValue.trim())
    if (hadMessage !== nextHasMessage) setHasMessage(nextHasMessage)
  }

  const capabilitySet = useMemo(() => new Set(capabilities), [capabilities])
  const query = capabilitySet.has('skills')
    ? skillQueryAt(liveValue.current, caret.current)
    : undefined
  const queryKey = query ? `${query.start}:${query.query}` : undefined
  const matchingSkills = useMemo(
    () => filterSkills(skills, query?.query ?? ''),
    [query?.query, skills],
  )
  const pickerOpen = query !== undefined && queryKey !== dismissedQuery
  const inlineSkillNames = useMemo(
    () => capabilitySet.has('skills') ? skills.map((skill) => skill.name) : [],
    [capabilitySet, skills],
  )
  const canSend = hasMessage || Boolean(images.length || attachments.length)
  const selectedModel = models.find((option) => option.id === model)
    ?? models.find((option) => option.isDefault)
    ?? models[0]
  const reasoningEffort = effort ?? selectedModel?.defaultReasoningEffort
  const reasoningOptions = selectedModel?.supportedReasoningEfforts ?? []
  const modelSummary = [selectedModel?.displayName ?? `${selection.label} default`, effortLabel(reasoningEffort)].join(' ')

  const wasAutoFocused = useRef(false)
  const autoFocusCurrent = useRef(autoFocus && !readOnly)
  autoFocusCurrent.current = autoFocus && !readOnly

  useLayoutEffect(() => {
    if (!autoFocus) {
      wasAutoFocused.current = false
      return
    }
    const activated = shouldAutoFocusComposer(wasAutoFocused.current, autoFocus, readOnly)
    if (!activated) return
    wasAutoFocused.current = true

    const input = editor.current
    if (!input) return
    setInstantFocus(true)
    setEditing(true)
    return focusComposerEditor(input, () => autoFocusCurrent.current)
  }, [autoFocus, readOnly])

  useLayoutEffect(() => {
    const input = editor.current
    if (!input) return

    const focused = document.activeElement === input
    const requestedCaret = pendingCaret.current
    const externalValueChanged = composerValueIsExternal(
      value,
      receivedValue.current,
      liveValue.current,
      valueRevision,
      receivedValueRevision.current,
    )
    receivedValue.current = value
    receivedValueRevision.current = valueRevision
    // Native editing owns ordinary keystrokes. Reconcile the rich projection
    // only for initialization, skill insertion, or an explicit parent reset.
    const shouldProject = !projectionInitialized.current
      || requestedCaret !== undefined
      || externalValueChanged
    if (!shouldProject) {
      syncComposerMeasurement(editorMeasure.current, liveValue.current)
      return
    }
    if (externalValueChanged) updateLiveValue(value)
    const projectedHtml = composerHtml(
      liveValue.current,
      inlineSkillNames,
      capabilitySet.has('markdown'),
    )
    const projectionChanged = input.innerHTML !== projectedHtml
    const nextCaret = requestedCaret
      ?? (focused && projectionChanged ? caretOffset(input) : undefined)
    if (projectionChanged) {
      input.innerHTML = projectedHtml
    }
    if (focused && nextCaret !== undefined) {
      setCaretOffset(input, nextCaret)
      scrollComposerCaretIntoView(input, nextCaret, liveValue.current.length)
    }
    pendingCaret.current = undefined
    projectionInitialized.current = true
    syncComposerMeasurement(editorMeasure.current, liveValue.current)
  })

  useLayoutEffect(() => {
    const input = editor.current
    const measure = editorMeasure.current
    if (!input || !measure) return

    const resize = (): void => {
      const measuredHeight = measure.scrollHeight
      const height = `${composerEditorHeight(measuredHeight, maxHeight)}px`
      if (input.style.getPropertyValue('--composer-editor-height') !== height) {
        input.style.setProperty('--composer-editor-height', height)
      }
      const overflowing = composerEditorOverflows(measuredHeight, maxHeight)
      if (!overflowing && input.scrollTop !== 0) input.scrollTop = 0
      setEditorOverflowing((current) => current === overflowing ? current : overflowing)
    }

    resize()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(resize)
    observer.observe(measure)
    return () => observer.disconnect()
  }, [maxHeight])

  useEffect(() => setActiveSkill(0), [query?.query])

  useEffect(() => {
    if (!modelPickerPage) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!modelControl.current?.contains(event.target as Node)) setModelPickerPage(undefined)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setModelPickerPage(undefined)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [modelPickerPage])

  useEffect(() => {
    if (!permissionPickerOpen) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!permissionControl.current?.contains(event.target as Node)) setPermissionPickerOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setPermissionPickerOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [permissionPickerOpen])

  useEffect(() => {
    if (!workspacePickerOpen) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!workspaceControl.current?.contains(event.target as Node)) setWorkspacePickerOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setWorkspacePickerOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [workspacePickerOpen])

  useEffect(() => {
    if (!locationPickerOpen) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!locationControl.current?.contains(event.target as Node)) setLocationPickerOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setLocationPickerOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [locationPickerOpen])

  const addFiles = async (files: File[]): Promise<void> => {
    setAttachmentError(undefined)
    const acceptsImages = capabilitySet.has('images')
    const acceptsFiles = capabilitySet.has('files')
    const imageFiles = acceptsImages
      ? files.filter((file) => IMAGE_TYPES.has(file.type))
      : []
    const attachmentFiles = files.filter((file) => !acceptsImages || !IMAGE_TYPES.has(file.type))

    if (imageFiles.length > MAX_IMAGES - images.length) {
      setAttachmentError(`You can attach up to ${MAX_IMAGES} images.`)
      return
    }
    if (attachmentFiles.length > MAX_ATTACHMENTS - attachments.length) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files.`)
      return
    }
    if (attachmentFiles.length && !acceptsFiles) {
      setAttachmentError(`${attachmentFiles[0]?.name || 'That file'} is not a supported image.`)
      return
    }
    const problem = imageFiles.map(imageError).find((error) => error !== undefined)
    if (problem) {
      setAttachmentError(problem)
      return
    }
    try {
      const imageAdditions = await Promise.all(imageFiles.map(async (file) => ({
        name: file.name || 'Pasted image',
        mediaType: file.type,
        url: await dataUrl(file),
      })))
      const attachmentAdditions = await Promise.all(attachmentFiles.map(onAttachFile))
      if (imageAdditions.length) onImagesChange([...images, ...imageAdditions])
      if (attachmentAdditions.length) {
        onAttachmentsChange([...attachments, ...attachmentAdditions])
      }
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error))
    }
  }

  const updateCaret = (
    nextCaret: number,
    renderQueryChange = false,
    nextValue?: string,
  ): void => {
    const previousQuery = skillQueryAt(liveValue.current, caret.current)
    if (nextValue !== undefined) updateLiveValue(nextValue)
    caret.current = nextCaret
    if (!renderQueryChange) return
    const nextQuery = skillQueryAt(liveValue.current, nextCaret)
    const previousKey = previousQuery ? `${previousQuery.start}:${previousQuery.query}` : undefined
    const nextKey = nextQuery ? `${nextQuery.start}:${nextQuery.query}` : undefined
    if (previousKey !== nextKey) setCaretRevision((revision) => revision + 1)
  }

  const chooseSkill = (skill: SkillOption): void => {
    if (!query) return
    const next = insertSkillToken(liveValue.current, query, skill.name)
    pendingCaret.current = next.caret
    updateCaret(next.caret, true, next.value)
    onChange(next.value)
    setDismissedQuery(undefined)
    requestAnimationFrame(() => {
      editor.current?.focus()
      if (editor.current) setCaretOffset(editor.current, next.caret)
    })
  }

  const currentDraft = (): ComposerDraft => {
    const text = liveValue.current
    return { text, images, attachments, skills: selectedSkillsFor(text, skills) }
  }

  const submit = (mode: ClientSubmitMode = 'queue'): void => {
    const draft = currentDraft()
    if (
      (!draft.text.trim() && !draft.images.length && !draft.attachments.length)
      || sending
      || disabled
      || (activeTurn && !allowSubmitDuringTurn)
    ) return
    onSubmit(draft, mode)
  }

  const insertText = (text: string): void => {
    const input = editor.current
    if (!input) return
    const next = insertTextAtCaret(input, text)
    if (composerInsertionNeedsProjection(text)) {
      const projectedHtml = composerHtml(
        next.value,
        inlineSkillNames,
        capabilitySet.has('markdown'),
      )
      if (input.innerHTML !== projectedHtml) input.innerHTML = projectedHtml
      setCaretOffset(input, next.caret)
      scrollComposerCaretIntoView(input, next.caret, next.value.length)
    }
    updateCaret(next.caret, true, next.value)
    setDismissedQuery(undefined)
    onChange(next.value)
  }

  const rememberCaret = (input: HTMLDivElement): void => {
    exitFormattedText(input)
    const nextCaret = caretOffset(input)
    if (nextCaret === caret.current) return
    updateCaret(nextCaret, true)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (pickerOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setActiveSkill((index) => (
          matchingSkills.length ? (index + direction + matchingSkills.length) % matchingSkills.length : 0
        ))
        return
      }
      if (
        (event.key === 'Tab' || (
          event.key === 'Enter'
          && !event.shiftKey
          && !event.metaKey
          && !event.ctrlKey
        ))
        && matchingSkills[activeSkill]
      ) {
        event.preventDefault()
        chooseSkill(matchingSkills[activeSkill])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedQuery(queryKey)
        return
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      const scope = event.currentTarget.closest('.workspace-chat-pane')
        ?? event.currentTarget.closest('main')
      const conversation = scope?.querySelector<HTMLElement>('.conversation-feed')
      if (conversation) conversation.focus({ preventScroll: true })
      else event.currentTarget.blur()
      return
    }
    if (composerSteerShortcut(event)) {
      event.preventDefault()
      const mode = composerCommandSubmitMode(event, activeTurn, allowSubmitDuringTurn, canSend)
      if (!event.repeat && mode) {
        requestConversationFollowLatest(event.currentTarget)
        submit(mode)
      }
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const nextCaret = moveSelection(
        event.currentTarget,
        event.shiftKey ? 'extend' : 'move',
        event.key === 'ArrowLeft' ? 'backward' : 'forward',
        event.altKey ? 'word' : event.metaKey ? 'lineboundary' : 'character',
      )
      if (nextCaret !== undefined) updateCaret(nextCaret, true)
      return
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const nextCaret = moveSelection(
        event.currentTarget,
        event.shiftKey ? 'extend' : 'move',
        event.key === 'ArrowUp' ? 'backward' : 'forward',
        'line',
      )
      if (nextCaret !== undefined) updateCaret(nextCaret, true)
      return
    }
    const mode = composerSubmitMode(event)
    if (mode) {
      event.preventDefault()
      submit(mode)
      return
    }
    if (composerInsertsNewline(event)) {
      event.preventDefault()
      insertText('\n')
    }
  }

  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (
      (!capabilitySet.has('images') && !capabilitySet.has('files'))
      || !event.dataTransfer.types.includes('Files')
    ) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!dragging) return
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!capabilitySet.has('images') && !capabilitySet.has('files')) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    void addFiles([...event.dataTransfer.files])
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const pastedFiles = capabilitySet.has('images') || capabilitySet.has('files')
      ? [...event.clipboardData.files]
      : []
    if (pastedFiles.length) {
      event.preventDefault()
      void addFiles(pastedFiles)
      return
    }
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    event.preventDefault()
    insertText(text.replaceAll('\r\n', '\n'))
  }

  return (
    <footer
      className="composer-wrap shell-composer"
      style={{
        '--composer-focus-height': `${focusHeight}px`,
        '--composer-max-height': `${maxHeight}px`,
      } as CSSProperties}
    >
      <div
        className={`composer ${editing ? 'is-editing' : ''} ${composerExpands(editing, autoExpand) ? 'is-expanded' : ''} ${editorOverflowing ? 'is-overflowing' : ''} ${instantFocus ? 'composer-focus-continuity' : ''} ${dragging ? 'is-dragging' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={(event) => {
          if (capabilitySet.has('images') || capabilitySet.has('files')) event.preventDefault()
        }}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {pickerOpen && (
          <div className="skill-picker" id="composer-skill-picker" role="listbox" aria-label="Skills">
            {matchingSkills.map((skill, index) => (
              <button
                className={index === activeSkill ? 'active' : ''}
                type="button"
                role="option"
                aria-selected={index === activeSkill}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseSkill(skill)}
                key={`${skill.name}:${skill.path}`}
              >
                <span className="skill-picker-name">${skill.name}</span>
                <span>{skill.shortDescription ?? skill.description}</span>
              </button>
            ))}
            {!matchingSkills.length && <div className="skill-picker-empty">No matching skills</div>}
          </div>
        )}

        <div className="composer-body">
          <div
            ref={editor}
            className="composer-editor"
            data-cordis-composer-editor
            contentEditable={readOnly ? false : 'plaintext-only'}
            suppressContentEditableWarning
            data-placeholder={placeholder}
            data-empty={!hasMessage}
            aria-label={placeholder}
            aria-placeholder={placeholder}
            aria-disabled={readOnly}
            aria-multiline="true"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={pickerOpen}
            aria-controls={pickerOpen ? 'composer-skill-picker' : undefined}
            onFocus={() => setEditing(true)}
            onInput={(event: FormEvent<HTMLDivElement>) => {
              const nextValue = serializeEditor(event.currentTarget)
              updateCaret(caretOffset(event.currentTarget), true, nextValue)
              onChange(nextValue)
              setDismissedQuery(undefined)
            }}
            onClick={(event) => rememberCaret(event.currentTarget)}
            onKeyUp={(event) => {
              if (['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                rememberCaret(event.currentTarget)
              }
            }}
            onBlur={() => {
              setEditing(false)
              setInstantFocus(false)
            }}
            onKeyDown={onKeyDown}
            onBeforeInput={(event: FormEvent<HTMLDivElement>) => {
              const input = event.nativeEvent as InputEvent
              if (
                input.inputType !== 'insertText'
                || !input.data
                || input.isComposing
                || !exitFormattedText(event.currentTarget)
              ) return
              event.preventDefault()
              insertText(input.data)
            }}
            onPaste={onPaste}
          />

          <div
            ref={editorMeasure}
            className="composer-editor composer-editor-measure"
            aria-hidden="true"
          />

          {images.length > 0 && (
            <div className="composer-images" aria-label="Attached images">
              {images.map((image, index) => (
                <figure key={`${image.name}:${index}`}>
                  <img src={image.url} alt={image.name} />
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    onClick={() => onImagesChange(images.filter((_, candidate) => candidate !== index))}
                  >
                    <X size={12} />
                  </button>
                </figure>
              ))}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="composer-files" aria-label="Attached files">
              {attachments.map((attachment, index) => (
                <div className="composer-file" title={attachment.path} key={`${attachment.path}:${index}`}>
                  <FileText size={15} strokeWidth={1.6} />
                  <span>{attachment.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => onAttachmentsChange(attachments.filter((_, candidate) => candidate !== index))}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {attachmentError && <div className="composer-error" role="status">{attachmentError}</div>}
        </div>

        {dragging && <div className="composer-drop-target">Drop files here</div>}

        {(capabilitySet.has('images') || capabilitySet.has('files')) && (
          <>
            <button
              className="composer-attach"
              type="button"
              title="Attach files"
              aria-label="Attach files"
              disabled={disabled}
              onClick={() => fileInput.current?.click()}
            >
              <Plus size={16} strokeWidth={1.5} />
            </button>
            <input
              ref={fileInput}
              className="composer-file-input"
              type="file"
              {...(!capabilitySet.has('files') ? { accept: 'image/png,image/jpeg,image/webp,image/gif' } : {})}
              multiple
              tabIndex={-1}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                void addFiles([...(event.target.files ?? [])])
                event.target.value = ''
              }}
            />
          </>
        )}

        <div className="composer-context-controls">
          <div className="composer-permission-control" ref={permissionControl}>
            <button
              className={`composer-permission-trigger mode-${permissionMode}`}
              type="button"
              aria-label={`Permissions: ${permissionLabel(permissionMode)}`}
              aria-haspopup="menu"
              aria-expanded={permissionPickerOpen}
              disabled={disabled || activeTurn}
              onClick={() => {
                setPermissionPickerOpen((open) => !open)
                setModelPickerPage(undefined)
                setWorkspacePickerOpen(false)
                setLocationPickerOpen(false)
              }}
            >
              <PermissionIcon mode={permissionMode} />
              <span>{permissionLabel(permissionMode)}</span>
            </button>

            {permissionPickerOpen && (
              <div className="composer-permission-picker" role="menu" aria-label="Permissions">
                {(providerId === 'codex' ? permissionOptions : [
                  { mode: 'ask' as const, label: 'Ask', description: 'Show permission requests from this agent.' },
                  { mode: 'full' as const, label: 'Full access', description: 'Approve permission requests from this agent automatically.' },
                ]).map((option) => {
                  const selected = option.mode === permissionMode
                  return (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={`mode-${option.mode}`}
                      key={option.mode}
                      onClick={() => {
                        onPermissionModeChange(option.mode)
                        setPermissionPickerOpen(false)
                      }}
                    >
                      <span className="permission-option-icon"><PermissionIcon mode={option.mode} /></span>
                      <span className="permission-option-copy">
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                      {selected && <Check size={15} />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {providers.length > 0 && (
            <div className="composer-permission-control composer-location-control" ref={locationControl}>
              <button
                className="composer-workspace-trigger"
                type="button"
                aria-label={`Run on: ${selection.locationLabel}`}
                aria-haspopup="menu"
                aria-expanded={locationPickerOpen}
                title={providerLocked ? `Runs on ${selection.locationLabel}. Start a new chat to change location.` : 'Choose where the agent runs'}
                onClick={() => {
                  setLocationPickerOpen((open) => !open)
                  setPermissionPickerOpen(false)
                  setWorkspacePickerOpen(false)
                  setModelPickerPage(undefined)
                }}
              >
                {selection.locationId === 'local' ? <Laptop size={14} strokeWidth={1.7} /> : <Cloud size={14} strokeWidth={1.7} />}
                <span>{selection.locationLabel}</span>
              </button>
              {locationPickerOpen && (
                <div className="composer-workspace-picker" role="menu" aria-label="Run on">
                  {selection.locations.map((location) => (
                    <button
                      key={location.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={location.id === selection.locationId}
                      disabled={providerLocked || !location.provider}
                      title={!location.provider ? `${selection.label} is not available on ${location.label}` : undefined}
                      onClick={() => {
                        if (location.provider && location.id !== selection.locationId) onProviderChange?.(location.provider.id)
                        setLocationPickerOpen(false)
                      }}
                    >
                      {location.id === 'local' ? <Laptop size={14} /> : <Cloud size={14} />}
                      <span>{location.label}</span>
                      {location.id === selection.locationId && <Check size={14} />}
                    </button>
                  ))}
                  {providerLocked && <div className="composer-workspace-empty">Start a new chat to change location.</div>}
                </div>
              )}
            </div>
          )}

          {remoteWorkspace && workspaceLabel && (
            <div className="composer-workspace-control">
              <span className="composer-workspace-trigger is-readonly" title={`Workspace: ${workspaceLabel}`}>
                <Folder size={14} strokeWidth={1.7} />
                <span>{workspaceLabel}</span>
              </span>
            </div>
          )}
          {!remoteWorkspace && !workspaceLocked && (
            <div className="composer-workspace-control" ref={workspaceControl}>
              <button
                className="composer-workspace-trigger"
                type="button"
                title={`Workspace: ${workspaceLabel}. Change workspace.`}
                aria-label={`Workspace: ${workspaceLabel}`}
                aria-haspopup="menu"
                aria-expanded={workspacePickerOpen}
                disabled={disabled}
                onClick={() => {
                  setWorkspacePickerOpen((open) => !open)
                  setPermissionPickerOpen(false)
                  setLocationPickerOpen(false)
                  setModelPickerPage(undefined)
                }}
              >
                <Folder size={14} strokeWidth={1.7} />
                <span>{workspaceLabel}</span>
              </button>

              {workspacePickerOpen && (
                <div className="composer-workspace-picker" role="menu" aria-label="Workspace">
                  {workspaceOptions.map((workspace) => {
                    const selected = (workspace.id === '' && workspaceId === undefined)
                      || workspace.id === workspaceId
                    return (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        title={workspace.path}
                        key={workspace.id}
                        onClick={() => {
                          onWorkspaceChange(workspace.id)
                          setWorkspacePickerOpen(false)
                        }}
                      >
                        <Folder size={14} strokeWidth={1.7} />
                        <span>{workspace.label}</span>
                        {selected && <Check size={14} />}
                      </button>
                    )
                  })}
                  {!workspaceOptions.length && (
                    <div className="composer-workspace-empty">No saved workspaces</div>
                  )}
                </div>
              )}
            </div>
          )}
          {toolbarActions}
        </div>

        <div className="composer-model-control" ref={modelControl}>
          <button
            className="composer-model-trigger"
            type="button"
            aria-label={`Model and reasoning: ${modelSummary}`}
            aria-haspopup="menu"
            aria-expanded={modelPickerPage !== undefined}
            disabled={(disabled && (providerLocked || providers.length < 2)) || (models.length === 0 && providers.length === 0 && !onModelsRequest)}
            onClick={() => {
              setModelPickerPage((page) => page ? undefined : 'root')
              setLocationPickerOpen(false)
              setPermissionPickerOpen(false)
              setWorkspacePickerOpen(false)
            }}
          >
            {providerId === 'codex' ? modelSummary : [selection.label, selectedModel?.displayName, effortLabel(reasoningEffort)].filter(Boolean).join(' · ')}
          </button>

          {modelPickerPage && (
            <div className="composer-model-picker" role="menu" aria-label="Model and reasoning">
              {modelPickerPage === 'root' && (
                <>
                  {providers.length > 0 && <button className="composer-picker-row" type="button"
                    disabled={providerLocked} title={providerLocked ? 'Start a new chat to change agent' : 'Choose an agent'}
                    onClick={() => setModelPickerPage('agent')}>
                    <span>Agent</span>
                    <span>{selection.label}</span>
                    <ChevronRight size={16} />
                  </button>}
                  <button className="composer-picker-row" type="button" disabled={models.length === 0 && !onModelsRequest} onClick={() => {
                    setModelPickerPage('model')
                    void requestModels()
                  }}>
                    <span>Model</span>
                    <span>{selectedModel?.displayName ?? 'Agent default'}</span>
                    <ChevronRight size={16} />
                  </button>
                  <button
                    className="composer-picker-row"
                    type="button"
                    disabled={reasoningOptions.length === 0}
                    onClick={() => setModelPickerPage('effort')}
                  >
                    <span>Reasoning</span>
                    <span>{effortLabel(reasoningEffort)}</span>
                    <ChevronRight size={16} />
                  </button>
                  {agentConfig.filter((option) => option.category !== 'model' && option.category !== 'thought_level').map((option) => (
                    <button className="composer-picker-row" type="button" key={option.id} onClick={() => setModelPickerPage('config:' + option.id)}>
                      <span>{option.name}</span><span>{option.options.find((value) => value.value === option.currentValue)?.name}</span><ChevronRight size={16} />
                    </button>
                  ))}
                  {providerId === 'codex' && <><div className="composer-picker-separator" />
                  <button
                    className="composer-picker-row reset"
                    type="button"
                    disabled={models.length === 0}
                    onClick={() => {
                      onModelChange(undefined)
                      onEffortChange(undefined)
                      setModelPickerPage(undefined)
                    }}
                  >
                    <span>Reset to default</span>
                    <RotateCcw size={15} />
                  </button></>}
                </>
              )}

              {modelPickerPage.startsWith('config:') && agentConfig.filter((option) => 'config:' + option.id === modelPickerPage).map((option) => (
                <div key={option.id}>
                  <header className="composer-picker-header"><button type="button" aria-label="Back" onClick={() => setModelPickerPage('root')}><ChevronLeft size={16} /></button><strong>{option.name}</strong></header>
                  <div className="composer-picker-options">{option.options.map((value) => <button type="button" key={value.value} role="menuitemradio"
                    aria-checked={value.value === option.currentValue} title={value.description}
                    onClick={() => { onAgentConfigChange?.(option.id, value.value); setModelPickerPage('root') }}>
                    <span>{value.name}</span>{value.value === option.currentValue && <Check size={15} />}
                  </button>)}</div>
                </div>
              ))}
              {modelPickerPage === 'agent' && (
                <>
                  <header className="composer-picker-header">
                    <button type="button" aria-label="Back" onClick={() => setModelPickerPage('root')}><ChevronLeft size={16} /></button>
                    <span>Agent</span>
                  </header>
                  {selection.agents.map((provider) => <button key={provider.id} className="composer-picker-row" type="button"
                    role="menuitemradio" aria-checked={provider.id === providerId} disabled={providerLocked}
                    onClick={() => { onProviderChange?.(provider.id); setModelPickerPage(undefined) }}>
                    <span>{provider.label}</span>
                    {provider.id === providerId && <Check size={14} />}
                  </button>)}
                </>
              )}

              {modelPickerPage === 'model' && (
                <>
                  <header className="composer-picker-header">
                    <button type="button" aria-label="Back" onClick={() => setModelPickerPage('root')}>
                      <ChevronLeft size={17} />
                    </button>
                    <strong>Model</strong>
                  </header>
                  <div className="composer-picker-options">
                    {onModelsRequest && modelsLoading && <p role="status">Loading models…</p>}
                    {onModelsRequest && modelsError && <>
                      <p role="alert">{modelsError}</p>
                      <button type="button" disabled={modelsLoading} onClick={() => { void requestModels() }}>Retry</button>
                    </>}
                    {models.map((option) => {
                      const selected = option.id === selectedModel?.id
                      return (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          key={option.id}
                          onClick={() => {
                            onModelChange(option.id)
                            setModelPickerPage('root')
                          }}
                        >
                          <span>{option.displayName}</span>
                          {selected && <Check size={15} />}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}

              {modelPickerPage === 'effort' && (
                <>
                  <header className="composer-picker-header">
                    <button type="button" aria-label="Back" onClick={() => setModelPickerPage('root')}>
                      <ChevronLeft size={17} />
                    </button>
                    <strong>Reasoning</strong>
                  </header>
                  <div className="composer-picker-options">
                    {reasoningOptions.map((option) => {
                      const selected = option.reasoningEffort === reasoningEffort
                      return (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          key={option.reasoningEffort}
                          onClick={() => {
                            onEffortChange(option.reasoningEffort)
                            setModelPickerPage('root')
                          }}
                        >
                          <span>{effortLabel(option.reasoningEffort)}</span>
                          {selected && <Check size={15} />}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {activeTurn && (!allowSubmitDuringTurn || !canSend) ? (
          <button
            className="send-button stop"
            type="button"
            aria-label="Interrupt turn"
            title="Interrupt turn"
            onClick={() => onInterrupt()}
          >
            <span className="stop-glyph" aria-hidden="true" />
          </button>
        ) : (
          <button
            className="send-button"
            type="button"
            data-hotkey="↵"
            title={sendLabel ?? (activeTurn ? 'Queue message' : 'Send')}
            aria-label={sendLabel ?? (activeTurn ? 'Queue message' : 'Send')}
            disabled={disabled || !canSend || sending}
            onClick={() => submit()}
          >
            <ArrowUp size={16} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </footer>
  )
}
