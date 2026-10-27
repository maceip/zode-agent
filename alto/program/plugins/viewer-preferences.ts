import { useCallback, useState } from 'react'

export type ViewerKind = 'diff' | 'markdown' | 'source'

interface ViewerPreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function preferenceKey(viewer: ViewerKind): string {
  return `alto.viewer.${viewer}.line-wrap`
}

function browserStorage(): ViewerPreferenceStorage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

export function readLineWrapPreference(
  viewer: ViewerKind,
  fallback = false,
  storage = browserStorage(),
): boolean {
  try {
    const stored = storage?.getItem(preferenceKey(viewer))
    return stored === null || stored === undefined ? fallback : stored === 'true'
  } catch {
    return fallback
  }
}

export function writeLineWrapPreference(
  viewer: ViewerKind,
  value: boolean,
  storage = browserStorage(),
): void {
  try {
    storage?.setItem(preferenceKey(viewer), String(value))
  } catch {
    // A blocked storage partition should not prevent the viewer from working.
  }
}

export function useLineWrapPreference(
  viewer: ViewerKind,
  fallback = false,
): readonly [boolean, (value: boolean) => void] {
  const [lineWrap, setLineWrap] = useState(() => readLineWrapPreference(viewer, fallback))
  const update = useCallback((value: boolean): void => {
    writeLineWrapPreference(viewer, value)
    setLineWrap(value)
  }, [viewer])
  return [lineWrap, update]
}
