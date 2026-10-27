import { useMemo, useSyncExternalStore } from 'react'

export interface ExternalStore<State> {
  subscribe(listener: () => void): () => void
  snapshot(): State
}

export type StoreSelector<State, Selection> = (state: State) => Selection
export type StoreSelectionEqual<Selection> = (left: Selection, right: Selection) => boolean

export function createSelectedSnapshot<State, Selection>(
  store: ExternalStore<State>,
  selector: StoreSelector<State, Selection>,
  equal: StoreSelectionEqual<Selection> = Object.is,
): () => Selection {
  let initialized = false
  let current: Selection
  return () => {
    const next = selector(store.snapshot())
    if (!initialized || !equal(current, next)) {
      current = next
      initialized = true
    }
    return current
  }
}

/**
 * Subscribes to a narrow projection of an external store. React sees the same
 * snapshot identity while unrelated fields change, so transcript deltas do
 * not rerender controls that only depend on chat metadata.
 */
export function useStoreSelector<State, Selection>(
  store: ExternalStore<State>,
  selector: StoreSelector<State, Selection>,
  equal: StoreSelectionEqual<Selection> = Object.is,
): Selection {
  const snapshot = useMemo(
    () => createSelectedSnapshot(store, selector, equal),
    [equal, selector, store],
  )
  return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}
