const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'workspace-chat-creation.tsx', loader: 'tsx', contents: `
      import React,{useEffect,useRef} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import layoutPlugin from './program/plugins/workspace-layout.client';
      import sidebarPlugin from './program/plugins/sidebar.client';
      const project={id:'atlas',name:'Atlas',primaryRoot:'/repo/atlas',roots:['/repo/atlas']};
      const original={id:'working',title:'Agent is working',preview:'',cwd:project.primaryRoot,createdAt:1,updatedAt:1,projectId:project.id};
      let saved={version:2,activeViewId:'working-tab',views:[{id:'working-tab',name:original.title,workspace:original.cwd,projectId:project.id,
        focusedPaneId:'working-pane',root:{type:'pane',id:'working-pane',workspace:original.cwd,projectId:project.id,thread:original}}]};
      localStorage.setItem('codex-cordis.workspace-layout',JSON.stringify(saved));
      const state={connected:true,session:{workspace:original.cwd,permissionMode:'ask'},projects:[project],threads:[original],threadId:original.id,
        activeProjectId:project.id,projectScope:'workspace',skills:[],turn:{tag:'running'},activities:[],history:{tag:'loading',entries:[]},
        harness:{extensions:{'session.workspace':'/tmp/alto-scratch'},codex:{status:'ready',models:[]},ui:{surfaces:[],contributions:[],regions:[]}}};
      const globalSession={snapshot:()=>state,subscribe:()=>()=>{},newThread:()=>{throw Error('Replaced the working chat')},openThread:()=>{throw Error('Replaced the working chat')}};
      const host={snapshot:()=>({connectionEpoch:1}),subscribe:()=>()=>{},call:async(method,payload)=>{
        if(method.endsWith('.read'))return structuredClone(saved);
        if(method.endsWith('.write'))saved=structuredClone(payload);
      }};
      const surfaces=new Map(),sessions=[];let registry,layoutRoot;
      const Composer=({autoFocus,session})=>{const input=useRef(null);useEffect(()=>{if(autoFocus)input.current.focus()},[autoFocus]);
        return <textarea ref={input} data-testid="draft" aria-label="Chat draft" defaultValue={session.snapshot().threadId==='working'?'Keep my running-chat draft':''}/>};
      const Conversation=({session})=><p>{session.snapshot().threadId==='working'?'Agent is still working':'New conversation'}</p>;
      const ui={subscribe:()=>()=>{},snapshot:()=>0,component:id=>id==='chat.composer'?Composer:id==='chat.conversation'?Conversation:undefined,
        renderer:()=>()=>null,contributionRenderer:()=>undefined,overlays:{closeAll:()=>{},open:()=>{},close:()=>{}},
        registerSurface:(_owner,id,component)=>surfaces.set(id,component),registerRoot:()=>{},registerStyle:(_owner,id,css)=>{
          const el=document.createElement('style');el.textContent=css;document.head.append(el)}};
      const ctx={provide:(_name,value)=>{registry=value},clientHost:host,clientUi:ui,clientSession:globalSession,
        clientSessionRouter:{globalSession:()=>globalSession,setActive:()=>{},clearActive:()=>{}},
        get:()=>undefined,on:()=>()=>{},clientSessionFactory:{create:options=>{
          let snapshot={...state,threads:[],threadId:undefined,turn:{tag:'idle'},session:{...state.session,workspace:options.initialWorkspace},
            activeProjectId:options.initialProjectId??undefined,projectScope:options.initialProjectId?'workspace':'unscoped'};
          const listeners=new Set();const update=next=>{snapshot={...snapshot,...next};for(const fn of listeners)fn()};
          const session={snapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
            openThread:async thread=>update({threadId:thread.id,threads:[thread],turn:{tag:'running'}}),
            selectProject:project=>update({activeProjectId:project.id,projectScope:'workspace'}),
            start:()=>{const thread={...original,id:'new-chat',title:'Just created',projectId:snapshot.activeProjectId};update({threadId:thread.id,threads:[thread]})}};
          sessions.push(session);return {session,dispose:()=>listeners.clear()};
        }}};
      layoutPlugin(ctx);const workspace=registry;
      const sidebarCleanup=sidebarPlugin({...ctx,provide:()=>{},clientWorkspaceLayout:workspace},{});
      const Layout=surfaces.get('workspace-layout'),History=surfaces.get('default-history'),New=surfaces.get('default-new-thread');
      const sidebarRoot=createRoot(document.getElementById('sidebar'));
      flushSync(()=>sidebarRoot.render(<><New surface={{id:'default-new-thread',kind:'button',label:'New chat'}}/><History surface={{id:'default-history',kind:'history',label:'Chats'}}/></>));
      window.mountLayout=()=>{layoutRoot=createRoot(document.getElementById('layout'));flushSync(()=>layoutRoot.render(<Layout/>))};
      window.unmountLayout=()=>flushSync(()=>layoutRoot.unmount());
      window.click=selector=>flushSync(()=>document.querySelector(selector).click());
      window.startNewest=()=>flushSync(()=>sessions.at(-1).start());
      window.inspect=()=>({tabs:workspace.tabs(),saved,turn:state.turn.tag,history:state.history.entries,
        error:document.querySelector('[role=alert]')?.textContent,rows:[...document.querySelectorAll('.history-entry')].map(el=>el.textContent)});
      window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      window.teardown=()=>{window.unmountLayout();flushSync(()=>sidebarRoot.unmount());sidebarCleanup();workspace.dispose()};
      window.mountLayout();
    ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all(['src/client/styles.css', 'program/plugins/ui/default.css', 'program/plugins/theme.css'].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => response.end('<!doctype html><style>' + css + '#root{display:flex;height:100vh}#sidebar{width:246px;flex:none;padding:12px;display:flex;flex-direction:column}#sidebar .conversation-history{flex:1;min-height:0}#layout{flex:1;min-width:0}textarea[data-testid=draft]{width:90%;min-height:80px;margin:16px}</style><div id="root"><aside id="sidebar"></aside><main id="layout"></main></div>'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => {
    if (event.level === 'error') console.error(event.message)
  })
  const run = code => win.webContents.executeJavaScript(code).catch(error => {
    throw Error(code.slice(0, 200) + '\n' + error.stack)
  })
  const projectButton = '[aria-label="New chat in Atlas"]'
  const newChatButton = '[aria-label="New chat"]'
  const click = selector => run(`click(${JSON.stringify(selector)})`)
  const until = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await run(expression)) return
      await run('frame()')
    }
    throw Error('Timed out: ' + expression + ' ' + JSON.stringify(await run('inspect()')))
  }
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}`)
    const bootProblem = await run(`(()=>{try{${bundle.outputFiles[0].text};return null}catch(error){return error.stack}})()`)
    assert.equal(bootProblem, null)
    await until('inspect().tabs[0]?.threadIds.includes("working")')
    await run('window.originalDraft=document.querySelector("textarea[data-testid=draft]")')
    assert.equal((await run('inspect()')).turn, 'running')
    assert.equal(await run(`document.querySelector(${JSON.stringify(projectButton)}).disabled`), false)
    await click(projectButton)
    await until('inspect().tabs.length===2 && document.activeElement.matches("textarea[data-testid=draft]")')
    assert.equal((await run('inspect()')).saved.views.at(-1).root.projectId, 'atlas')
    assert.equal((await run('inspect()')).saved.views.at(-1).root.workspace, '/repo/atlas')
    assert.ok(await run('originalDraft.isConnected && originalDraft.value==="Keep my running-chat draft" && document.activeElement!==originalDraft'))
    await run('startNewest()')
    await until('inspect().rows.some(text=>text.includes("Just created"))')
    assert.ok(await run('[...document.querySelectorAll(".history-entry")].some(el=>el.textContent.includes("Just created")&&el.getBoundingClientRect().height>0)'), 'New history rows must be visible')
    assert.deepEqual((await run('inspect()')).history, [], 'Pane history appears before the global list is refreshed')
    assert.equal((await run('inspect()')).tabs[0].threadIds[0], 'working')
    await click(newChatButton)
    await until('inspect().tabs.length===3')
    assert.equal((await run('inspect()')).saved.views.at(-1).root.unscoped, true)
    assert.equal((await run('inspect()')).turn, 'running')
    if (process.env.ALTO_CHAT_ARTIFACT_DIR) {
      await run('frame()')
      await fs.mkdir(process.env.ALTO_CHAT_ARTIFACT_DIR, { recursive: true })
      await fs.writeFile(path.join(process.env.ALTO_CHAT_ARTIFACT_DIR, 'new-chat-history.png'), (await win.webContents.capturePage()).toPNG())
    }
    await run('unmountLayout()')
    await click(projectButton)
    assert.equal((await run('inspect()')).error, 'Workspace tabs are not ready. Try again in a moment.')
    await run('mountLayout()')
    await until('inspect().tabs.length>0')
    const restoredCount = (await run('inspect()')).tabs.length
    await click(projectButton)
    await until(`!inspect().error && inspect().tabs.length===${restoredCount + 1}`)
    await run('teardown()')
    console.log('Workspace chat creation checks passed')
  } finally {
    win.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
