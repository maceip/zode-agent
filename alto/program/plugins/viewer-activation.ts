import { useEffect, useState } from 'react'

// Load a restored pane only after it is first shown. Once started, its requests
// and loaded state belong to the pane until it closes, not to the selected tab.
export function useViewerActivated(visible: boolean): boolean {
  const [activated, setActivated] = useState(visible)
  useEffect(() => {
    if (visible) setActivated(true)
  }, [visible])
  return activated || visible
}
