import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import type { CanvasDockItemProps } from './canvas-api.js'

const canvasTabs: BrowserPlugin = (ctx) => {
  const PaneTabs = ctx.clientPaneTabs.renderer

  ctx.clientCanvas.registerDockItem(ctx, {
    id: 'canvas.pages',
    component: ({
      activePageId,
      activatePage,
      closePane,
      closePage,
      createPage,
      movePage,
      pages,
    }: CanvasDockItemProps) => (
      <PaneTabs
        tabs={pages}
        activeId={activePageId}
        label="Canvas pages"
        createLabel="New Canvas page"
        activate={activatePage}
        create={createPage}
        close={closePage}
        {...(closePane ? {
          closeLast: closePane,
          closeLastLabel: 'Close Canvas pane',
        } : {})}
        move={movePage}
      />
    ),
    order: 0,
    grow: true,
  })
}

canvasTabs.inject = ['clientCanvas', 'clientPaneTabs']

export default canvasTabs
