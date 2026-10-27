import { useSyncExternalStore } from 'react'
import { DEFAULT_THEME, normalizeAccent, type ResolvedThemeMode } from './theme-api.js'

export interface ClientThemeAppearance {
  mode: ResolvedThemeMode
  accent: string
}

const DEFAULT_SIGNATURE = `light|${DEFAULT_THEME.accent}`

export function themeAppearanceSignature(): string {
  if (typeof document === 'undefined') return DEFAULT_SIGNATURE
  const root = document.documentElement
  const mode: ResolvedThemeMode = root.dataset.altoTheme === 'dark' ? 'dark' : 'light'
  const accent = normalizeAccent(
    root.style.getPropertyValue('--alto-theme-accent'),
    DEFAULT_THEME.accent,
  )
  return `${mode}|${accent}`
}

export function parseThemeAppearanceSignature(signature: string): ClientThemeAppearance {
  const [mode, accent] = signature.split('|')
  return {
    mode: mode === 'dark' ? 'dark' : 'light',
    accent: normalizeAccent(accent, DEFAULT_THEME.accent),
  }
}

export function subscribeThemeAppearance(listener: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => undefined
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-alto-theme', 'data-alto-theme-plugin', 'style'],
  })
  return () => observer.disconnect()
}

export function useThemeAppearance(): ClientThemeAppearance {
  const signature = useSyncExternalStore(
    subscribeThemeAppearance,
    themeAppearanceSignature,
    () => DEFAULT_SIGNATURE,
  )
  return parseThemeAppearanceSignature(signature)
}
