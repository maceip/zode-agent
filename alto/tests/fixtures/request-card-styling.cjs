const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'request-card-styling.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {ApprovalRequest,ProgramProposalRequest} from './program/plugins/ui/inspectors';
      const root=createRoot(document.getElementById('root'));
      const long='long-context-'.repeat(15);
      const request=(method,params)=>({id:1,method,params,receivedAt:'2026-10-16T00:00:00Z'});
      const samples=[
        request('item/commandExecution/requestApproval',{command:'npm run check',cwd:'/repo/'+long}),
        request('item/fileChange/requestApproval',{changes:[{path:long,kind:'update'}]}),
        request('item/permissions/requestApproval',{scope:long}),
        request('mcp/elicitation',{question:long}),
        request('legacy/requestUserInput',{questions:[
          {id:'scope',question:'Select the scope for '+long,options:[{label:'Current workspace'},{label:long}]},
          {id:'custom',question:'Additional context',options:[]}
        ]}),
        request('agent/requestApproval',{title:'Allow this action?',options:[
          {id:'allow',kind:'allow_once',label:'Allow this action with the supplied workspace context'},
          {id:'deny',kind:'reject_once',label:'Decline'}
        ]}),
        request('item/tool/requestUserInput',{threadId:'chat',turnId:'turn',itemId:'item',isBlocking:true,questions:[
          {id:'scope',header:'Workspace',question:'Where should I apply this change?',isOther:true,options:[
            {label:'Current workspace (Recommended)',description:'Apply the change to '+long},
            {label:'All workspaces',description:'Update every project.'}
          ]}
        ]}),
        null,
      ];
      window.renderSample=index=>flushSync(()=>root.render(samples[index]
        ? <ApprovalRequest key={index} request={samples[index]} resolve={async()=>{}}/>
        : <ProgramProposalRequest proposal={{id:'proposal',summary:'Update request-card styling for '+long,files:[{path:'plugins/example.ts',content:long}]}} resolve={async()=>{}}/>));
      window.samples=samples.length;
      window.renderSample(0);
      window.teardown=()=>flushSync(()=>root.unmount());
      const rgba=color=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map((n,i)=>i===3?n/255:n)};
      const blend=(front,back)=>{const a=front[3];return front.slice(0,3).map((n,i)=>n*a+back[i]*(1-a)).concat(1)};
      const background=el=>{if(!el)return [255,255,255,1];return blend(rgba(getComputedStyle(el).backgroundColor),background(el.parentElement))};
      const luminance=rgb=>rgb.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
      window.contrast=(el,pseudo)=>{const bg=background(el),fg=blend(rgba(getComputedStyle(el,pseudo).color),bg),a=luminance(fg),b=luminance(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
    ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all(['src/client/styles.css', 'program/plugins/ui/default.css', 'program/plugins/theme.css', 'program/plugins/ui/user-input.css'].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => response.end('<!doctype html><style>' + css + 'body{background:var(--canvas);overflow:auto}main{max-width:768px;margin:auto;padding:18px}</style><main><div id="root"></div></main>'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const win = new BrowserWindow({ show: false, width: 1000, height: 1000, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => {
    if (event.level === 'error') console.error(event.message)
  })
  const run = code => win.webContents.executeJavaScript(code)
  const settle = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  let checks = 0
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}`)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('DOM.enable')
    await win.webContents.debugger.sendCommand('CSS.enable')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await run(bundle.outputFiles[0].text)
    for (const theme of ['light', 'dark']) {
      for (const width of [1000, 480, 360]) {
        win.setContentSize(width, 1000)
        await run(`document.documentElement.dataset.altoTheme='${theme}'`)
        for (let index = 0; index < 8; index++) {
          await run(`renderSample(${index});document.querySelectorAll('details').forEach(el=>el.open=true)`)
          await settle()
          const context = JSON.stringify({ theme, width, index })
          const metrics = await run(`(()=>{
            const card=document.querySelector('.approval-card,.input-request'),r=card.getBoundingClientRect();
            return {left:r.left,right:r.right,scroll:document.documentElement.scrollWidth,width:innerWidth,
              cardScroll:card.scrollWidth,cardWidth:card.clientWidth,
              contrast:[...card.querySelectorAll('h3,summary,pre,select,input:not([type=radio]),textarea,.input-question-title,.input-question-description,.input-question-option-copy')].map(el=>({tag:el.tagName,ratio:contrast(el)})),
              controls:[...card.querySelectorAll('input:not([type=radio]),select,textarea,button')].every(el=>{const b=el.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right})};
          })()`)
          assert.ok(metrics.left >= 0 && metrics.right <= width, context + JSON.stringify(metrics))
          assert.ok(metrics.scroll <= width && metrics.cardScroll <= metrics.cardWidth, context + JSON.stringify(metrics))
          assert.ok(metrics.controls, 'Controls overflow: ' + context)
          for (const text of metrics.contrast) assert.ok(text.ratio >= 4.5, context + JSON.stringify(text))
          const control = await run(`(()=>{const el=document.querySelector('input:not([type=radio]),select,textarea');if(!el)return null;el.focus();const style=getComputedStyle(el);return {outline:style.outlineStyle,width:parseFloat(style.outlineWidth),placeholder:contrast(el,'::placeholder'),active:document.activeElement===el,visible:el.matches(':focus-visible'),focused:document.hasFocus()}})()`)
          if (control) {
            assert.notEqual(control.outline, 'none', 'Focus outline: ' + context + JSON.stringify(control))
            assert.ok(control.width >= 2, 'Focus outline width: ' + context)
            assert.ok(control.placeholder >= 4.5, 'Placeholder contrast: ' + context)
          }
          if (index === 6) {
            await run(`document.querySelector('.input-question-option').click()`)
            await settle()
            // Emulate the keyboard focus state without activating a native window.
            const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument')
            const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=radio]' })
            await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] })
            const selected = await run(`(()=>{const option=document.querySelector('.input-question-option'),indicator=option.querySelector('.input-question-indicator');return {contrast:contrast(indicator),outline:getComputedStyle(option).outlineStyle}})()`)
            assert.ok(selected.contrast >= 4.5, 'Selected indicator contrast: ' + context + JSON.stringify(selected))
            assert.notEqual(selected.outline, 'none', 'Radio focus outline: ' + context)
          }
          if (process.env.ALTO_REQUEST_CARD_ARTIFACT_DIR && [0,6].includes(index) && [360,1000].includes(width)) {
            await fs.mkdir(process.env.ALTO_REQUEST_CARD_ARTIFACT_DIR, { recursive: true })
            await fs.writeFile(path.join(process.env.ALTO_REQUEST_CARD_ARTIFACT_DIR, `request-${index}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
          }
          checks++
        }
      }
    }
    await run('teardown()')
    console.log(`Request card styling checks passed: ${checks} theme, width, and request combinations`)
  } finally {
    win.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
