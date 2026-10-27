import type { HarnessPlugin, UiShell } from '../../src/server/plugin-api.js'

const shell: UiShell = {
  id: 'minimal-shell',
  theme: {
    accent: '#7c3aed',
    accentText: '#ffffff',
    background: '#eef0f3',
    canvas: '#f2f3f6',
    panel: '#f7f8fa',
    text: '#4d5368',
    textStrong: '#353a4e',
    muted: '#898fa1',
    border: '#dcdfe5',
    font: 'system',
    density: 'comfortable',
    corners: 'round',
  },
  root: {
    type: 'box',
    id: 'workspace',
    direction: 'row',
    grow: true,
    surface: 'canvas',
    scroll: 'none',
    responsive: 'stack',
    children: [
      { type: 'outlet', name: 'sidebar' },
      {
        type: 'outlet',
        name: 'workspace-primary',
        fallback: {
          type: 'box',
          role: 'main',
          direction: 'column',
          grow: true,
          surface: 'canvas',
          scroll: 'none',
          children: [
            {
              type: 'box',
              id: 'conversation-header',
              role: 'header',
              direction: 'row',
              align: 'center',
              gap: 'md',
              surface: 'none',
              children: [
                {
                  type: 'box',
                  id: 'header-leading',
                  direction: 'row',
                  align: 'center',
                  gap: 'xs',
                  surface: 'raised',
                  radius: 'lg',
                  shadow: 'soft',
                  children: [
                    { type: 'slot', name: 'header-left', presentation: 'inline', direction: 'row' },
                  ],
                },
                {
                  type: 'box',
                  id: 'header-tools',
                  direction: 'row',
                  align: 'center',
                  gap: 'xs',
                  surface: 'raised',
                  radius: 'lg',
                  shadow: 'soft',
                  children: [
                    { type: 'slot', name: 'header-right', presentation: 'inline', direction: 'row' },
                    { type: 'surface', id: 'default-plugins' },
                    { type: 'surface', id: 'default-settings' },
                  ],
                },
                { type: 'spacer' },
              ],
            },
            { type: 'slot', name: 'main', presentation: 'plain', direction: 'column' },
            { type: 'surface', id: 'default-conversation' },
            { type: 'surface', id: 'default-scrollback' },
            { type: 'surface', id: 'default-steer' },
            { type: 'surface', id: 'default-turn-progress' },
            { type: 'surface', id: 'default-composer' },
          ],
        },
      },
    ],
  },
}

const shellUi: HarnessPlugin = (ctx) => {
  ctx.ui.registerShell(ctx, shell)
}

shellUi.inject = ['ui', 'uiDefaults']

export default shellUi
