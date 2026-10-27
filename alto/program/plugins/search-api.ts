import type { UiSurface } from '../../src/shared/protocol.js'

export const SEARCH_PREVIEW = 'search.preview'

export const searchSurface = {
  id: 'default-search',
  kind: 'search',
  label: 'Search',
  appearance: 'full',
  placeholder: 'Search conversations…',
} satisfies UiSurface
