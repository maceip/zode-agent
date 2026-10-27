import { describe, expect, it, vi } from 'vitest'
import { nativeTerminalInputClaimsHost } from '../src/desktop/native-terminal-manager.js'
import { ClientNativeTerminals } from '../src/client/native-terminals.js'
import { defaultGhosttyConfiguration } from '../program/plugins/ghostty-terminal.client.js'
import {
  nativeTerminalBounds,
  nativeTerminalConfiguration,
  nativeTerminalOptions,
  nativeTerminalOverlay,
} from '../src/shared/native-terminals.js'

describe('native terminal boundary', () => {
  it('builds native terminal palettes from the resolved Alto theme', () => {
    expect(defaultGhosttyConfiguration('light', '#2563eb')).toContain('background = #f2f3f6')
    const dark = defaultGhosttyConfiguration('dark', '#2563eb')
    expect(dark).toContain('background = #1d2027')
    expect(dark).toContain('foreground = #c8ccd8')
    expect(dark).toContain('palette = 5=#2563eb')
  })

  it('does not return focus to the host for a trailing key-up', () => {
    const input = {
      key: 'l',
      code: 'KeyL',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      repeat: false,
    }
    expect(nativeTerminalInputClaimsHost({ ...input, type: 'keydown' })).toBe(true)
    expect(nativeTerminalInputClaimsHost({ ...input, type: 'keyup' })).toBe(false)
  })

  it('normalizes geometry and rejects unsafe options', () => {
    expect(nativeTerminalBounds({ x: 1.4, y: 2.6, width: -2, height: 300.2 })).toEqual({
      x: 1,
      y: 3,
      width: 0,
      height: 300,
    })
    expect(nativeTerminalOptions({
      workingDirectory: ' /repo ',
      command: ' zsh ',
      configuration: ' background = #fff ',
      bounds: { x: 1.4, y: 2.6, width: 400.2, height: 300.8 },
    })).toEqual({
      workingDirectory: '/repo',
      command: 'zsh',
      configuration: 'background = #fff',
      bounds: { x: 1, y: 3, width: 400, height: 301 },
    })
    expect(() => nativeTerminalOptions({ command: 'echo\0bad' })).toThrow('null bytes')
    expect(() => nativeTerminalOptions({ configuration: 'x'.repeat(32_769) }))
      .toThrow('too large')
    expect(nativeTerminalConfiguration(' background = #20232b ')).toBe('background = #20232b')
    expect(() => nativeTerminalConfiguration('bad\0config')).toThrow('null bytes')
  })

  it('validates popup geometry before crossing the native boundary', () => {
    expect(nativeTerminalOverlay(null)).toBeNull()
    expect(nativeTerminalOverlay({ x: 3.2, y: 10.7, width: 100, height: 40, borderRadius: 30 }))
      .toEqual({ x: 3, y: 11, width: 100, height: 40, borderRadius: 20 })
    expect(() => nativeTerminalOverlay({ x: Infinity, y: 0, width: 10, height: 10, borderRadius: 0 })).toThrow('finite')
    expect(() => nativeTerminalOverlay({ x: 0, y: 0, width: 10, height: 10, borderRadius: NaN })).toThrow('finite')
  })

  it('deduplicates visibility and destroys the native surface once', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const setVisible = vi.fn().mockResolvedValue(undefined)
    const destroy = vi.fn().mockResolvedValue(undefined)
    const configure = vi.fn().mockResolvedValue(undefined)
    const bridge = {
      create: vi.fn().mockResolvedValue({ id: 'terminal-1', backend: 'ghostty' as const, supportsOverlay: true }),
      setBounds: vi.fn().mockResolvedValue(undefined),
      setVisible,
      setOverlay: vi.fn().mockResolvedValue(undefined),
      focus: vi.fn().mockResolvedValue(undefined),
      configure,
      destroy,
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __ALTO_DESKTOP__: {
          platform: 'darwin',
          nativeViews: {},
          nativeTerminals: bridge,
        },
      },
    })

    try {
      const terminal = await new ClientNativeTerminals().create({
        workingDirectory: '/repo',
        bounds: { x: 1.2, y: 2.8, width: 500.2, height: 300.4 },
      })
      terminal.setBounds({ x: 1.4, y: 3.1, width: 500.3, height: 300.2 })
      terminal.setBounds({ x: 2, y: 3, width: 500, height: 300 })
      terminal.setVisible(true)
      terminal.setVisible(true)
      expect(terminal.supportsOverlay).toBe(true)
      const overlay = { x: 10, y: 20, width: 350, height: 180, borderRadius: 12 }
      terminal.setOverlay?.(overlay)
      terminal.setOverlay?.({ ...overlay })
      terminal.setOverlay?.(null)
      expect(bridge.setOverlay.mock.calls).toEqual([['terminal-1', overlay], ['terminal-1', null]])
      terminal.setVisible(false)
      terminal.configure('background = #20232b')
      terminal.configure(' background = #20232b ')
      terminal.focus()
      await terminal.destroy()
      await terminal.destroy()

      expect(setVisible.mock.calls.map(([, visible]) => visible)).toEqual([true, false])
      expect(bridge.create).toHaveBeenCalledWith({
        workingDirectory: '/repo',
        bounds: { x: 1, y: 3, width: 500, height: 300 },
      })
      expect(bridge.setBounds).toHaveBeenCalledOnce()
      expect(bridge.setBounds).toHaveBeenCalledWith(
        'terminal-1',
        { x: 2, y: 3, width: 500, height: 300 },
      )
      expect(bridge.focus).toHaveBeenCalledWith('terminal-1')
      expect(configure).toHaveBeenCalledOnce()
      expect(configure).toHaveBeenCalledWith('terminal-1', 'background = #20232b')
      expect(destroy).toHaveBeenCalledTimes(1)
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else delete (globalThis as { window?: Window }).window
    }
  })

})
