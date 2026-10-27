import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME,
  normalizeAccent,
  normalizeChromeTheme,
  normalizeCodeTheme,
  parseThemePreference,
  resolveThemeMode,
  themeDefaults,
} from '../program/plugins/theme-api.js'

describe('theme preferences', () => {
  it('keeps Alto\'s existing light palette as the default', () => {
    expect(DEFAULT_THEME).toEqual({
      mode: 'light',
      accent: '#7c3aed',
      chrome: 'alto',
      code: 'alto',
    })
    expect(themeDefaults()).toEqual(DEFAULT_THEME)
  })

  it('validates stored modes and six-digit accent colors', () => {
    expect(parseThemePreference({ mode: 'dark', accent: '#AABBCC' })).toEqual({
      mode: 'dark',
      accent: '#aabbcc',
      chrome: 'alto',
      code: 'alto',
    })
    expect(parseThemePreference({ mode: 'sepia', accent: 'purple' })).toEqual(DEFAULT_THEME)
    expect(normalizeAccent('#123456')).toBe('#123456')
    expect(normalizeAccent('#123')).toBe(DEFAULT_THEME.accent)
    expect(normalizeChromeTheme('paper')).toBe('paper')
    expect(normalizeChromeTheme('graphite')).toBe('graphite')
    expect(normalizeChromeTheme('blue')).toBe('alto')
    expect(normalizeCodeTheme('github')).toBe('github')
    expect(normalizeCodeTheme('nord')).toBe('nord')
    expect(normalizeCodeTheme('dracula')).toBe('alto')
  })

  it('keeps stored mode and accent preferences while adding palette defaults', () => {
    expect(parseThemePreference({
      mode: 'system',
      accent: '#336699',
      chrome: 'ink',
      code: 'muted',
    })).toEqual({
      mode: 'system',
      accent: '#336699',
      chrome: 'ink',
      code: 'muted',
    })
  })

  it('resolves system mode without changing explicit choices', () => {
    expect(resolveThemeMode('system', true)).toBe('dark')
    expect(resolveThemeMode('system', false)).toBe('light')
    expect(resolveThemeMode('light', true)).toBe('light')
    expect(resolveThemeMode('dark', false)).toBe('dark')
  })
})
