const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'agents-fixture.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {AgentsChrome} from './program/plugins/orchestrator.client';
      import {AgentsPanelController} from './program/plugins/orchestrator-panel';

      const listeners=new Set();
      const agent=(id,status,parentThreadId='parent')=>({id,threadId:id,status,parentThreadId,parentTitle:parentThreadId,
        title:id,workspace:'/repo',activity:'',result:'',createdAt:1,updatedAt:1});
      const tasks=[...Array.from({length:88},(_,i)=>agent('historical-'+i,'unknown')),
        agent('finished','done'),agent('failed','failed'),agent('stopped','stopped'),
        agent('Working on a long task title that should truncate in the narrow panel','working'),
        agent('Waiting for your reply','waiting','finished'),agent('Other chat','starting','other')];
      let monitor={revision:1,tasks};
      let state={connected:true,snapshot:{extensions:{orchestrator:monitor}}};
      const host={subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},snapshot:()=>state,call:async()=>({})};
      let overlay;
      const overlayListeners=new Set();
      const overlays={snapshot:()=>overlay,subscribe:fn=>{overlayListeners.add(fn);return()=>overlayListeners.delete(fn)},
        open:id=>{overlay=id;for(const fn of overlayListeners)fn()},close:id=>{if(overlay===id){overlay=undefined;for(const fn of overlayListeners)fn()}}};
      const ui={subscribe:()=>()=>{},snapshot:()=>0,overlays};
      const session={subscribe:()=>()=>{},snapshot:()=>({threadId:'parent'})};
      const markdownState={codeBlocks:[],fileLinks:[]};
      const markdown={subscribe:()=>()=>{},snapshot:()=>markdownState};
      const controller=new AgentsPanelController(overlays,'orchestrator-panel');
      overlays.subscribe(controller.syncOverlay);
      flushSync(()=>createRoot(document.getElementById('root')).render(<AgentsChrome {...{host,ui,session,markdown,controller}}/>));
      window.toggleShortcut=()=>flushSync(()=>controller.toggleTemporary());
      window.setMonitor=(tasks,error)=>flushSync(()=>{
        monitor={revision:monitor.revision+1,tasks,error};state={...state,snapshot:{extensions:{orchestrator:monitor}}};for(const fn of listeners)fn();
      });
      window.restoreTasks=()=>window.setMonitor(tasks);
      window.allTasks=tasks;
      window.clickLabel=label=>flushSync(()=>[...document.querySelectorAll('button')].find(button=>button.textContent===label||button.getAttribute('aria-label')===label).click());
      window.observe=()=>{
        const bounds=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height}};
        const panel=document.querySelector('.agents-panel');
        return {open:panel.getAttribute('aria-hidden')==='false',toggle:document.querySelector('.agents-toggle').getAttribute('aria-label'),
          rows:[...document.querySelectorAll('.agent-task-title')].map(el=>el.textContent),text:panel.textContent,
          panel:bounds(panel),close:bounds(panel.querySelector('[aria-label="Close agents"]')),header:bounds(document.querySelector('.workspace-pane-header')),
          width:innerWidth,height:innerHeight};
      };
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all([
    'src/client/pane-toolbar.css', 'src/client/styles.css', 'program/plugins/theme.css', 'program/plugins/ui/default.css', 'program/plugins/orchestrator.css',
  ].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => response.end(`<!doctype html><style>${css}
    body{margin:0}.shell-kernel{display:flex;flex-direction:column;height:100vh}
    .workspace-tabbar{height:52px;flex-shrink:0;display:flex;justify-content:flex-end;align-items:center;padding:0 12px}
    .workspace-pane-header{height:36px;display:flex;align-items:center;padding:0 12px}
    </style><body><main class="shell-kernel"><header class="workspace-tabbar"><div data-ui-contribution="orchestrator-toggle"></div></header>
    <div class="workspace-views"><div class="workspace-view"><header class="workspace-pane-header">Parent chat</header><textarea aria-label="Composer"></textarea></div></div><div id="root"></div></main></body>`))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const run = code => window.webContents.executeJavaScript(code)
  const settle = () => run('new Promise(resolve=>setTimeout(resolve,300))')
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await settle()
    assert.equal((await run('observe()')).open, false)
    for (const width of [1000, 360]) {
      window.setContentSize(width, 760)
      window.webContents.sendInputEvent({ type: 'mouseMove', x: width - 1, y: 200 })
      await settle()
      const hidden = await run('observe()')
      assert.equal(hidden.open, false, 'Hovering the right edge must not open Agents')
      assert.equal(hidden.toggle, 'Agents, 3 active, needs attention')
      await run("document.querySelector('.agents-toggle').click()")
      await settle()
      const visible = await run('observe()')
      assert.equal(visible.open, true)
      assert.equal(visible.rows.length, 2, 'Only current agents in this chat belong in the list')
      assert.ok(!visible.text.includes('historical-') && !visible.text.includes('History'))
      assert.deepEqual(visible.header, hidden.header, 'Opening Agents must not change the pane header')
      for (const rect of [visible.panel, visible.close]) {
        assert.ok(rect.left >= 0 && rect.right <= width && rect.top >= visible.header.bottom && rect.bottom <= visible.height, JSON.stringify(visible))
      }
      if (process.env.ALTO_AGENTS_ARTIFACT_DIR) {
        await fs.mkdir(process.env.ALTO_AGENTS_ARTIFACT_DIR, { recursive: true })
        await fs.writeFile(path.join(process.env.ALTO_AGENTS_ARTIFACT_DIR, `agents-${width}.png`), (await window.webContents.capturePage()).toPNG())
      }
      await run("clickLabel('All chats')")
      assert.equal((await run('observe()')).rows.length, 3)
      await run("clickLabel('This chat');clickLabel('Close agents')")
      await settle()
    }
    await run('toggleShortcut()')
    await settle()
    assert.equal((await run('observe()')).open, true)
    await run("document.querySelector('.agents-panel').dispatchEvent(new PointerEvent('pointerleave'));document.querySelector('[aria-label=Composer]').focus()")
    await settle()
    assert.equal((await run('observe()')).open, true, 'Moving away must not dismiss a deliberately opened panel')
    await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
    assert.equal((await run('observe()')).open, false)
    await run("setMonitor(allTasks.filter(task=>task.status==='unknown'||task.status==='done'));document.querySelector('.agents-toggle').click()")
    await settle()
    const empty = await run('observe()')
    assert.equal(empty.toggle, 'Agents')
    assert.deepEqual(empty.rows, [])
    assert.ok(empty.text.includes('No active subagents in this chat'))
    await run("setMonitor(allTasks,'Reconnecting…')")
    const offline = await run('observe()')
    assert.equal(offline.toggle, 'Agents')
    assert.deepEqual(offline.rows, [])
    assert.ok(offline.text.includes('Agent status unavailable'))
    console.log('Agents browser checks passed')
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
    app.quit()
  }
}
check().catch(error => { console.error(error); app.exit(1) })
