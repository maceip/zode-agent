import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

const desktop = window.__ALTO_DESKTOP__
if (desktop) {
  document.documentElement.dataset.desktopPlatform = desktop.platform
  const dispatchNativeKeyInput = (input: {
    type: 'keydown' | 'keyup'
    key: string
    code: string
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
    shiftKey: boolean
    repeat: boolean
  }): void => {
    window.dispatchEvent(new KeyboardEvent(input.type, {
      key: input.key,
      code: input.code,
      ctrlKey: input.ctrlKey,
      metaKey: input.metaKey,
      altKey: input.altKey,
      shiftKey: input.shiftKey,
      repeat: input.repeat,
      bubbles: true,
      cancelable: true,
    }))
  }
  desktop.nativeViews.onKeyInput?.(dispatchNativeKeyInput)
  desktop.nativeTerminals?.onKeyInput?.(dispatchNativeKeyInput)
}

const root = document.querySelector('#root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
