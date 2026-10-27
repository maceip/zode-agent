import { describe, expect, it, vi } from 'vitest'
import {
  ComposerPreferenceController,
  parseComposerPreference,
} from '../program/plugins/composer.client.js'

describe('composer preferences', () => {
  it('defaults automatic expansion off', () => {
    expect(parseComposerPreference(undefined)).toEqual({
      version: 1,
      autoExpand: false,
    })
  })

  it('persists expansion changes and notifies subscribers', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    const controller = new ComposerPreferenceController(false, storage)
    const changed = vi.fn()
    const unsubscribe = controller.subscribe(changed)

    controller.setAutoExpand(true)

    expect(controller.snapshot()).toMatchObject({ autoExpand: true, revision: 1 })
    expect(changed).toHaveBeenCalledOnce()
    expect(new ComposerPreferenceController(false, storage).snapshot())
      .toMatchObject({ autoExpand: true })
    unsubscribe()
  })
})
