const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const http = require('node:http')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(), sourcefile: 'terminal-launcher.tsx', loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import ghostty from './program/plugins/ghostty-terminal.client';
        import baseStyles from './program/plugins/ui/default.css';
        const root = createRoot(document.getElementById('root'));
        const style = document.createElement('style'); style.textContent = baseStyles; document.head.append(style);
        window.creates = []; window.destroyed = []; window.requests = []; window.mode = 'ready';
        const effect = run => run();
        const native = {create: async options => {
          window.creates.push(options); const id = window.creates.length;
          return {id, setBounds:()=>{},setVisible:()=>{},focus:()=>{},configure:()=>{},destroy:async()=>window.destroyed.push(id)};
        }};
        const ui = {
          overlays: {subscribe:()=>()=>{}, nativeViewsOccluded:()=>false,snapshot:()=>undefined},
          registerStyle: (_owner,_id,text) => { const s=document.createElement('style');s.textContent=text;document.head.append(s); }
        };
        const host={call:async()=>({workingDirectory:'/default-development'})};
        const ctx={clientNativeTerminals:native,clientUi:ui,clientHost:host,effect,provide:(_id,service)=>window.terminals=service};
        ghostty(ctx,{});
        window.enable = () => window.terminals.registerLauncher({effect}, {
          id:'fixture', close:async()=>{}, prepare:async request=>{
            window.requests.push(request);
            if(window.mode==='fail')throw new Error('The saved terminal is temporarily unavailable.');
            if(window.mode==='wait')await new Promise(resolve=>window.finishLaunch=resolve);
            return {command:'saved-shell'};
          }
        });
        let props={workingDirectory:'/repo',command:'ordinary-shell',active:true,
          identity:{workspaceId:'workspace',paneId:'pane',tabId:'terminal-1'}};
        window.update = next => {
          props={...props,...next};const Terminal=window.terminals.renderer;
          flushSync(()=>root.render(<Terminal {...props}/>));
        };
        window.unmount = () => flushSync(()=>root.render(null));
        window.frame = () => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        window.update({});
      `,
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const server = http.createServer((_request, response) => response.end(
    '<html><style>html,body,#root{margin:0;width:100%;height:100%;--text:#51566d;--muted:#898fa1}</style><body><div id="root"></div></body></html>',
  ))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  const run = code => window.webContents.executeJavaScript(code)
  const frame = () => run('frame()')
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await frame()
    assert.equal(await run('creates[0].command'), 'ordinary-shell')
    await run('window.registration=enable(); update({identity:{workspaceId:"workspace",paneId:"pane",tabId:"terminal-1"}})')
    await frame()
    assert.equal(await run('creates.length'), 1, 'enabling persistence must not replace a running raw shell')
    await run('update({active:false})'); await frame()
    await run('update({active:true})'); await frame()
    assert.equal(await run('creates.length'), 1)
    assert.equal(await run('destroyed.length'), 0)

    await run('mode="wait"; update({identity:{workspaceId:"workspace",paneId:"pane",tabId:"terminal-2"}})')
    await frame()
    assert.equal(await run('creates.length'), 1, 'native creation waits for the session binding')
    assert.equal(await run('requests[0].identity.tabId'), 'terminal-2')
    await run('unmount(); finishLaunch()'); await frame()
    assert.equal(await run('creates.length'), 1, 'late preparation must not create an unmounted surface')

    await run('mode="fail"; update({identity:{workspaceId:"workspace",paneId:"pane",tabId:"terminal-3"}})')
    await frame()
    for (const width of [1000, 420]) {
      window.setContentSize(width, 500)
      await frame()
      const size = await run(`(() => {
        const retry=document.querySelector('button'); const rect=retry.getBoundingClientRect();
        return {text:document.body.textContent,overflow:document.documentElement.scrollWidth>innerWidth,
          left:rect.left,right:rect.right,shared:retry.classList.contains('alto-button')};
      })()`)
      assert.ok(size.text.includes('temporarily unavailable'))
      assert.ok(size.shared)
      assert.equal(size.overflow, false)
      assert.ok(size.left >= 0 && size.right <= width)
    }
    assert.equal(await run('requests.length'), 2, 'resizes must not repeatedly attempt a failed launch')
    await run('mode="ready"; document.querySelector("button").click()'); await frame()
    assert.equal(await run('creates.length'), 2)
    assert.equal(await run('creates[1].command'), 'saved-shell')
    assert.equal(await run('document.querySelector(".ghostty-terminal-problem")'), null)
    await run('unmount()')
    assert.deepEqual(await run('destroyed'), [1, 2])
    await run('update({workingDirectory:undefined,identity:{workspaceId:"workspace",paneId:"pane",tabId:"terminal-default"}})')
    await frame()
    assert.equal(await run('requests.at(-1).workingDirectory'), '/default-development', 'Persistence receives the resolved default directory')
    assert.equal(await run('creates.at(-1).workingDirectory'), '/default-development')
    assert.equal(await run('creates.at(-1).command'), 'saved-shell')
    await run('unmount();registration.dispose();update({identity:{workspaceId:"workspace",paneId:"pane",tabId:"terminal-plain"}})')
    await frame()
    assert.equal(await run('creates.at(-1).workingDirectory'), '/default-development', 'Ordinary terminals use the same default')
    assert.equal(await run('creates.at(-1).command'), 'ordinary-shell')
    await run('unmount()')
    console.log('Terminal launch, disposal, retry, and responsive UI checks passed')
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
