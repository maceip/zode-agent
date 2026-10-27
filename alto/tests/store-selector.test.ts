import { describe, expect, it } from 'vitest'
import { createSelectedSnapshot } from '../program/plugins/ui/store-selector.js'

describe('external store selection', () => {
  it('preserves selection identity when only unrelated state changes', () => {
    let state = { relevant: 'chat-a', transcriptRevision: 1 }
    const store = {
      subscribe: () => () => undefined,
      snapshot: () => state,
    }
    const snapshot = createSelectedSnapshot(
      store,
      (current) => ({ relevant: current.relevant }),
      (left, right) => left.relevant === right.relevant,
    )

    const first = snapshot()
    state = { relevant: 'chat-a', transcriptRevision: 2 }
    expect(snapshot()).toBe(first)

    state = { relevant: 'chat-b', transcriptRevision: 2 }
    expect(snapshot()).not.toBe(first)
    expect(snapshot()).toEqual({ relevant: 'chat-b' })
  })

  it('uses object identity by default', () => {
    const selected = { value: 1 }
    let state = { selected }
    const store = {
      subscribe: () => () => undefined,
      snapshot: () => state,
    }
    const snapshot = createSelectedSnapshot(store, (current) => current.selected)

    expect(snapshot()).toBe(selected)
    state = { selected: { value: 1 } }
    expect(snapshot()).toBe(state.selected)
  })
})
