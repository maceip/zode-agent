import { registerCustomCSSVariableTheme } from '@pierre/diffs'

export const ALTO_SHARED_CODE_THEMES = {
  light: 'alto-shared-code-light-v1',
  dark: 'alto-shared-code-dark-v1',
} as const

const lightFallbackColors = {
  foreground: '#4d536b',
  background: '#e5e6ec',
  comment: '#a4a5ae',
  string: '#18876e',
  constant: '#b56418',
  keyword: '#c023b6',
  parameter: '#4d536b',
  function: '#326df0',
  'string-expression': '#18876e',
  punctuation: '#51576e',
  link: '#b83486',
  inserted: '#277e31',
  deleted: '#a84354',
  changed: '#b83486',
} as const

const darkFallbackColors = {
  foreground: '#d2d6e2',
  background: '#262931',
  comment: '#858c9d',
  string: '#72c8a7',
  constant: '#e4ad6d',
  keyword: '#e879dc',
  parameter: '#d2d6e2',
  function: '#76a7ff',
  'string-expression': '#72c8a7',
  punctuation: '#aeb5c7',
  link: '#e688be',
  inserted: '#86cba5',
  deleted: '#f095a2',
  changed: '#e688be',
} as const

export function ensureAltoSharedCodeTheme(): void {
  // Each client fiber is bundled independently and owns its Pierre registry.
  // Register in every bundle; Pierre safely ignores a duplicate in one registry.
  registerCustomCSSVariableTheme(
    ALTO_SHARED_CODE_THEMES.light,
    lightFallbackColors,
    true,
  )
  registerCustomCSSVariableTheme(
    ALTO_SHARED_CODE_THEMES.dark,
    darkFallbackColors,
    true,
  )
}
