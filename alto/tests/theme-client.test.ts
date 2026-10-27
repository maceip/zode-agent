import { describe, expect, it, vi } from 'vitest'
import { ThemeController } from '../program/plugins/theme.client.js'
import { parseThemeAppearanceSignature } from '../program/plugins/theme-runtime.js'

describe('theme client lifecycle', () => {
  it('parses the resolved appearance shared with plugin-owned renderers', () => {
    expect(parseThemeAppearanceSignature('dark|#2563eb')).toEqual({
      mode: 'dark',
      accent: '#2563eb',
    })
    expect(parseThemeAppearanceSignature('unknown|invalid')).toEqual({
      mode: 'light',
      accent: '#7c3aed',
    })
  })

  it('publishes stable snapshots and removes every override when unloaded', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const properties = new Map<string, string>()
    const listeners = new Set<() => void>()
    const media = {
      matches: false,
      addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener),
    }
    const storage = new Map<string, string>()
    const root = {
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        matchMedia: () => media,
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { documentElement: root },
    })

    try {
      const controller = new ThemeController()
      expect(controller.snapshot()).toBe(controller.snapshot())
      const changed = vi.fn()
      controller.subscribe(changed)
      const deactivate = controller.activate()

      expect(root.dataset).toEqual({
        altoThemePlugin: 'active',
        altoTheme: 'light',
        altoChromeTheme: 'alto',
        altoCodeTheme: 'alto',
      })
      expect(properties.get('--alto-theme-accent')).toBe('#7c3aed')

      const previous = controller.snapshot()
      controller.setMode('dark')
      controller.setChrome('ink')
      controller.setCode('nord')
      controller.setAccent('#2563eb')
      expect(controller.snapshot()).not.toBe(previous)
      expect(controller.snapshot()).toMatchObject({
        mode: 'dark',
        accent: '#2563eb',
        chrome: 'ink',
        code: 'nord',
      })
      expect(root.dataset.altoTheme).toBe('dark')
      expect(root.dataset.altoChromeTheme).toBe('ink')
      expect(root.dataset.altoCodeTheme).toBe('nord')
      expect(properties.get('--alto-theme-accent')).toBe('#2563eb')
      expect(changed).toHaveBeenCalledTimes(4)

      deactivate()
      expect(root.dataset).toEqual({})
      expect(properties.has('--alto-theme-accent')).toBe(false)
      expect(listeners.size).toBe(0)
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else delete (globalThis as { document?: Document }).document
    }
  })
})
