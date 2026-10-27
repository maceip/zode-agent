import type {
  UiAction,
  UiContribution,
  UiNode,
  UiShell,
  UiShellNode,
  UiShellRegion,
  UiSurface,
} from '../../shared/protocol.js'

const UI_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const UI_TONES = ['default', 'muted', 'accent', 'success', 'warning', 'danger'] as const
const UI_TONE_SET = new Set<string>(UI_TONES)
const SPACING = ['none', 'xs', 'sm', 'md', 'lg', 'xl'] as const

function assertText(value: unknown, field: string, maximum = 10_000): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`${field} must be a string no longer than ${maximum} characters`)
  }
}

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UI_ID.test(value)) {
    throw new Error(`${field} must match ${UI_ID}`)
  }
}

function optionalEnum(value: unknown, allowed: readonly string[], field: string): void {
  if (value !== undefined && !allowed.includes(String(value))) {
    throw new Error(`${field} must be one of ${allowed.join(', ')}`)
  }
}

function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`)
  }
}

function validateNodes(nodes: unknown, depth = 0): asserts nodes is UiNode[] {
  if (!Array.isArray(nodes)) throw new Error('UI nodes must be an array')
  if (depth > 8) throw new Error('UI nodes may be nested at most eight levels deep')
  if (nodes.length > 100) throw new Error('a UI node list may contain at most 100 items')

  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !('type' in node)) {
      throw new Error('each UI node needs a type')
    }
    const candidate = node as Record<string, unknown>
    switch (candidate.type) {
      case 'text':
        assertText(candidate.text, 'text')
        break
      case 'metric':
        assertText(candidate.label, 'metric label', 200)
        assertText(candidate.value, 'metric value', 2_000)
        break
      case 'list':
        validateList(candidate)
        break
      case 'input':
        validateInput(candidate)
        break
      case 'button':
        assertId(candidate.action, 'button action')
        assertText(candidate.label, 'button label', 200)
        if (
          candidate.variant !== undefined
          && !['primary', 'secondary', 'danger'].includes(String(candidate.variant))
        ) {
          throw new Error('button variant must be primary, secondary, or danger')
        }
        break
      case 'row':
      case 'group':
        if (candidate.title !== undefined) assertText(candidate.title, 'group title', 200)
        validateNodes(candidate.children, depth + 1)
        break
      default:
        throw new Error(`unknown UI node type: ${String(candidate.type)}`)
    }
    if (candidate.tone !== undefined && !UI_TONE_SET.has(String(candidate.tone))) {
      throw new Error(`unknown UI tone: ${String(candidate.tone)}`)
    }
  }
}

function validateList(candidate: Record<string, unknown>): void {
  if (!Array.isArray(candidate.items) || candidate.items.length > 200) {
    throw new Error('list items must be an array of at most 200 items')
  }
  for (const item of candidate.items) {
    if (!item || typeof item !== 'object') throw new Error('list items must be objects')
    const entry = item as Record<string, unknown>
    assertText(entry.label, 'list item label', 2_000)
    if (entry.detail !== undefined) assertText(entry.detail, 'list item detail', 10_000)
    if (entry.id !== undefined) assertId(entry.id, 'list item id')
  }
  if (candidate.empty !== undefined) assertText(candidate.empty, 'list empty text', 2_000)
}

function validateInput(candidate: Record<string, unknown>): void {
  assertId(candidate.id, 'input id')
  if (candidate.label !== undefined) assertText(candidate.label, 'input label', 200)
  if (candidate.placeholder !== undefined) assertText(candidate.placeholder, 'input placeholder', 500)
  if (candidate.value !== undefined) assertText(candidate.value, 'input value', 10_000)
  if (
    candidate.inputType !== undefined
    && !['text', 'number', 'password'].includes(String(candidate.inputType))
  ) {
    throw new Error('inputType must be text, number, or password')
  }
}

interface ShellBudget {
  count: number
  builtins: Set<string>
  contributions: Set<string>
  surfaces: Set<string>
  slots: Set<string>
  outlets: Set<string>
}

function validateShellNode(
  value: unknown,
  budget: ShellBudget,
  depth = 0,
  allowOutlets = true,
): asserts value is UiShellNode {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new Error('each shell node needs a type')
  }
  if (depth > 12) throw new Error('shell nodes may be nested at most twelve levels deep')
  if (++budget.count > 300) throw new Error('a shell may contain at most 300 nodes')

  const node = value as Record<string, unknown>
  switch (node.type) {
    case 'box':
      validateBox(node, budget, depth, allowOutlets)
      break
    case 'builtin':
      validateBuiltin(node, budget)
      break
    case 'surface':
      assertId(node.id, 'surface id')
      if (budget.surfaces.has(node.id)) {
        throw new Error(`surface "${String(node.id)}" may appear only once`)
      }
      budget.surfaces.add(String(node.id))
      break
    case 'contribution':
      assertId(node.id, 'contribution id')
      if (budget.contributions.has(node.id)) {
        throw new Error(`contribution "${String(node.id)}" may appear only once`)
      }
      budget.contributions.add(String(node.id))
      optionalEnum(node.presentation, ['cards', 'plain', 'inline'], 'contribution presentation')
      break
    case 'slot':
      validateSlot(node, budget)
      break
    case 'outlet':
      if (!allowOutlets) throw new Error('shell regions may not contain nested outlets')
      assertId(node.name, 'outlet name')
      if (budget.outlets.has(String(node.name))) {
        throw new Error(`outlet "${String(node.name)}" may appear only once`)
      }
      budget.outlets.add(String(node.name))
      if (node.fallback !== undefined) {
        validateShellNode(node.fallback, budget, depth + 1, false)
      }
      break
    case 'label':
      assertText(node.text, 'shell label', 2_000)
      optionalEnum(node.tone, UI_TONES, 'shell label tone')
      optionalEnum(node.style, ['body', 'caption', 'title'], 'shell label style')
      break
    case 'spacer':
      break
    default:
      throw new Error(`unknown shell node type: ${String(node.type)}`)
  }
}

function validateBox(
  node: Record<string, unknown>,
  budget: ShellBudget,
  depth: number,
  allowOutlets: boolean,
): void {
  if (node.id !== undefined) assertId(node.id, 'shell box id')
  optionalEnum(node.role, ['header', 'main', 'aside', 'footer', 'section'], 'box role')
  optionalEnum(node.direction, ['row', 'column'], 'box direction')
  optionalEnum(node.align, ['start', 'center', 'end', 'stretch'], 'box alignment')
  optionalEnum(node.justify, ['start', 'center', 'end', 'between'], 'box justification')
  optionalEnum(node.gap, SPACING, 'box gap')
  optionalEnum(node.padding, SPACING, 'box padding')
  optionalEnum(node.surface, ['none', 'canvas', 'panel', 'raised', 'accent'], 'box surface')
  optionalEnum(node.border, ['none', 'soft', 'strong'], 'box border')
  optionalEnum(node.radius, ['none', 'sm', 'md', 'lg', 'round'], 'box radius')
  optionalEnum(node.shadow, ['none', 'soft', 'panel'], 'box shadow')
  optionalEnum(node.width, ['content', 'compact', 'narrow', 'medium', 'wide', 'half', 'full'], 'box width')
  optionalEnum(node.scroll, ['none', 'x', 'y', 'both'], 'box scroll')
  optionalEnum(node.responsive, ['none', 'stack'], 'box responsive behavior')
  optionalBoolean(node.grow, 'box grow')
  optionalBoolean(node.wrap, 'box wrap')
  if (!Array.isArray(node.children) || node.children.length > 100) {
    throw new Error('box children must be an array of at most 100 nodes')
  }
  for (const child of node.children) {
    validateShellNode(child, budget, depth + 1, allowOutlets)
  }
}

function validateBuiltin(node: Record<string, unknown>, budget: ShellBudget): void {
  const name = String(node.name)
  optionalEnum(name, ['brand', 'status', 'history', 'search', 'conversation', 'scrollback', 'steer', 'composer', 'settings', 'plugins', 'new-thread', 'new-workspace'], 'builtin name')
  if (budget.builtins.has(name)) throw new Error(`builtin "${name}" may appear only once`)
  budget.builtins.add(name)
  if (node.label !== undefined) assertText(node.label, 'builtin label', 200)
  optionalEnum(node.appearance, ['icon', 'text', 'full'], 'builtin appearance')
}

function validateSlot(node: Record<string, unknown>, budget: ShellBudget): void {
  assertId(node.name, 'slot name')
  if (budget.slots.has(node.name)) throw new Error(`slot "${node.name}" may appear only once`)
  budget.slots.add(node.name)
  if (node.title !== undefined) assertText(node.title, 'slot title', 200)
  if (node.empty !== undefined) assertText(node.empty, 'slot empty text', 2_000)
  optionalEnum(node.presentation, ['cards', 'plain', 'inline'], 'slot presentation')
  optionalEnum(node.direction, ['row', 'column'], 'slot direction')
  optionalEnum(node.gap, SPACING, 'slot gap')
  optionalEnum(node.scroll, ['none', 'x', 'y', 'both'], 'slot scroll')
  optionalBoolean(node.grow, 'slot grow')
}

export function normalizeShell(value: UiShell): UiShell {
  const shell = structuredClone(value)
  assertId(shell.id, 'shell id')
  if (shell.root.type !== 'box') throw new Error('the shell root must be a box')
  validateShellNode(shell.root, {
    count: 0,
    builtins: new Set(),
    contributions: new Set(),
    surfaces: new Set(),
    slots: new Set(),
    outlets: new Set(),
  })

  if (shell.theme) {
    const colorFields = [
      'accent',
      'accentText',
      'background',
      'canvas',
      'panel',
      'text',
      'textStrong',
      'muted',
      'border',
    ] as const
    const hexadecimal = /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i
    for (const field of colorFields) {
      const color = shell.theme[field]
      if (color !== undefined && !hexadecimal.test(color)) {
        throw new Error(`theme ${field} must be a hexadecimal color`)
      }
    }
    optionalEnum(shell.theme.font, ['system', 'rounded', 'serif', 'mono'], 'theme font')
    optionalEnum(shell.theme.density, ['compact', 'comfortable', 'spacious'], 'theme density')
    optionalEnum(shell.theme.corners, ['square', 'soft', 'round'], 'theme corners')
  }

  if (JSON.stringify(shell).length > 200_000) throw new Error('a UI shell may be at most 200 KB')
  return shell
}

export function normalizeShellRegion(value: UiShellRegion): UiShellRegion {
  const region = structuredClone(value)
  assertId(region.id, 'shell region id')
  assertId(region.outlet, 'shell region outlet')
  if (region.root.type !== 'box') throw new Error('a shell region root must be a box')
  validateShellNode(region.root, {
    count: 0,
    builtins: new Set(),
    contributions: new Set(),
    surfaces: new Set(),
    slots: new Set(),
    outlets: new Set(),
  }, 0, false)
  if (JSON.stringify(region).length > 200_000) {
    throw new Error('a shell region may be at most 200 KB')
  }
  return region
}

export function normalizeContribution(value: UiContribution): UiContribution {
  const contribution = structuredClone(value)
  assertId(contribution.id, 'contribution id')
  if (contribution.title !== undefined) assertText(contribution.title, 'contribution title', 200)
  if (contribution.description !== undefined) {
    assertText(contribution.description, 'contribution description', 2_000)
  }
  if (contribution.slot !== undefined) assertId(contribution.slot, 'contribution slot')
  if (contribution.order !== undefined && !Number.isFinite(contribution.order)) {
    throw new Error('contribution order must be a finite number')
  }
  validateNodes(contribution.nodes)
  if (JSON.stringify(contribution).length > 100_000) {
    throw new Error('a UI contribution may be at most 100 KB')
  }
  return contribution
}

export function normalizeSurface(value: UiSurface): UiSurface {
  const surface = structuredClone(value)
  assertId(surface.id, 'surface id')
  assertId(surface.kind, 'surface kind')
  if (surface.label !== undefined) assertText(surface.label, 'surface label', 200)
  optionalEnum(surface.appearance, ['icon', 'text', 'full'], 'surface appearance')

  if (surface.kind === 'history') {
    if (
      surface.limit !== undefined
      && (!Number.isSafeInteger(surface.limit) || surface.limit < 1 || surface.limit > 200)
    ) throw new Error('history surface limit must be an integer from 1 to 200')
    optionalBoolean(surface.showAge, 'history surface showAge')
    if (surface.emptyText !== undefined) assertText(surface.emptyText, 'history empty text', 500)
  }
  if (surface.kind === 'conversation') {
    optionalEnum(surface.emptyState, ['none', 'orbit'], 'conversation empty state')
    optionalBoolean(surface.markdown, 'conversation markdown')
  }
  if (surface.kind === 'composer') {
    if (surface.placeholder !== undefined) assertText(surface.placeholder, 'composer placeholder', 500)
    if (
      surface.focusHeight !== undefined
      && (!Number.isFinite(surface.focusHeight) || surface.focusHeight < 54 || surface.focusHeight > 240)
    ) throw new Error('composer focusHeight must be between 54 and 240')
    if (
      surface.maxHeight !== undefined
      && (!Number.isFinite(surface.maxHeight) || surface.maxHeight < 80 || surface.maxHeight > 500)
    ) throw new Error('composer maxHeight must be between 80 and 500')
    if (surface.capabilities !== undefined) {
      if (!Array.isArray(surface.capabilities)) {
        throw new Error('composer capabilities must be an array')
      }
      const capabilities = new Set<string>()
      for (const capability of surface.capabilities) {
        optionalEnum(capability, ['skills', 'markdown', 'images', 'files'], 'composer capability')
        if (capabilities.has(capability)) {
          throw new Error(`composer capability "${capability}" may appear only once`)
        }
        capabilities.add(capability)
      }
    }
  }
  if (surface.kind === 'search') {
    if (surface.placeholder !== undefined) assertText(surface.placeholder, 'search placeholder', 500)
    if (
      surface.limit !== undefined
      && (!Number.isSafeInteger(surface.limit) || surface.limit < 1 || surface.limit > 50)
    ) throw new Error('search surface limit must be an integer from 1 to 50')
  }
  if (JSON.stringify(surface).length > 100_000) {
    throw new Error('a UI surface may be at most 100 KB')
  }
  return surface
}

export function normalizeAction(value: UiAction): UiAction {
  const action = structuredClone(value)
  assertId(action.actionId, 'action id')
  if (!action.values || typeof action.values !== 'object' || Array.isArray(action.values)) {
    throw new Error('UI action values must be an object')
  }
  for (const [key, entry] of Object.entries(action.values)) {
    assertId(key, 'UI value id')
    assertText(entry, `UI value ${key}`, 10_000)
  }
  return action
}
