import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  MermaidDiagram,
  mermaidConfiguration,
} from '../program/plugins/mermaid.client.js'

describe('Mermaid diagrams', () => {
  it('uses a strict bounded site configuration for untrusted chat content', () => {
    const config = mermaidConfiguration({ maxSourceCharacters: 250_000 })

    expect(config).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 100_000,
      maxEdges: 500,
      theme: 'base',
    })
  })

  it('renders a stable inline placeholder before the lazy renderer resolves', () => {
    const html = renderToStaticMarkup(
      <MermaidDiagram
        code={'flowchart LR\n  A --> B'}
        language="mermaid"
        config={{}}
      />,
    )

    expect(html).toContain('cordis-mermaid is-loading')
    expect(html).toContain('Drawing diagram')
    expect(html).toContain('aria-busy="true"')
  })
})
