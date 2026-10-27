import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { macApplicationMenuTemplate } from '../src/desktop/application-menu.js'

describe('macOS application menu', () => {
  it('exposes Settings with the standard shortcut', () => {
    const openSettings = vi.fn()
    const template = macApplicationMenuTemplate('Alto', openSettings)
    const appMenu = template[0]
    const submenu = appMenu?.submenu as MenuItemConstructorOptions[] | undefined
    const settings = submenu?.find((item) => item.label === 'Settings…')

    expect(appMenu?.label).toBe('Alto')
    expect(settings?.accelerator).toBe('CmdOrCtrl+,')
    expect(settings?.click).toBe(openSettings)
  })
})
