import { describe, expect, it, vi } from 'vitest'
import { ClientNativeViews } from '../src/client/native-views.js'
import {
  isHostShortcut,
  isNativeViewModifierInput,
  nativeViewBounds,
  nativeViewUrl,
  type NativeViewKeyInput,
} from '../src/shared/native-views.js'

describe('native browser view boundary', () => {
  it('accepts only web URLs', () => {
    expect(nativeViewUrl('https://example.com/status/'))
      .toBe('https://example.com/status/')
    expect(nativeViewUrl('http://127.0.0.1:4317/')).toBe('http://127.0.0.1:4317/')
    expect(() => nativeViewUrl('file:///etc/passwd')).toThrow('only support http and https')
    expect(() => nativeViewUrl('javascript:alert(1)')).toThrow('only support http and https')
  })

  it('rounds coordinates and prevents negative surface sizes', () => {
    expect(nativeViewBounds({ x: 10.4, y: 20.6, width: -4, height: 300.2 })).toEqual({
      x: 10,
      y: 21,
      width: 0,
      height: 300,
    })
    expect(() => nativeViewBounds({ x: Number.NaN, y: 0, width: 1, height: 1 }))
      .toThrow('must be finite')
  })

  it('routes host shortcuts from a focused native view without forwarding typing', () => {
    const input = (change: Partial<NativeViewKeyInput>): NativeViewKeyInput => ({
      type: 'keydown',
      key: 'a',
      code: 'KeyA',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      ...change,
    })

    expect(isNativeViewModifierInput(input({ key: 'a' }))).toBe(false)
    expect(isNativeViewModifierInput(input({ key: 'Control', code: 'ControlLeft' }))).toBe(true)
    expect(isNativeViewModifierInput(input({ key: 'Escape', code: 'Escape' }))).toBe(true)
    expect(isHostShortcut(input({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toBe(true)
    expect(isHostShortcut(input({ key: 'k', code: 'KeyK', metaKey: true }))).toBe(true)
    expect(isHostShortcut(input({ key: 't', code: 'KeyT', metaKey: true, shiftKey: true }))).toBe(true)
    expect(isHostShortcut(input({ key: 'd', code: 'KeyD', metaKey: true }))).toBe(true)
    expect(isHostShortcut(input({ key: 'd', code: 'KeyD', metaKey: true, shiftKey: true }))).toBe(true)
    expect(isHostShortcut(input({ key: 'f', code: 'KeyF', metaKey: true }))).toBe(true)
    expect(isHostShortcut(input({ key: '1', code: 'Digit1', metaKey: true }))).toBe(true)
    expect(isHostShortcut(input({ key: '9', code: 'Digit9', metaKey: true }))).toBe(true)
    expect(isHostShortcut(input({ key: 'l', code: 'KeyL', altKey: true }))).toBe(true)
    expect(isHostShortcut(input({ key: 'p', code: 'KeyP', metaKey: true, shiftKey: true }))).toBe(true)
    expect(isHostShortcut(input({ key: 'c', code: 'KeyC', metaKey: true }))).toBe(false)
  })

  it('forwards explicit visibility without duplicate bridge calls', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const visible = vi.fn().mockResolvedValue(undefined)
    const action = vi.fn().mockResolvedValue(undefined)
    const focus = vi.fn().mockResolvedValue(undefined)
    const bridge = {
      create: vi.fn().mockResolvedValue({
        id: 'view-1',
        url: 'https://example.com/',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      }),
      navigate: vi.fn(),
      action,
      setBounds: vi.fn().mockResolvedValue(undefined),
      setVisible: visible,
      focus,
      destroy: vi.fn().mockResolvedValue(undefined),
      onState: () => () => undefined,
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __ALTO_DESKTOP__: {
          platform: 'darwin',
          nativeViews: bridge,
        },
      },
    })

    const service = new ClientNativeViews()

    try {
      const view = await service.create({ url: 'https://example.com/' })
      view.setVisible(true)
      view.setVisible(true)
      view.setVisible(false)
      await view.perform('reload')
      view.focus()

      expect(visible.mock.calls.map(([, value]) => value)).toEqual([true, false])
      expect(action).toHaveBeenCalledWith('view-1', 'reload')
      expect(focus).toHaveBeenCalledWith('view-1')
      await view.destroy()

      await service.create({ kind: 'pdf', path: '/tmp/report.pdf' })
      expect(bridge.create).toHaveBeenLastCalledWith({ kind: 'pdf', path: '/tmp/report.pdf' })
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
    }
  })
})
