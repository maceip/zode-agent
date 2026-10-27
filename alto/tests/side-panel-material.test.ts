import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('side panel material', () => {
  it('shares translucent fill and blur without changing other floating panels', async () => {
    const [theme, sidebar, agents, pullRequests] = await Promise.all(
      ['theme', 'sidebar', 'orchestrator', 'pull-requests'].map((name) =>
        readFile(new URL(`../program/plugins/${name}.css`, import.meta.url), 'utf8'),
      ),
    )

    expect(theme).toContain('--side-panel-background: color-mix(in srgb, var(--sidebar-material) 50%, transparent);')
    expect(theme).toContain('--side-panel-backdrop: blur(32px) saturate(112%);')
    for (const css of [sidebar, agents]) {
      expect(css).toContain('var(--side-panel-background, var(--sidebar-material))')
      expect(css).toContain('var(--side-panel-backdrop, blur(26px) saturate(112%))')
    }
    expect(pullRequests).toContain('--alto-floating-panel-background: var(--sidebar-material);')
    expect(pullRequests).not.toContain('--side-panel-')
    expect(sidebar).toMatch(/html\[data-sidebar-mode='pinned'\][\s\S]*?opacity: 1;/)
    expect(agents).toMatch(/\.agents-panel\.is-open\s*\{\s*opacity: 1;/)
  })
})
