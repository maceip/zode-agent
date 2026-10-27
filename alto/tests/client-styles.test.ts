import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { clientStyles } from '../src/client/plugin-api.js'

const clientCssUrl = new URL('../src/client/styles.css', import.meta.url)
const paneToolbarCssUrl = new URL('../src/client/pane-toolbar.css', import.meta.url)
const defaultUiCssUrl = new URL('../program/plugins/ui/default.css', import.meta.url)
const defaultUiClientUrl = new URL('../program/plugins/ui-surfaces.client.tsx', import.meta.url)
const composerClientUrl = new URL('../program/plugins/composer.client.tsx', import.meta.url)
const settingsUiUrl = new URL('../program/plugins/ui/settings.tsx', import.meta.url)
const notificationsClientUrl = new URL('../program/plugins/chat-notifications.client.tsx', import.meta.url)
const themeClientUrl = new URL('../program/plugins/theme.client.tsx', import.meta.url)
const themeCssUrl = new URL('../program/plugins/theme.css', import.meta.url)
const browserWorkspaceClientUrl = new URL('../program/plugins/browser-workspace.client.tsx', import.meta.url)
const browserWorkspaceCssUrl = new URL('../program/plugins/browser-workspace.css', import.meta.url)
const codeTourClientUrl = new URL('../program/plugins/code-tour.client.tsx', import.meta.url)
const codeTourCssUrl = new URL('../program/plugins/code-tour.css', import.meta.url)
const codeBlocksCssUrl = new URL('../program/plugins/code-blocks.css', import.meta.url)
const diffViewerClientUrl = new URL('../program/plugins/diff-viewer.client.tsx', import.meta.url)
const diffViewerCssUrl = new URL('../program/plugins/diff-viewer.css', import.meta.url)
const diffReviewCommentsUrl = new URL('../program/plugins/diff-review-comments.tsx', import.meta.url)
const markdownViewerClientUrl = new URL('../program/plugins/markdown-viewer.client.tsx', import.meta.url)
const markdownViewerCssUrl = new URL('../program/plugins/markdown-viewer.css', import.meta.url)
const paneTabsCssUrl = new URL('../program/plugins/pane-tabs.css', import.meta.url)
const paneToolbarCompatUrl = new URL('../program/plugins/pane-toolbar.ts', import.meta.url)
const pdfViewerClientUrl = new URL('../program/plugins/pdf-viewer.client.tsx', import.meta.url)
const pdfViewerCssUrl = new URL('../program/plugins/pdf-viewer.css', import.meta.url)
const sidebarClientUrl = new URL('../program/plugins/sidebar.client.tsx', import.meta.url)
const sidebarCssUrl = new URL('../program/plugins/sidebar.css', import.meta.url)
const sourceViewerClientUrl = new URL('../program/plugins/source-viewer.client.tsx', import.meta.url)
const sourceViewerCssUrl = new URL('../program/plugins/source-viewer.css', import.meta.url)
const sharedCodeThemeUrl = new URL('../program/plugins/shared-code-theme.ts', import.meta.url)
const steerCssUrl = new URL('../program/plugins/steer.css', import.meta.url)
const turnProgressClientUrl = new URL('../program/plugins/turn-progress.client.tsx', import.meta.url)
const turnProgressCssUrl = new URL('../program/plugins/turn-progress.css', import.meta.url)
const workspaceLayoutClientUrl = new URL('../program/plugins/workspace-layout.client.tsx', import.meta.url)
const workspaceLayoutCssUrl = new URL('../program/plugins/workspace-layout.css', import.meta.url)

