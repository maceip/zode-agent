const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')

async function check() {
  await app.whenReady()
  const destination = 'https://example.com/documentation/a-long-destination/that-needs-to-stay-inside-the-window?section=markdown-tables'
  const source = '| Link | Details |\n| --- | --- |\n| [Documentation](' + destination + ') | Last row |'
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'markdown-link-preview.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {MarkdownContent} from './program/plugins/ui/markdown';
      const root=createRoot(document.getElementById('root'));
      window.render=source=>flushSync(()=>root.render(<section className="markdown-viewer-pane alto-pane">
        <div className="markdown-viewer-scroll"><MarkdownContent className="activity-markdown" source={source}/></div>
      </section>));
      window.teardown=()=>flushSync(()=>root.unmount());
      render(${JSON.stringify(source)});
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all([
    'src/client/styles.css', 'program/plugins/ui/default.css', 'program/plugins/markdown.css',
    'program/plugins/markdown-viewer.css', 'program/plugins/theme.css',
  ].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => {
    response.end('<!doctype html><style>' + css + `
      body{margin:0;background:var(--canvas)}
      #root{position:absolute;left:18px;right:18px;bottom:100px;width:auto;height:auto;overflow:hidden;transform:translateZ(0)}
      .markdown-viewer-scroll{max-height:130px}
      .markdown-table-shell table{min-width:500px!important}
    </style><div id="root"></div>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: {
    offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } })
  const run = code => win.webContents.executeJavaScript(code)
  const frames = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const until = async expression => {
    for (let index = 0; index < 90; index++) { if (await run(expression)) return; await frames() }
    throw new Error('Timed out: ' + expression)
  }
  const tooltip = 'document.querySelector(".markdown-link-preview")'
  const link = 'document.querySelector("a[data-link-preview]")'
  const hover = async () => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 })
    await frames()
    const point = await run(`(()=>{const r=${link}.getBoundingClientRect();return {x:Math.ceil(r.left+8),y:Math.ceil(r.top+r.height/2)}})()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    await until(`!!${tooltip} && getComputedStyle(${tooltip}).visibility==='visible'`)
    await frames()
  }
  const checkVisible = async () => {
    assert.equal(await run(`(()=>{
      const el=${tooltip}, r=el.getBoundingClientRect();
      if(r.width<=0||r.height<=0||r.left<17||r.right>innerWidth-17||r.top<17||r.bottom>innerHeight-17)return false;
      el.style.pointerEvents='auto';
      const visible=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===el;
      el.style.removeProperty('pointer-events');return visible;
    })()`), true, 'The destination is painted inside the window, outside all clipping ancestors')
    assert.equal(await run(`${tooltip}.textContent`), destination)
  }
  const screenshot = async name => {
    if (!process.env.ALTO_LINK_PREVIEW_ARTIFACT_DIR) return
    await fs.mkdir(process.env.ALTO_LINK_PREVIEW_ARTIFACT_DIR, { recursive: true })
    await fs.writeFile(path.join(process.env.ALTO_LINK_PREVIEW_ARTIFACT_DIR, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}`)
    // Exercise :focus-visible without bringing the hidden test window forward.
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await run(bundle.outputFiles[0].text)
    for (const width of [1000, 360]) {
      win.setContentSize(width, 760)
      await run("document.querySelector('#root').style.bottom='100px'")
      await frames()
      await hover()
      await checkVisible()
      assert.equal(await run(`${tooltip}.getBoundingClientRect().bottom>document.querySelector('.markdown-table-shell').getBoundingClientRect().bottom`), true)
      assert.equal(await run(`${tooltip}.getBoundingClientRect().bottom>document.querySelector('#root').getBoundingClientRect().bottom`), true)
      await screenshot('table-bottom-' + width)

      await run("document.querySelector('#root').style.bottom='0px'")
      await hover()
      await checkVisible()
      assert.equal(await run(`${tooltip}.getBoundingClientRect().bottom<${link}.getBoundingClientRect().top`), true, 'Near the window bottom the preview flips above the link')
      await screenshot('window-bottom-' + width)
    }
    await run("document.documentElement.dataset.altoTheme='dark'")
    await screenshot('window-bottom-dark')
    await run("document.querySelector('.markdown-table-shell').scrollLeft=30")
    await until(`!${tooltip}`)
    await run("document.querySelector('.markdown-table-shell').scrollLeft=0")
    await frames()

    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 })
    // Column resize handles precede the link in the keyboard tab order.
    for (let index = 0; index < 5 && !await run(`document.activeElement===${link}`); index++) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
      await frames()
    }
    await until(`!!${tooltip}`)
    assert.equal(await run(`document.activeElement===${link}`), true)
    assert.equal(await run(`${link}.getAttribute('aria-describedby')===${tooltip}.id`), true)
    await checkVisible()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await until(`!${tooltip}`)
    assert.equal(await run(`${link}.hasAttribute('aria-describedby')`), false)
    await run(`${link}.blur()`)

    await hover()
    win.setContentSize(400, 760)
    await until(`!${tooltip}`)
    await hover()
    await run('teardown()')
    assert.equal(await run(`!!${tooltip}`), false)
    console.log('Markdown link preview browser checks passed')
  } finally {
    win.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
