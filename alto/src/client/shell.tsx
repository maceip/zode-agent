import type { CSSProperties, ReactNode } from 'react'
import type {
  UiShellBuiltin,
  UiShellNode,
  UiTheme,
} from '../shared/protocol.js'

export type ShellBox = Extract<UiShellNode, { type: 'box' }>
export type ShellSlot = Extract<UiShellNode, { type: 'slot' }>
export type ShellBuiltin = Extract<UiShellNode, { type: 'builtin' }>
export type ShellContribution = Extract<UiShellNode, { type: 'contribution' }>
export type ShellOutlet = Extract<UiShellNode, { type: 'outlet' }>
export type ShellSurface = Extract<UiShellNode, { type: 'surface' }>

export function themeStyle(theme: UiTheme | undefined): CSSProperties {
  if (!theme) return {}
  return {
    ...(theme.accent ? { '--accent': theme.accent } : {}),
    ...(theme.accentText ? { '--accent-text': theme.accentText } : {}),
    ...(theme.background ? { '--bg': theme.background } : {}),
    ...(theme.canvas ? { '--canvas': theme.canvas } : {}),
    ...(theme.panel ? { '--panel': theme.panel, '--panel-solid': theme.panel } : {}),
    ...(theme.text ? { '--text': theme.text } : {}),
    ...(theme.textStrong ? { '--text-strong': theme.textStrong } : {}),
    ...(theme.muted ? { '--muted': theme.muted } : {}),
    ...(theme.border ? { '--border': theme.border, '--border-soft': theme.border } : {}),
  } as CSSProperties
}

function boxClass(node: ShellBox): string {
  return [
    'shell-box',
    `shell-direction-${node.direction ?? 'column'}`,
    `shell-align-${node.align ?? 'stretch'}`,
    `shell-justify-${node.justify ?? 'start'}`,
    `shell-gap-${node.gap ?? 'none'}`,
    `shell-padding-${node.padding ?? 'none'}`,
    `shell-surface-${node.surface ?? 'none'}`,
    `shell-border-${node.border ?? 'none'}`,
    `shell-radius-${node.radius ?? 'none'}`,
    `shell-shadow-${node.shadow ?? 'none'}`,
    `shell-width-${node.width ?? 'auto'}`,
    `shell-scroll-${node.scroll ?? 'none'}`,
    node.grow && 'shell-grow',
    node.wrap && 'shell-wrap',
    node.responsive === 'stack' && 'shell-responsive-stack',
  ].filter(Boolean).join(' ')
}

export function slotClass(node: ShellSlot): string {
  return [
    'shell-slot',
    `shell-slot-${node.presentation ?? 'cards'}`,
    `shell-direction-${node.direction ?? 'column'}`,
    `shell-gap-${node.gap ?? 'none'}`,
    `shell-scroll-${node.scroll ?? 'none'}`,
    node.grow && 'shell-grow',
  ].filter(Boolean).join(' ')
}

export function contributionIds(
  node: UiShellNode,
  result: Set<string> = new Set(),
  occupiedOutlets: ReadonlySet<string> = new Set(),
): Set<string> {
  if (node.type === 'contribution') result.add(node.id)
  if (node.type === 'box') {
    for (const child of node.children) contributionIds(child, result, occupiedOutlets)
  }
  if (node.type === 'outlet' && node.fallback && !occupiedOutlets.has(node.name)) {
    contributionIds(node.fallback, result, occupiedOutlets)
  }
  return result
}

export function outletNames(
  node: UiShellNode,
  result: Set<string> = new Set(),
): Set<string> {
  if (node.type === 'outlet') result.add(node.name)
  if (node.type === 'box') {
    for (const child of node.children) outletNames(child, result)
  }
  return result
}

export function ShellTree({
  node,
  path = 'root',
  builtin,
  contribution,
  outlet,
  surface,
  slot,
}: {
  node: UiShellNode
  path?: string
  builtin: (node: ShellBuiltin) => ReactNode
  contribution: (node: ShellContribution) => ReactNode
  outlet: (node: ShellOutlet) => ReactNode
  surface: (node: ShellSurface) => ReactNode
  slot: (node: ShellSlot) => ReactNode
}): ReactNode {
  switch (node.type) {
    case 'builtin':
      return builtin(node)
    case 'contribution':
      return contribution(node)
    case 'outlet':
      return outlet(node)
    case 'surface':
      return surface(node)
    case 'slot':
      return slot(node)
    case 'spacer':
      return <div className="shell-spacer" aria-hidden="true" />
    case 'label':
      return (
        <div className={`shell-label shell-label-${node.style ?? 'body'} ui-tone-${node.tone ?? 'default'}`}>
          {node.text}
        </div>
      )
    case 'box': {
      const Element = node.role ?? 'div'
      return (
        <Element className={boxClass(node)} data-shell-node={node.id}>
          {node.children.map((child, index) => (
            <ShellTree
              node={child}
              path={`${path}:${index}`}
              builtin={builtin}
              contribution={contribution}
              outlet={outlet}
              surface={surface}
              slot={slot}
              key={`${path}:${index}`}
            />
          ))}
        </Element>
      )
    }
  }
}