describe('client style contract', () => {
  it('defines every shared primitive at zero specificity', async () => {
    const css = `${await readFile(clientCssUrl, 'utf8')}\n${await readFile(paneToolbarCssUrl, 'utf8')}`

    for (const className of Object.values(clientStyles)) {
      expect(css).toContain(`:where(.${className})`)
    }
  })

  it('keeps the shared palette in the kernel instead of the default UI plugin', async () => {
    const [clientCss, defaultUiCss] = await Promise.all([
      readFile(clientCssUrl, 'utf8'),
      readFile(defaultUiCssUrl, 'utf8'),
    ])

    for (const token of ['--canvas', '--panel', '--text', '--muted', '--accent', '--floating-panel']) {
      expect(clientCss).toContain(`${token}:`)
    }
    expect(defaultUiCss).not.toMatch(/^:root\s*{/m)
  })

  it('uses the richer dark surface palette without weakening text', async () => {
    const css = await readFile(themeCssUrl, 'utf8')
    const darkTheme = css.match(/html\[data-alto-theme='dark'\]\s*\{([^}]*)\}/)?.[1]

    expect(darkTheme).toContain('--bg: #181a20;')
    expect(darkTheme).toContain('--canvas: #1d2027;')
    expect(darkTheme).toContain('--panel-solid: #262931;')
    expect(darkTheme).toContain('--text: #c8ccd8;')
    expect(darkTheme).toContain('--text-strong: #eceef4;')
  })

  it('shares one configurable syntax palette across Prism and Pierre viewers', async () => {
    const [themeCss, prismCss, sharedTheme, diffViewer, sourceViewer, codeTour] = await Promise.all([
      readFile(themeCssUrl, 'utf8'),
      readFile(codeBlocksCssUrl, 'utf8'),
      readFile(sharedCodeThemeUrl, 'utf8'),
      readFile(diffViewerClientUrl, 'utf8'),
      readFile(sourceViewerClientUrl, 'utf8'),
      readFile(codeTourClientUrl, 'utf8'),
    ])

    for (const token of [
      '--code-block-background',
      '--code-block-text',
      '--code-block-comment',
      '--code-block-keyword',
      '--code-block-function',
      '--code-block-string',
    ]) {
      expect(themeCss).toContain(`${token}:`)
      expect(prismCss).toContain(`var(${token}`)
    }

    expect(sharedTheme).toContain('ALTO_SHARED_CODE_THEMES.light,')
    expect(sharedTheme).toContain('ALTO_SHARED_CODE_THEMES.dark,')
    expect(themeCss).toMatch(/html\[data-alto-code-theme\]\[data-alto-theme\]\s*\{[^}]*--code-block-background: var\(--panel-soft\);[^}]*--code-block-text: var\(--text\);/s)
    expect(themeCss).toContain('--diffs-addition-color-override: var(--code-block-diff-inserted);')
    expect(themeCss).toContain('--diffs-deletion-color-override: var(--code-block-diff-deleted);')
    expect(themeCss).toContain('--diffs-modified-color-override: var(--code-block-function);')
    expect(themeCss).toContain('--diffs-foreground: var(--code-block-text);')
    expect(themeCss).toContain('--diffs-background: var(--code-block-background);')
    expect(themeCss).toContain('--diffs-token-comment: var(--code-block-comment);')
    expect(themeCss).toContain('--diffs-token-keyword: var(--code-block-keyword);')
    expect(themeCss).toContain('--diffs-token-function: var(--code-block-function);')
    expect(themeCss).toContain('--diffs-token-string: var(--code-block-string);')

    for (const viewer of [diffViewer, sourceViewer, codeTour]) {
      expect(viewer).toContain('ensureAltoSharedCodeTheme()')
      expect(viewer).toContain('theme: ALTO_SHARED_CODE_THEMES')
      expect(viewer).not.toContain("light: 'one-light', dark: 'one-dark-pro'")
    }
  })

  it('offers the Paper chrome palette and GitHub light/dark code colors', async () => {
    const [themeClient, themeCss] = await Promise.all([
      readFile(themeClientUrl, 'utf8'),
      readFile(themeCssUrl, 'utf8'),
    ])

    expect(themeClient).toContain("{ id: 'paper', label: 'Paper' }")
    expect(themeClient).toContain("{ id: 'github', label: 'GitHub light/dark' }")
    expect(themeClient).toContain("{ id: 'purple', label: 'Purple', value: '#7c3aed' }")
    expect(themeClient).toContain("{ id: 'graphite', label: 'Graphite', value: '#525252' }")
    expect(themeCss).toContain("html[data-alto-chrome-theme='paper'][data-alto-theme='light']")
    expect(themeCss).toContain("html[data-alto-chrome-theme='paper'][data-alto-theme='dark']")
    expect(themeCss).toContain('--alto-chrome-canvas: #f5f5f5;')
    expect(themeCss).toContain('--alto-chrome-panel: #232323;')
    expect(themeCss).toContain('--alto-chrome-text: #ffffff;')
    expect(themeCss).not.toContain("html[data-alto-code-theme='paper']")
    expect(themeCss).toContain("html[data-alto-code-theme='github'][data-alto-theme='light']")
    expect(themeCss).toContain("html[data-alto-code-theme='github'][data-alto-theme='dark']")
    expect(themeCss).toContain('--code-block-background: #24292e;')
    expect(themeCss).toContain('--code-block-string: #9ecbff;')
  })

  it('keeps reusable controls in the kernel style contract', async () => {
    const [clientCss, defaultUiCss] = await Promise.all([
      readFile(clientCssUrl, 'utf8'),
      readFile(defaultUiCssUrl, 'utf8'),
    ])

    expect(clientStyles).toMatchObject({
      button: 'alto-button',
      iconButton: 'alto-icon-button',
    })
    expect(clientCss).toContain(':where(.alto-button)')
    expect(defaultUiCss).not.toMatch(/^\.button\s*{/m)
    expect(defaultUiCss).not.toMatch(/^\.icon-button\s*{/m)
  })

  it('defines the shared visual vocabulary without changing legacy values', async () => {
    const css = await readFile(clientCssUrl, 'utf8')

    for (const token of [
      '--type-page-headline',
      '--type-product-title',
      '--type-topbar-title',
      '--type-body',
      '--type-label',
      '--type-supporting',
      '--weight-regular',
      '--weight-medium',
      '--weight-semibold',
      '--space-1',
      '--space-5',
      '--radius-dense',
      '--radius-panel',
      '--radius-pill',
      '--radius-composer',
      '--control-default',
      '--control-topbar',
      '--surface-canvas',
      '--surface-floating',
      '--text-secondary',
    ]) {
      expect(css).toContain(`${token}:`)
    }

    expect(css).toContain('--type-reading: var(--type-body);')
    expect(css).toContain('--button-height: var(--control-button);')
    expect(css).toContain('--radius-xs: var(--radius-dense);')
  })

  it('keeps settings on one stable shell and shared row vocabulary', async () => {
    const [css, defaultClient, settings, notifications, theme, composer] = await Promise.all([
      readFile(defaultUiCssUrl, 'utf8'),
      readFile(defaultUiClientUrl, 'utf8'),
      readFile(settingsUiUrl, 'utf8'),
      readFile(notificationsClientUrl, 'utf8'),
      readFile(themeClientUrl, 'utf8'),
      readFile(composerClientUrl, 'utf8'),
    ])
    const backdrops = [...css.matchAll(/\.program-modal-backdrop\s*\{([^}]*)\}/g)]
      .map((match) => match[1] ?? '')

    expect(css).toMatch(/\.program-modal\s*\{[^}]*width: min\(960px,[^}]*height: min\(680px,[^}]*grid-template-columns: 210px minmax\(0, 1fr\);/s)
    expect(backdrops.length).toBeGreaterThan(0)
    for (const backdrop of backdrops) {
      expect(backdrop).not.toContain('blur(')
    }
    expect(backdrops.some((backdrop) => backdrop.includes('-webkit-backdrop-filter: none;'))).toBe(true)
    expect(backdrops.some((backdrop) => backdrop.includes('backdrop-filter: none;'))).toBe(true)
    expect(css).toContain('.settings-row {')
    expect(settings).toContain('export function SettingsRow')
    expect(settings).toContain('export function SettingsSwitch')
    expect(settings).toContain('export function SettingsRadioMark')
    expect(composer).toContain("placement: 'general'")
    expect(defaultClient).toContain('<SettingsRadioMark selected={selected} />')
    expect(notifications).toContain("placement: 'general'")
    expect(theme).toContain('<SettingsRow label="Mode"')
    expect(theme).not.toContain('theme-settings-row')
  })

  it('keeps the chat title aligned, truncatable, and quietly editable', async () => {
    const [clientCss, defaultUiCss, client, css] = await Promise.all([
      readFile(clientCssUrl, 'utf8'),
      readFile(defaultUiCssUrl, 'utf8'),
      readFile(workspaceLayoutClientUrl, 'utf8'),
      readFile(workspaceLayoutCssUrl, 'utf8'),
    ])

    expect(clientCss).toContain('--type-chat-title: var(--type-body);')
    expect(clientCss).toContain('--line-chat-title: 20px;')
    expect(clientCss).toContain('--pane-chrome-gutter: 24px;')
    expect(clientCss).toContain('--composer-content-width: 768px;')
    expect(clientCss).toContain('--composer-content-gutter: 24px;')
    expect(clientCss).toContain('--conversation-reading-width: 720px;')
    expect(client).toContain('title={title}')
    expect(client).toContain('workspace-pane-title-rename')
    expect(client).toContain('<Pencil size={13} />')
    expect(css).toMatch(/\.workspace-pane-title\s*{[^}]*color: color-mix\(in srgb, var\(--text\) 78%, var\(--muted\)\);[^}]*font-size: var\(--type-chat-title\);[^}]*font-weight: var\(--weight-regular\);[^}]*letter-spacing: normal;[^}]*line-height: var\(--line-chat-title\);/s)
    expect(css).toMatch(/\.workspace-pane-title-text\s*{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s)
    expect(css).toMatch(/\.workspace-pane-header\s*{[^}]*padding: 0 var\(--space-2\) 0 var\(--pane-chrome-gutter\);/s)
    expect(css).toContain('max(var(--space-4), calc((100% - var(--conversation-reading-width)) / 2))')
    expect(css).toContain('.workspace-chat-pane:not(.workspace-typed-pane) > .workspace-pane-header { padding-left: calc(var(--space-2) * 2); }')
    expect(defaultUiCss).toContain('max(var(--composer-content-gutter), calc((100% - var(--composer-content-width)) / 2))')
    expect(css).toContain('.workspace-pane-title-control:hover .workspace-pane-title-rename')
    expect(css).not.toContain('.workspace-pane-title span { display: none; }')
  })

  it('keeps the conversation fade out of the scrollbar gutter', async () => {
    const css = await readFile(workspaceLayoutCssUrl, 'utf8')

    expect(css).toMatch(/\.workspace-pane-conversation::after\s*{[^}]*right: 8px;/s)
  })

  it('keeps the working shimmer active in visible unfocused chat panes', async () => {
    const [defaultUiCss, workspaceLayoutCss] = await Promise.all([
      readFile(defaultUiCssUrl, 'utf8'),
      readFile(workspaceLayoutCssUrl, 'utf8'),
    ])

    expect(defaultUiCss).toMatch(/\.is-shimmer-sweeping > \.activity-shimmer-sweep\s*{[^}]*animation-name: activity-shimmer-sweep;/s)
    expect(workspaceLayoutCss).not.toMatch(/\.workspace-chat-pane:not\(\.is-focused\)[^{]*\.activity-turn-live-trace/)
    expect(workspaceLayoutCss).toContain('.workspace-view[hidden] { display: none; }')
  })

  it('pauses the working shimmer while Alto is inactive', async () => {
    const css = await readFile(defaultUiCssUrl, 'utf8')

    expect(css).toMatch(/\.shell-conversation\.is-window-inactive :is\(\.activity-shimmer-sweep, \.activity-shimmer-highlight\)\s*{[^}]*animation: none;/s)
  })

  it('moves long-draft scrolling into the composer', async () => {
    const [defaultUiCss, workspaceLayoutCss] = await Promise.all([
      readFile(defaultUiCssUrl, 'utf8'),
      readFile(workspaceLayoutCssUrl, 'utf8'),
    ])

    expect(defaultUiCss).toMatch(/\.composer-editor\s*{[^}]*overflow-y: hidden;[^}]*scrollbar-gutter: stable;/s)
    expect(defaultUiCss).toMatch(/\.composer-editor\s*{[^}]*transition: none;/s)
    expect(defaultUiCss).toMatch(/\.composer\.is-overflowing \.composer-editor:not\(\.composer-editor-measure\)\s*{[^}]*overflow-y: auto;/s)
    expect(defaultUiCss).toMatch(/\.composer-editor-measure\s*{[^}]*overflow: hidden;/s)
    expect(workspaceLayoutCss).toMatch(/\.workspace-chat-pane \.conversation-feed::-webkit-scrollbar\s*{\s*display: none;/s)
  })

  it('uses a circular composer curve and continuous progress pills', async () => {
    const [clientCss, defaultUiCss, turnProgressCss] = await Promise.all([
      readFile(clientCssUrl, 'utf8'),
      readFile(defaultUiCssUrl, 'utf8'),
      readFile(turnProgressCssUrl, 'utf8'),
    ])

    expect(clientCss).toContain('--radius-composer: 48px;')
    expect(clientCss).toContain('--corner-shape-pill: superellipse(1.05);')
    expect(defaultUiCss).toMatch(/\.composer\s*\{[^}]*corner-shape: round;/s)
    expect(turnProgressCss).toContain('corner-shape: var(--corner-shape-pill, round);')
  })

  it('previews the pane half selected by a workspace-tab drop', async () => {
    const css = await readFile(workspaceLayoutCssUrl, 'utf8')

    expect(css).toContain('.workspace-chat-pane.is-tab-drop-left::after')
    expect(css).toContain('.workspace-chat-pane.is-tab-drop-bottom::after { inset: 50% 7px 7px; }')
  })

  it('uses the same radius token for workspace tabs and pane subtabs', async () => {
    const [workspaceCss, paneCss] = await Promise.all([
      readFile(workspaceLayoutCssUrl, 'utf8'),
      readFile(paneTabsCssUrl, 'utf8'),
    ])

    expect(workspaceCss).toMatch(/\.workspace-tab\s*\{[^}]*border-radius: var\(--radius-sm, 12px\);/s)
    expect(paneCss).toMatch(/\.pane-tab\s*\{[^}]*border-radius: var\(--radius-sm, 12px\);/s)
    expect(paneCss).toMatch(/\.pane-tab-drag-preview\s*\{[^}]*border-radius: var\(--radius-sm, 12px\);/s)
  })

  it('creates an unscoped chat from the top-level plus button', async () => {
    const client = await readFile(workspaceLayoutClientUrl, 'utf8')

    expect(client).toContain('const project = requestedProject ?? undefined')
    expect(client).toContain("projectScope: project ? 'workspace' : 'unscoped'")
    expect(client).toContain('aria-label="New chat with no workspace"')
    expect(client).toContain('onClick={() => addView()}')
    expect(client).toContain("if (event.key !== 'ArrowDown') return")
  })

  it('offers no workspace in the composer workspace picker', async () => {
    const client = await readFile(composerClientUrl, 'utf8')

    expect(client).toContain("{ id: '', label: 'No workspace', path: 'No workspace' }")
    expect(client).toContain('session.newThread(null)')
  })

  it('uses translucent blurred materials for floating conversation controls', async () => {
    const [defaultUiCss, steerCss] = await Promise.all([
      readFile(defaultUiCssUrl, 'utf8'),
      readFile(steerCssUrl, 'utf8'),
    ])

    expect(defaultUiCss).toMatch(/\.conversation-jump-latest\s*{[^}]*background: color-mix\(in srgb, var\(--panel-solid\) 52%, transparent\);[^}]*backdrop-filter: blur\(22px\)/s)
    expect(steerCss).toMatch(/\.steer-queue\s*{[^}]*background: color-mix\(in srgb, var\(--panel-solid\) 56%, transparent\);[^}]*backdrop-filter: blur\(22px\)/s)
  })

  it('uses a quiet file-diff icon for turn review without splitting the summary pill', async () => {
    const [progressClient, diffViewerClient, css] = await Promise.all([
      readFile(turnProgressClientUrl, 'utf8'),
      readFile(diffViewerClientUrl, 'utf8'),
      readFile(turnProgressCssUrl, 'utf8'),
    ])

    expect(progressClient).toContain('appearance="icon"')
    expect(diffViewerClient).toContain("appearance === 'icon'")
    expect(diffViewerClient).toContain('<FileDiff size={16} strokeWidth={1.7} />')
    expect(diffViewerClient).toContain("data-hotkey={appearance === 'icon' ? (active ? 'Close review' : problem ?? 'Review') : undefined}")
    expect(diffViewerClient).toContain("if (event.target === event.currentTarget && !hasDraft) close()")
    expect(diffViewerClient).not.toContain('title="Move to pane"')
    expect(diffViewerClient).not.toContain('<Columns2')
    expect(diffViewerClient).not.toContain('diff-viewer-action-label')
    expect(diffViewerClient).not.toContain('className="diff-viewer-action"')
    expect(diffViewerClient).toContain('<PanelLeftClose size={14} strokeWidth={1.6} />')
    expect(diffViewerClient).toContain('<TextWrap size={14} strokeWidth={1.6} />')
    expect(diffViewerClient).toContain('<RefreshCw size={14} strokeWidth={1.6} />')
    expect(diffViewerClient.match(/diff-viewer-control-group/g)).toHaveLength(3)
    expect(diffViewerClient).toContain("shortcut: 'd'")
    expect(css).toMatch(/\.turn-progress-pill \.file-change-review\s*{[^}]*--alto-icon-button-size: var\(--control-compact\);[^}]*background: transparent;/s)
    expect(css).not.toContain('--turn-progress-pill-edge')
  })

  it('grows the turn summary outward from its previous centered width', async () => {
    const [client, css] = await Promise.all([
      readFile(turnProgressClientUrl, 'utf8'),
      readFile(turnProgressCssUrl, 'utf8'),
    ])

    expect(client).toContain('new ResizeObserver')
    expect(client).toContain("String(growth / 2) + 'px'")
    expect(css).toMatch(/\.turn-progress-pill\.is-growing\s*{[^}]*animation: turn-progress-grow-outward/s)
    expect(css).toContain('clip-path: inset(0 var(--turn-progress-grow-inset, 0px) round 999px);')
  })

  it('shows changed-file details only from the files summary trigger', async () => {
    const css = await readFile(turnProgressCssUrl, 'utf8')

    expect(css).toContain('.turn-progress-control:has(.turn-progress-files-trigger:hover) .turn-progress-file-details')
    expect(css).toMatch(/\.turn-progress-file-row\s*{[^}]*grid-template-columns: 23px minmax\(0, 1fr\) auto;/s)
    expect(css).toMatch(/\.turn-progress-file-path\s*{[^}]*text-overflow: ellipsis;/s)
  })

  it('wraps long smart-link labels inside message bubbles', async () => {
    const css = await readFile(defaultUiCssUrl, 'utf8')

    expect(css).toMatch(/\.activity-markdown \.smart-link\s*{[^}]*max-width: 100%;[^}]*white-space: normal;/s)
    expect(css).toMatch(/\.activity-markdown \.smart-link > span\s*{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/s)
  })

  it('collapses Markdown soft wraps without losing user-entered newlines', async () => {
    const css = await readFile(defaultUiCssUrl, 'utf8')

    expect(css).toContain('.activity-markdown p { margin: 0 0 15px; white-space: normal; }')
    expect(css).toContain('.activity-user .activity-markdown p { white-space: pre-wrap; }')
  })

  it('uses proportional text for thinking traces while keeping code monospace', async () => {
    const [markdownCss, defaultUiCss, codeBlocksCss] = await Promise.all([
      readFile(new URL('../program/plugins/markdown.css', import.meta.url), 'utf8'),
      readFile(defaultUiCssUrl, 'utf8'),
      readFile(codeBlocksCssUrl, 'utf8'),
    ])

    expect(markdownCss).toMatch(/\.activity-content\.activity-markdown,\s*\.activity-reasoning \.activity-content\s*{\s*font-family: var\(--sans\);\s*}/)
    expect(defaultUiCss).toMatch(/\.activity-content\s*{[^}]*font:[^;]*var\(--mono\);/s)
    expect(defaultUiCss).toMatch(/\.activity-markdown code\s*{[^}]*font:[^;]*var\(--mono\);/s)
    expect(codeBlocksCss).toMatch(/figure\.cordis-code-block > pre > code\s*{[^}]*font:[^;]*var\(--mono\);/s)
  })

  it('uses restrained translucent materials on layered navigation and previews', async () => {
    const [markdownLink, diffViewerClient, diffViewerCss, paneTabsCss, workspaceLayoutCss] = await Promise.all([
      readFile(new URL('../program/plugins/markdown-link.tsx', import.meta.url), 'utf8'),
      readFile(diffViewerClientUrl, 'utf8'),
      readFile(diffViewerCssUrl, 'utf8'),
      readFile(paneTabsCssUrl, 'utf8'),
      readFile(workspaceLayoutCssUrl, 'utf8'),
    ])

    expect(workspaceLayoutCss).toMatch(/\.workspace-tabbar\s*{[^}]*background: color-mix\(in srgb, var\(--pane-tabbar-background, var\(--canvas\)\) 90%, transparent\);[^}]*backdrop-filter: blur\(14px\)/s)
    expect(paneTabsCss).toMatch(/\.pane-tab-drag-preview\s*{[^}]*background: color-mix\(in srgb, var\(--panel\) 88%, transparent\);[^}]*backdrop-filter: blur\(16px\)/s)
    expect(markdownLink).toContain('clientStyles.floatingPanel')
    expect(diffViewerCss).toMatch(/\.diff-viewer-body > \.file-tree\s*{[^}]*background: color-mix\(in srgb, var\(--panel-soft\) 76%, transparent\);[^}]*backdrop-filter: blur\(12px\)/s)
    expect(diffViewerClient).toMatch(/\[data-diffs-header\]\[data-sticky\]\s*{[^}]*background-color: color-mix\(in srgb, var\(--diffs-bg\) 88%, transparent\);[^}]*backdrop-filter: blur\(14px\)/s)
  })

  it('uses one shared toolbar treatment across pane types', async () => {
    const [
      toolbarCss,
      diffClient,
      diffCss,
      codeTourClient,
      sourceClient,
      sourceCss,
      markdownClient,
      markdownCss,
      pdfClient,
      pdfCss,
      browserClient,
      browserCss,
      workspaceClient,
      workspaceCss,
      compatibility,
    ] = await Promise.all([
      readFile(paneToolbarCssUrl, 'utf8'),
      readFile(diffViewerClientUrl, 'utf8'),
      readFile(diffViewerCssUrl, 'utf8'),
      readFile(codeTourClientUrl, 'utf8'),
      readFile(sourceViewerClientUrl, 'utf8'),
      readFile(sourceViewerCssUrl, 'utf8'),
      readFile(markdownViewerClientUrl, 'utf8'),
      readFile(markdownViewerCssUrl, 'utf8'),
      readFile(pdfViewerClientUrl, 'utf8'),
      readFile(pdfViewerCssUrl, 'utf8'),
      readFile(browserWorkspaceClientUrl, 'utf8'),
      readFile(browserWorkspaceCssUrl, 'utf8'),
      readFile(workspaceLayoutClientUrl, 'utf8'),
      readFile(workspaceLayoutCssUrl, 'utf8'),
      readFile(paneToolbarCompatUrl, 'utf8'),
    ])

    expect(clientStyles).toMatchObject({
      toolbar: 'alto-toolbar',
      paneToolbar: 'alto-pane-toolbar',
      toolbarTitle: 'alto-toolbar-title',
      toolbarPicker: 'alto-toolbar-picker',
      toolbarActions: 'alto-toolbar-actions',
      toolbarGroup: 'alto-toolbar-group',
      toolbarModes: 'alto-toolbar-modes',
    })
    expect(toolbarCss).toMatch(/:where\(\.alto-pane-toolbar\)\s*\{[^}]*--alto-pane-header-padding: 0 var\(--alto-pane-toolbar-end-padding, 160px\) 0 var\(--space-3\);[^}]*gap: var\(--space-3\);/s)
    expect(toolbarCss).toMatch(/:where\(\.alto-toolbar\)\s*\{[^}]*--alto-toolbar-control-size: var\(--control-compact\);[^}]*--alto-toolbar-font-size: var\(--type-control\);/s)
    expect(toolbarCss).toMatch(/:where\(\.alto-toolbar-actions\)\s*\{[^}]*gap: var\(--space-2\);/s)
    expect(toolbarCss).toMatch(/\.alto-icon-button\s*\{[^}]*--alto-icon-button-size: var\(--alto-toolbar-control-size\);[^}]*--alto-icon-button-radius: var\(--radius-pill\);/s)
    expect(toolbarCss).toMatch(/\.alto-toolbar-picker > select\s*\{[^}]*color: var\(--muted\);[^}]*font-size: var\(--alto-toolbar-font-size\);/s)
    expect(toolbarCss).toMatch(/\.alto-toolbar-modes > button\s*\{[^}]*height: var\(--alto-toolbar-control-size\);[^}]*color: var\(--muted\);[^}]*font-size: var\(--alto-toolbar-font-size\);/s)
    expect(toolbarCss).toMatch(/\.alto-icon-button\[aria-pressed="true"\]:not\(:disabled\)\s*\{[^}]*background: transparent;/s)
    expect(toolbarCss).toMatch(/\.alto-toolbar-modes > button\.is-active\s*\{[^}]*color: var\(--muted\);/s)
    expect(toolbarCss).toMatch(/\.alto-toolbar-modes > button:first-child\.is-active\s*\{[^}]*background: var\(--panel-soft\);/s)
    expect(toolbarCss).toMatch(/\.alto-toolbar-picker\.has-leading-icon > svg:first-child:not\(:last-child\)\)\s*\{[^}]*left: 10px;/s)

    for (const client of [diffClient, codeTourClient, sourceClient, markdownClient, pdfClient, browserClient]) {
      expect(client).toContain('paneToolbarStyles')
    }
    for (const css of [sourceCss, markdownCss, pdfCss]) {
      expect(css).not.toMatch(/-viewer-actions\s*\{[^}]*gap:/s)
    }
    expect(diffCss).not.toContain('--space-6')
    expect(diffCss).toMatch(/\.diff-viewer-pane\.is-overlay \.diff-viewer-toolbar\s*\{[^}]*--alto-pane-toolbar-end-padding: var\(--space-3\);/s)
    expect(codeTourClient).toContain('diff-viewer-commit-picker has-leading-icon')
    expect(browserClient).toContain('className={paneToolbarStyles.group}')
    expect(browserCss).not.toMatch(/\.browser-workspace-toolbar > button/)
    expect(workspaceClient).toContain('function WorkspacePaneActions(')
    expect(workspaceCss).toMatch(/\.workspace-pane-actions\s*\{ gap: var\(--space-2\); \}/)
    expect(workspaceCss).toMatch(/\.workspace-pane-action-group\s*\{ gap: var\(--space-2\); \}/)
    expect(workspaceCss).toMatch(/\.workspace-pane-actions button\s*\{[^}]*width: var\(--control-compact\);[^}]*height: var\(--control-compact\);[^}]*flex: 0 0 var\(--control-compact\);/s)
    expect(workspaceCss).toMatch(/\.workspace-pane-actions \.workspace-pane-fullscreen\.is-active\s*\{[^}]*color: var\(--text\);[^}]*background: var\(--panel-soft\);/s)
    expect(compatibility).not.toContain('needsPaneToolbarCompatibilityStyles')
    expect(workspaceClient).toContain("`${String(paneToolbarCss)}\\n${String(styles)}`")

    expect(diffCss).toMatch(/\.diff-review-overlay-panel\s*\{[^}]*width: min\(90%, 1280px\);[^}]*height: min\(90%, 900px\);/s)
    expect(diffCss).toMatch(/@container \(max-width: 540px\)[\s\S]*?\.diff-viewer-summary\s*\{[^}]*display: none;[\s\S]*?\.diff-viewer-commit-picker\s*\{[^}]*flex: 1 1 auto;[^}]*min-width: 0;/s)
  })

  it('keeps code tours readable in full and narrow panes', async () => {
    const [client, css, diffViewerCss, reviewComments] = await Promise.all([
      readFile(codeTourClientUrl, 'utf8'),
      readFile(codeTourCssUrl, 'utf8'),
      readFile(diffViewerCssUrl, 'utf8'),
      readFile(diffReviewCommentsUrl, 'utf8'),
    ])

    expect(css).toMatch(/\.code-tour-pane\s*{[^}]*container-type: inline-size;/s)
    expect(css).toMatch(/\.code-tour-document\s*{[^}]*width: min\(100%, 1120px\);[^}]*margin: 0 auto;/s)
    expect(css).toMatch(/@container \(max-width: 540px\)[\s\S]*?\.code-tour-document\s*{[^}]*padding: 26px 15px 64px;/s)
    expect(css).toMatch(/\.code-tour-diff\.diff-viewer-code\s*{[^}]*width: 100%;[^}]*height: auto;[^}]*overflow-x: auto;/s)
    expect(client).not.toContain('GPT-5.6 Sol is building the tour')
    expect(client).not.toContain('code-tour-kicker')
    expect(client).not.toContain('code-tour-step')
    expect(client).toContain("{tour ? tour.title : 'Code tour'}")
    expect(client).not.toContain("tour.stops.length === 1 ? 'stop' : 'stops'")
    expect(client).toContain("if (!resource) return BRANCH_CHOICE")
    expect(client).toContain('<option value={BRANCH_CHOICE}>Branch vs origin/main</option>')
    expect(client).toContain("scroll.addEventListener('wheel', handleDiffWheel, { capture: true, passive: false })")
    expect(client).toContain("scroll.addEventListener('pointermove', handleDiffPointerMove, true)")
    expect(client).toContain('hoveredDiff === diff && hoveredRow === row')
    expect(client).toContain('<div className="code-tour-scroll" ref={scrollRef}>')
    expect(client).toContain('enableGutterUtility: true')
    expect(client).toContain('lineAnnotations={annotationsByPath.get(stop.path) ?? EMPTY_REVIEW_ANNOTATIONS}')
    expect(client).toContain('options={stopOptions.get(stop.id) ?? options}')
    expect(client).toContain('<ReviewCommentComposer')
    expect(client).toContain("sending ? 'Sending…' : 'Send to chat'")
    expect(reviewComments).toContain('const [body, setBody] = useState(draft.body)')
    expect(reviewComments).toContain('onChange={(event) => setBody(event.target.value)}')
    expect(css).not.toContain('.code-tour-narrative::before')
    expect(css).not.toContain('.code-tour-stop::before')
    expect(diffViewerCss).not.toContain('--alto-pane-header-background')
    expect(diffViewerCss).not.toMatch(/\.diff-viewer-toolbar\s*{[^}]*backdrop-filter:/s)
  })

  it('separates adjacent diff files with one quiet rule instead of a background band', async () => {
    const [diffViewerClient, diffViewerCss] = await Promise.all([
      readFile(diffViewerClientUrl, 'utf8'),
      readFile(diffViewerCssUrl, 'utf8'),
    ])

    expect(diffViewerClient).toContain('layout: { paddingTop: 0, paddingBottom: 0, gap: 1 }')
    expect(diffViewerCss).toMatch(/\.diff-viewer-code\s*{[^}]*background: color-mix\(in srgb, var\(--border-soft\) 72%, var\(--canvas\)\);/s)
  })

  it('renders Markdown viewer quotes like quoted chat text', async () => {
    const [defaultUiCss, markdownViewerCss] = await Promise.all([
      readFile(defaultUiCssUrl, 'utf8'),
      readFile(markdownViewerCssUrl, 'utf8'),
    ])

    expect(defaultUiCss).toMatch(/\.activity-markdown blockquote\s*{[^}]*margin: 16px 0 16px 4px;[^}]*padding: 0 2px 0 16px;[^}]*color: var\(--text\);[^}]*border-left: 2px solid color-mix\(in srgb, var\(--text-strong\) 38%, transparent\);[^}]*background: transparent;/s)
    expect(markdownViewerCss).toMatch(/\.markdown-viewer-document blockquote\s*{[^}]*margin: 16px 0 16px 4px;[^}]*padding: 0 2px 0 16px;[^}]*color: var\(--text\);[^}]*border-left: 2px solid color-mix\(in srgb, var\(--text-strong\) 38%, transparent\);[^}]*background: transparent;/s)
  })

  it('keeps file-citation descenders inside their line boxes', async () => {
    const [defaultUiCss, markdownViewerCss, pdfViewerCss] = await Promise.all([
      readFile(defaultUiCssUrl, 'utf8'),
      readFile(markdownViewerCssUrl, 'utf8'),
      readFile(pdfViewerCssUrl, 'utf8'),
    ])

    expect(defaultUiCss).toMatch(/\.activity-markdown \.file-citation\s*{[^}]*line-height: 1\.2;/s)
    expect(markdownViewerCss).toMatch(/\.file-citation\[data-file-link-handler="markdown-viewer"\]\s*{[^}]*line-height: 1\.2;/s)
    expect(pdfViewerCss).toMatch(/\.file-citation\[data-file-link-handler="pdf-viewer"\]\s*{[^}]*line-height: 1\.2;/s)
  })

  it('keeps branding out of the top bar while exposing the sidebar toggle', async () => {
    const [defaultUiCss, sidebarClient, sidebarCss] = await Promise.all([
      readFile(defaultUiCssUrl, 'utf8'),
      readFile(sidebarClientUrl, 'utf8'),
      readFile(sidebarCssUrl, 'utf8'),
    ])

    expect(defaultUiCss).not.toContain('.topbar-brand')
    expect(defaultUiCss).not.toContain('.topbar-mark')
    expect(sidebarClient).not.toContain('sidebar-topbar-controls')
    expect(sidebarClient).not.toContain('topbar-mark')
    expect(sidebarClient).toContain('sidebar-topbar-toggle')
    expect(sidebarClient).toContain('<PanelLeft size={15}')
    expect(sidebarClient).toContain("`${clientStyles.button} ghost small shell-control shell-control-labeled`")
    expect(sidebarClient).toContain("`${clientStyles.iconButton} shell-control`")
    expect(sidebarCss).not.toContain('.sidebar-topbar-controls')
    expect(sidebarCss).not.toContain('.topbar-mark')
    expect(sidebarCss).toContain('.sidebar-topbar-toggle')
    expect(sidebarCss).toMatch(/\.shell-sidebar-action\s*\{[^}]*width: 100%;[^}]*justify-content: flex-start;/s)
    expect(sidebarCss).not.toContain('.button.shell-sidebar-action')
    expect(defaultUiCss).not.toContain('.button.shell-sidebar-action')
    expect(sidebarCss).toContain('--sidebar-inactive-text: color-mix(in srgb, var(--text) 55%, var(--muted));')
    expect(sidebarCss).toContain('.history-workspace-heading:not(.active),\n.history-entry:not(.active)')
    expect(sidebarCss).toMatch(/html\[data-alto-theme='dark'\] \[data-shell-node="conversation-history"\]\s*{[^}]*--sidebar-inactive-text: var\(--muted\);/s)
  })
})
