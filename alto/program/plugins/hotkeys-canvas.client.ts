import type { Plugin } from 'cordis'

const hotkeysCanvas: Plugin = (ctx) => {
  ctx.clientHotkeys.registerAction(ctx, {
    id: 'panel.canvas.toggle',
    label: 'Toggle Canvas',
    detail: 'Open, focus, or close the Canvas pane in the active workspace.',
    category: 'Panels',
    binding: { kind: 'leader', key: 'c' },
    run: () => ctx.clientCanvas.toggle(),
  })
}

hotkeysCanvas.inject = ['clientHotkeys', 'clientCanvas']

export default hotkeysCanvas
