import { readFile } from 'node:fs/promises'
import { Context, type Plugin } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ClientUiService } from '../src/client/plugin-api.js'
import type { ClientHotkeysService, HotkeyAction } from '../program/plugins/hotkeys-api.js'
import pullRequestHotkeys from '../program/plugins/pull-requests-hotkeys.client.js'
import { PR_PANE, PR_TOGGLE_ACTION } from '../program/plugins/pull-requests-api.js'
import { hotkeyHintLabel, matchesGlobalBinding } from '../program/plugins/hotkeys.client.js'

describe('pull request shortcuts', () => {
  it('registers a leader chord and direct toggle, and follows provider and parent lifetimes', async () => {
    const context = new Context()
    const actions = new Map<string, HotkeyAction>()
    const hotkeys = {
      registerAction: (owner: Context, action: HotkeyAction) => {
        const dispose = owner.effect(() => {
          actions.set(action.id, action)
          return () => actions.delete(action.id)
        }, `test.hotkey(${action.id})`)
        return { dispose: async () => dispose() }
      },
    } as unknown as ClientHotkeysService
    const toggle = vi.fn()
    const uiProvider: Plugin = (ctx) => ctx.provide('clientUi', { overlays: { toggle } } as unknown as ClientUiService)
    uiProvider.provide = 'clientUi'
    const hotkeyProvider: Plugin = (ctx) => ctx.provide('clientHotkeys', hotkeys)
    hotkeyProvider.provide = 'clientHotkeys'
    let child: ReturnType<Context['plugin']> | undefined
    const parent: Plugin = (ctx) => { child = ctx.plugin(pullRequestHotkeys, {}) }
    const uiFiber = await context.plugin(uiProvider)
    const parentFiber = await context.plugin(parent)
    expect(actions.size).toBe(0)
    let hotkeysFiber = await context.plugin(hotkeyProvider)
    await child?.await()
    const action = actions.get(PR_TOGGLE_ACTION)!
    expect(action).toMatchObject({
      category: 'Panels',
      binding: { kind: 'leader', key: 'r' },
      aliases: [{ kind: 'global', key: 'p', meta: true, shift: true }],
    })
    action.run()
    action.run()
    expect(toggle.mock.calls).toEqual([[PR_PANE], [PR_PANE]])
    expect(hotkeyHintLabel({ ...action, enabled: true }, 'Alt')).toBe('⇧⌘P')
    expect(matchesGlobalBinding({ key: 'P', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }, action.aliases![0]!)).toBe(true)

    await hotkeysFiber.dispose()
    await child?.await()
    expect(actions.size).toBe(0)
    hotkeysFiber = await context.plugin(hotkeyProvider)
    await child?.await()
    expect(actions.has(PR_TOGGLE_ACTION)).toBe(true)
    await parentFiber.dispose()
    expect(actions.size).toBe(0)
    await hotkeysFiber.dispose()
    await uiFiber.dispose()
  })

  it('keeps shortcuts inside the PR plugin and associates the button with its action', async () => {
    const manifest = JSON.parse(await readFile(new URL('../program/cordis.json', import.meta.url), 'utf8'))
    type Entry = { id: string; children?: Entry[] }
    const find = (entries: Entry[], id: string): Entry | undefined => {
      for (const entry of entries) {
        if (entry.id === id) return entry
        const child = find(entry.children ?? [], id)
        if (child) return child
      }
    }
    const pr = find(manifest.plugins, 'pull-requests')
    expect(pr?.children).toContainEqual(expect.objectContaining({ id: 'pull-requests-hotkeys', enabled: true }))
    const client = await readFile(new URL('../program/plugins/pull-requests.client.tsx', import.meta.url), 'utf8')
    expect(client).toContain('data-hotkey-action={PR_TOGGLE_ACTION}')
  })
})
