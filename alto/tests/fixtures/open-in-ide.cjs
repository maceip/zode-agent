const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'ide-fixture.tsx', loader: 'tsx', contents: `
      import React, {useSyncExternalStore} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {BrowserProgramRuntime} from './src/client/plugin-runtime';
      import composer from './program/plugins/composer.client';
      import ide from './program/plugins/open-in-ide.client';
      import {EditorPanes} from './program/plugins/editor-pane.client';
      import editorHotkeys from './program/plugins/hotkeys-editor.client';
      import {HotkeysService} from './program/plugins/hotkeys.client';
      import {COMPOSER_COMPONENT} from './program/plugins/chat-surfaces-api';
      const root=createRoot(document.getElementById('root'));
      const listeners=new Set();
      let state={connected:true,harness:{codex:{status:'ready',models:[]}},projects:[],
        session:{workspace:'/repo/pane-a',permissionMode:'full'},threadId:'pane-a',
        providerId:'codex',providers:[{id:'codex',label:'Codex',location:{kind:'local'}}],
        turn:{tag:'running'},skills:[],activities:[],canAcceptDirectInput:true,projectScope:'workspace'};
      const session={snapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}};
      const work={threadTargets:{'pane-a':{kind:'local',location:'/repo/worktree-a'}}};
      const contexts={snapshot:()=>work,subscribe:()=>()=>{}};
      let held, fail=false;
      window.calls=[];
      const host={snapshot:()=>({}),subscribe:()=>()=>{},call:async(method,payload)=>{
        calls.push({method,payload});if(fail)throw new Error('Could not open the IDE.');
        await new Promise(resolve=>held=resolve);
      }};
      window.paneCalls=[];
      const layout={available:()=>true,tabs:()=>[{id:'workspace-a',active:true}],
        paneTargets:()=>[{workspaceId:'workspace-a',paneId:'chat-a',session,focused:true}],
        focusPane:()=>true,openPane:request=>{paneCalls.push(request);return {workspaceId:'workspace-a',paneId:'editor-'+paneCalls.length}}};
      const editors=new EditorPanes(layout,contexts);
      const provider=ctx=>{
        ctx.provide('clientSession',session);ctx.provide('clientWorkContexts',contexts);ctx.provide('clientEditor',editors);
        const hotkeys=new HotkeysService(ctx.clientUi,{leader:'Alt'});
        ctx.provide('clientHotkeys',hotkeys);ctx.effect(()=>()=>hotkeys.dispose());
      };
      provider.inject=['clientUi'];
      provider.provide=['clientSession','clientWorkContexts','clientEditor','clientHotkeys'];
      const runtime=new BrowserProgramRuntime(async url=>({default:url==='/composer'?composer:url==='/ide'?ide:url==='/editor-hotkeys'?editorHotkeys:provider}),host);
      const view=id=>({id,name:id,description:'IDE fixture',protocolVersion:1,depth:0,enabled:true,effectiveEnabled:true,
        state:'active',inject:[],provides:[],config:id==='ide'?{ide:'cursor'}:{},isolate:{},intercept:{},
        client:{module:id+'.ts',hash:'1',url:'/'+id,loadedAt:''}});
      let enabled=true, revision=0, settings=false;
      function Page(){
        useSyncExternalStore(runtime.ui.subscribe,runtime.ui.snapshot);
        const Composer=runtime.ui.component(COMPOSER_COMPONENT);
        const Settings=runtime.ui.settingsPages().find(p=>p.id==='open-in-ide')?.renderer;
        return <main style={{height:'100vh',display:'flex',flexDirection:'column',containerType:'inline-size',containerName:'conversation-column'}}>
          <div style={{flex:1,padding:24}}>{settings&&Settings?<Settings/>:'Conversation'}</div>
          {Composer&&<Composer surface={{id:'default-composer',kind:'composer',capabilities:['files']}}
            session={session} draftStore={{read:()=>({message:'',images:[],attachments:[]}),write:()=>{}}}/>}</main>;
      }
      window.render=()=>flushSync(()=>root.render(<Page/>));
      window.toggle=async value=>{enabled=value;await runtime.reconcile(++revision,
        [view('session'),view('composer'),view('editor-hotkeys'),...(enabled?[view('ide')]:[])]);render()};
      window.update=next=>flushSync(()=>{state={...state,...next};for(const fn of listeners)fn()});
      window.showSettings=()=>{settings=true;render()};
      window.finish=()=>held?.();
      window.setFailure=()=>{fail=true};
      window.button=()=>document.querySelector('.open-in-ide-button');
      window.click=()=>{button().click()};
      window.geometry=()=>{
        const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,height:r.height}};
        return {composer:rect('.composer'),button:rect('.open-in-ide-button'),context:rect('.composer-context-controls'),
          model:rect('.composer-model-control'),send:rect('.send-button'),overflow:document.body.scrollWidth>innerWidth};
      };
      window.teardown=async()=>{root.unmount();await runtime.dispose()};
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all(['src/client/styles.css','program/plugins/ui/default.css','program/plugins/theme.css']
    .map(file=>fs.readFile(file,'utf8')))).join('\n').replace(/@import[^;]+;/g,'')
  const server=http.createServer((_,res)=>res.end('<!doctype html><style>'+css+'</style><div id="root"></div>'))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const window=new BrowserWindow({show:false,width:1000,height:520,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}})
  const run=code=>window.webContents.executeJavaScript(code)
  const paint=()=>run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await run('toggle(true)')
    await run('click();click()'); await paint()
    assert.equal((await run('paneCalls')).length,1,'Repeated editor clicks reuse the opening pane')
    assert.deepEqual((await run('paneCalls'))[0],{
      kind:'editor',direction:'horizontal',workspace:'/repo/worktree-a',anchor:{workspaceId:'workspace-a',paneId:'chat-a'},anchorThreadId:'pane-a',
    })
    assert.equal((await run('calls')).length,0,'The pane choice never launches an external app')
    await run('showSettings()')
    await run(`const destination=document.querySelector('[aria-label="Editor button destination"]');destination.value='external';destination.dispatchEvent(new Event('change',{bubbles:true}))`)
    await paint()
    await run('click();click()')
    assert.equal((await run('calls')).length,1,'Repeated clicks do not spawn duplicate windows')
    assert.deepEqual((await run('calls'))[0],{method:'open-in-ide.open',payload:{ide:'cursor',workspace:'/repo/worktree-a',remote:false,threadId:'pane-a'}})
    await run('finish()');await paint()
    await run("update({threadId:'pane-b',session:{workspace:'/repo/pane-b',permissionMode:'full'}})")
    await run('click()')
    assert.equal((await run('calls'))[1].payload.workspace,'/repo/pane-b')
    await run('finish()');await paint()
    await run("update({remoteLocation:'remote-host'})")
    assert.equal(await run('button().disabled'),true)
    await run("update({remoteLocation:undefined,projectScope:'unscoped'})")
    assert.equal(await run('button().disabled'),true)
    await run("update({projectScope:'workspace'})")
    await run(`const select=document.querySelector('[aria-label="Preferred IDE"]');select.value='zed';select.dispatchEvent(new Event('change',{bubbles:true}))`)
    await paint()
    assert.equal(await run('button().getAttribute("aria-label")'),'Open in Zed')
    const height=await run('document.querySelector(".composer").getBoundingClientRect().height')
    await run('toggle(false)');await paint()
    assert.equal(await run('button()'),null)
    assert.equal(await run('document.querySelector(".composer").getBoundingClientRect().height'),height)
    await run('toggle(true)');await paint()
    assert.equal(await run('button().getAttribute("aria-label")'),'Open in Zed')
    assert.equal(await run('document.querySelector("[data-cordis-composer-editor]").textContent'),'')
    for(const width of [1000,480,360]) {
      window.setContentSize(width,520)
      for(const theme of ['light','dark']) {
        await run(`document.documentElement.dataset.altoTheme='${theme}';document.documentElement.dataset.altoChrome='alto'`)
        await paint()
        const bounds=await run('geometry()')
        assert.equal(bounds.overflow,false,JSON.stringify({width,bounds}))
        assert.ok(bounds.button.x>=bounds.composer.x && bounds.button.right<=bounds.model.x,JSON.stringify({width,bounds}))
        assert.ok(bounds.send.right<=width,JSON.stringify({width,bounds}))
        assert.ok(bounds.button.bottom<=bounds.composer.bottom,JSON.stringify({width,bounds}))
        if(process.env.ALTO_IDE_ARTIFACT_DIR){
          await fs.mkdir(process.env.ALTO_IDE_ARTIFACT_DIR,{recursive:true})
          await fs.writeFile(path.join(process.env.ALTO_IDE_ARTIFACT_DIR,`ide-${width}-${theme}.png`),(await window.webContents.capturePage()).toPNG())
        }
      }
    }
    await run('setFailure();click()');await paint()
    assert.equal(await run('document.querySelector("[role=alert]").textContent.includes("Could not open")'),true)
    assert.equal(await run('button().disabled'),false)
    // Command-E always opens a pane, even with an external editor selected.
    await run("document.querySelector('[data-cordis-composer-editor]').dispatchEvent(new KeyboardEvent('keydown',{key:'e',metaKey:true,bubbles:true,cancelable:true}))")
    await paint()
    assert.equal((await run('paneCalls')).length,2)
    assert.equal((await run('paneCalls'))[1].workspace,'/repo/pane-b')
    assert.equal(await run(`document.querySelector('[aria-label="Editor button destination"]').value`),'external')
    await run('teardown()')
    console.log('Open in IDE browser checks passed')
  } finally {
    window.destroy()
    await new Promise(resolve=>server.close(resolve))
  }
}
check().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)})
