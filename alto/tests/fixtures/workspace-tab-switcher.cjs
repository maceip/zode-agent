const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'switcher-check.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import plugin from './program/plugins/workspace-tab-switcher.client';
      import workspaceHotkeys from './program/plugins/hotkeys-workspace.client';
      import {HotkeysService} from './program/plugins/hotkeys.client';
      let tabs=['Current project', 'Review a very long workspace title that should truncate cleanly', 'Finished work', 'Another project'].map((title,i)=>({id:String(i),title,active:i===0,threadIds:[String(i)]}));
      let overlay; const overlayListeners=new Set(); const layoutListeners=new Set(); const cleanup=[];
      const overlays={snapshot:()=>overlay,open:id=>{overlay=id;for(const fn of overlayListeners) fn()},close:id=>{if(overlay===id){overlay=undefined;for(const fn of overlayListeners) fn()}},subscribe:fn=>{overlayListeners.add(fn);return()=>overlayListeners.delete(fn)}};
      const ui={overlays,registerRoot:(_owner,_id,Root)=>{const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<Root/>));cleanup.push(()=>root.unmount())},registerStyle:(_owner,_id,css)=>{const style=document.createElement('style');style.textContent=css;document.head.append(style);cleanup.push(()=>style.remove())}};
      const selectTab=index=>{tabs=tabs.map((tab,i)=>({...tab,active:i===index}));for(const fn of layoutListeners) fn()};
      const layout=new Proxy({tabs:()=>tabs,available:()=>true,selectTab,cycleTabs:direction=>selectTab((tabs.findIndex(t=>t.active)+direction+tabs.length)%tabs.length),subscribe:fn=>{layoutListeners.add(fn);return()=>layoutListeners.delete(fn)}},{get:(target,key)=>target[key]??(()=>false)});
      const status={revision:0,running:['1'],finished:['2']};
      const threadStatus={snapshot:()=>status,subscribe:()=>()=>{}};
      const hotkeys=new HotkeysService(ui,{leader:'Alt'});
      const ctx={clientUi:ui,clientWorkspaceLayout:layout,clientHotkeys:hotkeys,get:name=>name==='clientThreadStatus'?threadStatus:undefined,on:()=>()=>{},effect:fn=>{const dispose=fn();cleanup.push(dispose);return dispose}};
      workspaceHotkeys(ctx);
      plugin(ctx,{});
      window.key=(type,key,mods={})=>flushSync(()=>document.activeElement.dispatchEvent(new KeyboardEvent(type,{key,code:key==='Alt'?'AltLeft':key,bubbles:true,cancelable:true,...mods})));
      window.state=()=>({active:tabs.find(t=>t.active).id,selected:document.querySelector('[role=option][aria-selected=true]')?.id,open:!!document.querySelector('[role=dialog]'),focused:document.activeElement.id,overlay});
      window.teardown=()=>{for(const dispose of cleanup.reverse())dispose?.();hotkeys.dispose()};
      document.getElementById('draft').focus();
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all(['src/client/styles.css', 'program/plugins/theme.css', 'program/plugins/thread-status.css'].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => response.end('<!doctype html><style>' + css + '</style><body style="background:var(--canvas)"><input id="draft" aria-label="Draft" value="untouched draft"><p>Conversation remains behind the floating switcher.</p><div id="root"></div></body>'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const run = code => window.webContents.executeJavaScript(code)
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await run("key('keydown','Alt',{altKey:true});key('keydown','Tab',{altKey:true});key('keyup','Tab',{altKey:true})")
    assert.deepEqual(await run('({active:state().active, selected:state().selected})'), { active: '0', selected: 'recent-tab-1' })
    await run("key('keydown','Tab',{altKey:true});key('keyup','Tab',{altKey:true})")
    assert.equal((await run('state()')).selected, 'recent-tab-2')
    await run("key('keyup','Alt')")
    assert.equal((await run('state()')).active, '2')
    assert.equal((await run('state()')).open, false)
    await run("document.getElementById('draft').focus();key('keydown','Tab',{altKey:true});key('keydown','Escape')")
    assert.equal((await run('state()')).active, '2')
    assert.equal((await run('state()')).focused, 'draft')
    // Ctrl+Tab still follows physical tab order, with no MRU popup.
    await run("key('keydown','Tab',{ctrlKey:true})")
    assert.equal((await run('state()')).active, '3')
    assert.equal((await run('state()')).open, false)
    await run("key('keydown','Tab',{altKey:true,shiftKey:true})")
    assert.equal((await run('state()')).selected, 'recent-tab-1')
    await run("key('keydown','Escape');key('keydown','Tab',{altKey:true})")
    for (const theme of ['light', 'dark']) {
      for (const width of [1100, 360]) {
        window.setContentSize(width, 760)
        await run(`document.documentElement.dataset.altoTheme='${theme}'`)
        await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        const metrics = await run(`(()=>{const p=document.querySelector('[role=dialog]'),r=p.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,scroll:document.documentElement.scrollWidth,footer:!!p.querySelector('footer'),header:!!p.querySelector('header'),spinners:p.querySelectorAll('[data-thread-status=running]').length,dots:p.querySelectorAll('[data-thread-status=finished]').length,current:!!p.querySelector('[aria-current=page]'),background:getComputedStyle(p).backgroundColor,backdrop:getComputedStyle(p).backdropFilter}})()`)
        assert.ok(metrics.left >= 0 && metrics.right <= metrics.width, JSON.stringify(metrics))
        assert.equal(metrics.width, width)
        assert.ok(metrics.scroll <= metrics.width)
        assert.equal(metrics.header, false)
        assert.equal(metrics.footer, false)
        assert.equal(metrics.spinners, 1)
        assert.equal(metrics.dots, 1)
        assert.equal(metrics.current, true)
        assert.equal(await run("getComputedStyle(document.querySelector('[aria-current=page]')).boxShadow"), 'none')
        assert.notEqual(metrics.backdrop, 'none')
        if (process.env.ALTO_SWITCHER_ARTIFACT_DIR) {
          await fs.mkdir(process.env.ALTO_SWITCHER_ARTIFACT_DIR, { recursive: true })
          const screenshot = await window.webContents.capturePage()
          await fs.writeFile(path.join(process.env.ALTO_SWITCHER_ARTIFACT_DIR, `${theme}-${width}.png`), screenshot.toPNG())
        }
      }
    }
    await run('teardown()')
    assert.equal((await run('state()')).open, false)
    await run("key('keydown','Tab',{altKey:true})")
    assert.equal((await run('state()')).open, false)
    assert.equal(await run("document.getElementById('draft').value"), 'untouched draft')
    console.log('Workspace tab switcher browser checks passed')
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
