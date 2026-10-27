import { describe, expect, it } from 'vitest'
import type { UiAction, UiShell } from '../src/shared/protocol.js'
import {
  normalizeAction,
  normalizeShell,
  normalizeShellRegion,
  normalizeSurface,
} from '../src/server/services/ui-language.js'

const minimalShell: UiShell = {
  id: 'test-shell',
  root: {
    type: 'box',
    children: [
      { type: 'builtin', name: 'history' },
      { type: 'builtin', name: 'conversation' },
      { type: 'slot', name: 'main' },
    ],
  },
}

describe('UI language boundary', () => {
  it('validates and clones shell programs', () => {
    const normalized = normalizeShell(minimalShell)
    expect(normalized).toEqual(minimalShell)
    expect(normalized).not.toBe(minimalShell)
  })

  it('rejects a shell that renders a builtin twice', () => {
    expect(() => normalizeShell({
      id: 'duplicate-shell',
      root: {
        type: 'box',
        children: [
          { type: 'builtin', name: 'composer' },
          { type: 'builtin', name: 'composer' },
        ],
      },
    })).toThrow('builtin "composer" may appear only once')
  })

  it('allows a shell to remove every optional builtin', () => {
    expect(normalizeShell({
      id: 'blank-shell',
      root: {
        type: 'box',
        children: [{ type: 'label', text: 'Blank canvas' }],
      },
    }).root).toEqual({
      type: 'box',
      children: [{ type: 'label', text: 'Blank canvas' }],
    })
  })

  it('accepts the kernel-backed plugins control as a programmable surface', () => {
    expect(normalizeSurface({
      id: 'default-plugins',
      kind: 'plugins',
      label: 'Plugins',
      appearance: 'icon',
    })).toEqual({
      id: 'default-plugins',
      kind: 'plugins',
      label: 'Plugins',
      appearance: 'icon',
    })
  })

  it('accepts workspace creation as a programmable surface', () => {
    expect(normalizeSurface({
      id: 'default-new-workspace',
      kind: 'new-workspace',
      label: 'New workspace',
      appearance: 'full',
    })).toEqual({
      id: 'default-new-workspace',
      kind: 'new-workspace',
      label: 'New workspace',
      appearance: 'full',
    })
  })

  it('accepts a plugin-owned steer queue surface', () => {
    expect(normalizeSurface({
      id: 'default-steer',
      kind: 'steer',
    })).toEqual({
      id: 'default-steer',
      kind: 'steer',
    })
  })

  it('accepts a plugin-owned conversation scrollback surface', () => {
    expect(normalizeSurface({
      id: 'default-scrollback',
      kind: 'scrollback',
      label: 'Conversation scrollback',
    })).toEqual({
      id: 'default-scrollback',
      kind: 'scrollback',
      label: 'Conversation scrollback',
    })
  })

  it('validates the programmable search surface', () => {
    expect(normalizeSurface({
      id: 'default-search',
      kind: 'search',
      label: 'Search',
      appearance: 'full',
      placeholder: 'Search conversations and actions…',
      limit: 10,
    })).toEqual({
      id: 'default-search',
      kind: 'search',
      label: 'Search',
      appearance: 'full',
      placeholder: 'Search conversations and actions…',
      limit: 10,
    })
    expect(() => normalizeSurface({
      id: 'default-search',
      kind: 'search',
      limit: 0,
    })).toThrow('search surface limit must be an integer from 1 to 50')
  })

  it('accepts compact inline slots for toolbar widgets', () => {
    expect(normalizeShell({
      id: 'toolbar-shell',
      root: {
        type: 'box',
        children: [{
          type: 'slot',
          name: 'header-right',
          presentation: 'inline',
          direction: 'row',
        }],
      },
    }).root).toMatchObject({
      children: [{ presentation: 'inline' }],
    })
  })

  it('accepts an exclusive outlet for a plugin-owned shell region', () => {
    expect(normalizeShell({
      id: 'outlet-shell',
      root: {
        type: 'box',
        direction: 'row',
        children: [
          { type: 'outlet', name: 'sidebar' },
          { type: 'builtin', name: 'conversation' },
        ],
      },
    }).root).toMatchObject({
      children: [{ type: 'outlet', name: 'sidebar' }, { type: 'builtin' }],
    })

    expect(normalizeShellRegion({
      id: 'custom-sidebar',
      outlet: 'sidebar',
      root: {
        type: 'box',
        role: 'aside',
        children: [{ type: 'builtin', name: 'history' }],
      },
    })).toMatchObject({
      id: 'custom-sidebar',
      outlet: 'sidebar',
      root: { role: 'aside' },
    })
  })

  it('keeps shell regions finite by rejecting nested outlets', () => {
    expect(() => normalizeShellRegion({
      id: 'recursive-sidebar',
      outlet: 'sidebar',
      root: {
        type: 'box',
        children: [{ type: 'outlet', name: 'sidebar' }],
      },
    })).toThrow('shell regions may not contain nested outlets')
  })

  it('allows a contribution to be placed directly anywhere in the shell', () => {
    expect(normalizeShell({
      id: 'direct-shell',
      root: {
        type: 'box',
        role: 'header',
        children: [{
          type: 'contribution',
          id: 'git-widget',
          presentation: 'inline',
        }],
      },
    }).root).toMatchObject({
      children: [{
        type: 'contribution',
        id: 'git-widget',
        presentation: 'inline',
      }],
    })
  })

  it('validates programmable surface behavior', () => {
    expect(normalizeSurface({
      id: 'default-composer',
      kind: 'composer',
      placeholder: 'Ask anything',
      focusHeight: 96,
      maxHeight: 240,
      capabilities: ['skills', 'markdown', 'images'],
    })).toEqual({
      id: 'default-composer',
      kind: 'composer',
      placeholder: 'Ask anything',
      focusHeight: 96,
      maxHeight: 240,
      capabilities: ['skills', 'markdown', 'images'],
    })
    expect(() => normalizeSurface({
      id: 'default-composer',
      kind: 'composer',
      maxHeight: 20,
    })).toThrow('composer maxHeight must be between 80 and 500')
    expect(() => normalizeSurface({
      id: 'default-composer',
      kind: 'composer',
      capabilities: ['images', 'images'],
    })).toThrow('composer capability "images" may appear only once')
  })

  it('validates action values before they cross into a plugin', () => {
    const malformed = {
      contributionId: 'test-panel',
      actionId: 'save',
      values: { message: 42 },
    } as unknown as UiAction
    expect(() => normalizeAction(malformed)).toThrow(
      'UI value message must be a string no longer than 10000 characters',
    )
  })
})
