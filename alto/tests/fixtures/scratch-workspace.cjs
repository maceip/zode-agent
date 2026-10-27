const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const http = require('node:http')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'scratch-check.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import plugin from './program/plugins/workspace-layout.client';
      import {SessionService} from './program/plugins/session.client';
      import {parseWorkspaceLayout,WORKSPACE_LAYOUT_READ_METHOD,WORKSPACE_LAYOUT_WRITE_METHOD} from './program/plugins/workspace-layout-state';
      const project={id:'alto',name:'Alto',primaryRoot:'/app/alto',roots:['/app/alto'],source:'manual'};
      const thread={id:'saved-thread',title:'Saved chat',preview:'',cwd:'/work/saved',createdAt:1,updatedAt:1};
      const pane=(id,workspace,extra)=>({id,name:id,workspace,focusedPaneId:'pane-'+id,
        ...extra,root:{type:'pane',id:'pane-'+id,workspace,...extra}});
      let saved={version:2,activeViewId:'project',views:[
        pane('empty','/app/alto',{unscoped:true}),
        pane('project','/app/alto',{projectId:project.id}),
        pane('saved',thread.cwd,{unscoped:true,thread}),
      ]};
      localStorage.setItem('codex-cordis.workspace-layout',JSON.stringify(saved));
      const harness={
        codex:{status:'stopped',models:[],activeThreadIds:[],threadStates:{},threadSettings:{}},
        program:{revision:0,profileText:'',plugins:[],files:[],tools:[],proposals:[]},
        projects:{revision:0,projects:[project]},ui:{regions:[],surfaces:[],contributions:[]},
        extensions:{'session.workspace':'/home/test/.alto/scratch'},pendingRequests:[],
        server:{projectRoot:'/app/alto',host:'127.0.0.1',port:4317},
      };
      const hostState={revision:0,connectionEpoch:1,connection:'online',connected:true,snapshot:harness};
      const host={subscribe:()=>()=>{},onEvent:()=>()=>{},snapshot:()=>hostState,
        command:async(type)=>{
          if(type==='thread.open')return {summary:thread,messages:[]};
          return [];
        },
        call:async(method,payload)=>{
          if(method===WORKSPACE_LAYOUT_READ_METHOD)return structuredClone(saved);
          if(method===WORKSPACE_LAYOUT_WRITE_METHOD){saved=parseWorkspaceLayout(payload);return null;}
          return null;
        }};
      const sessions=new Set();
      const factory={create:options=>{
        const session=new SessionService(host,{...options,restoreActiveThread:false,persistActiveThread:false});
        sessions.add(session);
        return {session,dispose:()=>{sessions.delete(session);session.dispose()}};
      }};
      const globalSession=new SessionService(host,{initialWorkspace:project.primaryRoot,initialProjectId:project.id,restoreActiveThread:false});
      let Surface,root;
      const Placeholder=()=>null;
      const ui={subscribe:()=>()=>{},snapshot:()=>0,component:()=>Placeholder,renderer:()=>undefined,contributionRenderer:()=>undefined,
        overlays:{open:()=>{},close:()=>{}},registerSurface:(_owner,_id,component)=>{Surface=component},
        registerStyle:(_owner,_id,css)=>{const style=document.createElement('style');style.textContent=css;document.head.append(style)}};
      plugin({provide:()=>{},clientUi:ui,clientHost:host,clientSession:globalSession,
        clientSessionRouter:{setActive:()=>{},clearActive:()=>{}},clientSessionFactory:factory});
      const boot=()=>{root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<Surface/>))};
      window.inspect=()=>({saved:structuredClone(saved),sessions:[...sessions].map(session=>{
        const state=session.snapshot();return {workspace:state.session.workspace,threadId:state.threadId,projectId:state.activeProjectId};
      })});
      window.newTab=()=>flushSync(()=>document.querySelector('.workspace-tab-add').click());
      window.projectTab=()=>{
        flushSync(()=>document.querySelector('.workspace-tab-add').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})));
        flushSync(()=>[...document.querySelectorAll('.workspace-project-picker button')].find(button=>button.querySelector('strong').textContent==='Alto').click());
      };
      window.reload=()=>{flushSync(()=>root.unmount());boot()};
      window.teardown=()=>{flushSync(()=>root.unmount());globalSession.dispose()};
      boot();
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const server = http.createServer((_request, response) => {
    response.end('<!doctype html><div id="root"></div>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, width: 1200, height: 760, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const run = code => window.webContents.executeJavaScript(code)
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await run('inspect()')
      if (predicate(state)) return state
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Workspace did not settle: ' + JSON.stringify(await run('inspect()')))
  }
  const scratch = '/home/test/.alto/scratch'
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    const restored = await waitFor(state => state.sessions.some(session => session.threadId === 'saved-thread')
      && state.saved.views.find(view => view.id === 'empty').root.workspace === scratch)
    assert.equal(restored.saved.views.find(view => view.id === 'project').root.workspace, '/app/alto')
    assert.equal(restored.saved.views.find(view => view.id === 'saved').root.workspace, '/work/saved')
    assert.ok(restored.sessions.some(session => session.workspace === '/app/alto' && session.projectId === 'alto'))

    await run('newTab()')
    const added = await waitFor(state => state.saved.views.length === 4 && state.sessions.length === 4)
    assert.equal(added.saved.views.at(-1).root.workspace, scratch)
    assert.equal(added.saved.views.at(-1).root.unscoped, true)
    assert.equal(added.sessions.at(-1).workspace, scratch)
    assert.equal(added.sessions.at(-1).projectId, undefined)

    await run('projectTab()')
    const selected = await waitFor(state => state.saved.views.length === 5 && state.sessions.length === 5)
    assert.equal(selected.saved.views.at(-1).root.workspace, '/app/alto')
    assert.equal(selected.sessions.at(-1).projectId, 'alto')

    await run('reload()')
    const reloaded = await waitFor(state => state.sessions.length === 5 && state.sessions.some(session => session.threadId === 'saved-thread'))
    assert.equal(reloaded.sessions.filter(session => session.workspace === scratch).length, 2)
    assert.equal(reloaded.sessions.filter(session => session.workspace === '/app/alto').length, 2)
    assert.equal(reloaded.sessions.find(session => session.threadId === 'saved-thread').workspace, '/work/saved')
    await run('teardown()')
    console.log('Scratch workspace browser checks passed')
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
