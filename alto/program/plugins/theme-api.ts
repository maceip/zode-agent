export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedThemeMode = Exclude<ThemeMode, 'system'>
export type ChromeTheme = 'alto' | 'paper' | 'graphite' | 'ink'
export type CodeTheme = 'alto' | 'github' | 'nord' | 'muted'

export interface ThemePreference {
  mode: ThemeMode
  accent: string
  chrome: ChromeTheme
  code: CodeTheme
}

export interface ThemeConfig {
  defaultMode?: ThemeMode
  defaultAccent?: string
  defaultChrome?: ChromeTheme
  defaultCode?: CodeTheme
}

export const THEME_STORAGE_KEY = 'alto.theme.v1'
export const DEFAULT_THEME: Readonly<ThemePreference> = {
  mode: 'light',
  accent: '#7c3aed',
  chrome: 'alto',
  code: 'alto',
}

const hexColor = /^#[0-9a-f]{6}$/i
const chromeThemes = new Set<ChromeTheme>(['alto', 'paper', 'graphite', 'ink'])
const codeThemes = new Set<CodeTheme>(['alto', 'github', 'nord', 'muted'])

export function normalizeAccent(value: unknown, fallback = DEFAULT_THEME.accent): string {
  return typeof value === 'string' && hexColor.test(value.trim())
    ? value.trim().toLocaleLowerCase()
    : fallback
}

export function normalizeChromeTheme(
  value: unknown,
  fallback: ChromeTheme = DEFAULT_THEME.chrome,
): ChromeTheme {
  return typeof value === 'string' && chromeThemes.has(value as ChromeTheme)
    ? value as ChromeTheme
    : fallback
}

export function normalizeCodeTheme(
  value: unknown,
  fallback: CodeTheme = DEFAULT_THEME.code,
): CodeTheme {
  return typeof value === 'string' && codeThemes.has(value as CodeTheme)
    ? value as CodeTheme
    : fallback
}

export function themeDefaults(config: ThemeConfig = {}): ThemePreference {
  return {
    mode: config.defaultMode === 'dark' || config.defaultMode === 'system'
      ? config.defaultMode
      : 'light',
    accent: normalizeAccent(config.defaultAccent),
    chrome: normalizeChromeTheme(config.defaultChrome),
    code: normalizeCodeTheme(config.defaultCode),
  }
}

export function parseThemePreference(
  value: unknown,
  defaults: ThemePreference = DEFAULT_THEME,
): ThemePreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults }
  const candidate = value as Partial<ThemePreference>
  return {
    mode: candidate.mode === 'light' || candidate.mode === 'dark' || candidate.mode === 'system'
      ? candidate.mode
      : defaults.mode,
    accent: normalizeAccent(candidate.accent, defaults.accent),
    chrome: normalizeChromeTheme(candidate.chrome, defaults.chrome),
    code: normalizeCodeTheme(candidate.code, defaults.code),
  }
}

export function resolveThemeMode(mode: ThemeMode, systemDark: boolean): ResolvedThemeMode {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
}
