const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'todo-check.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import layoutPlugin from './program/plugins/workspace-layout.client';
      import groupsPlugin from './program/plugins/workspace-tab-groups.client';
      import todoPlugin from './program/plugins/todo.client';
      import {emptyTodo,applyTodo,findTodoChat,todoForProjects} from './program/plugins/todo-api';
      const thread={id:'chat-1',title:'Fix the search flow',cwd:'/repo',preview:'',createdAt:1,updatedAt:2,providerId:'claude-acp',projectId:'id-1'};
      let saved={version:2,activeViewId:'chat',views:[{id:'chat',name:'Search',workspace:'/repo',focusedPaneId:'pane-chat',root:{type:'pane',id:'pane-chat',workspace:'/repo',thread}}]};
      localStorage.setItem('codex-cordis.workspace-layout',JSON.stringify(saved));
      const projects=[{id:'id-1',name:'alpha'},{id:'id-2',name:'beta'},{id:'empty-1',name:'example-docs'},{id:'empty-2',name:'example-tools'},{id:'empty-3',name:'example-service'}];
      let doc=todoForProjects(emptyTodo(),projects), serial=2;
      for(const operation of [{type:'addItem',projectId:'id-1',text:'Review search flow'},{type:'addItem',projectId:'id-1',text:'Ship changes'},{type:'addItem',projectId:'id-2',text:'Plugin permissions'}]) doc=applyTodo(doc,operation,()=> 'id-'+ ++serial);
      const listeners=new Set(); let hostState={connectionEpoch:1,snapshot:{extensions:{todo:doc}}};
      let fail=false, revision=0, surface, registry, modal, root, overlays=new Set();
      const surfaces=new Map(), paneRenamers=new Set();
      const state={connected:true,session:{workspace:'/repo',permissionMode:'full'},projects:[],threads:[thread],skills:[],turn:{tag:'idle'},activities:[],history:{tag:'ready',entries:[]},harness:{extensions:{'session.workspace':'/tmp/alto-scratch'},server:{projectRoot:'/repo'},codex:{status:'ready',models:[]},ui:{surfaces:[{id:'todo-button',kind:'todo-button',data:{slot:'header-end'}}],contributions:[],regions:[]}}};
      const host={subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},snapshot:()=>hostState,call:async(method,payload)=>{
        if(method==='todo.apply') { if(fail)throw new Error('Disk unavailable'); doc=applyTodo(doc,payload,()=> 'id-'+ ++serial); if(payload.type==='renameChat'){const title=findTodoChat(doc,payload.threadId).chat.thread.title;for(const rename of paneRenamers)rename(payload.threadId,title)} hostState={...hostState,snapshot:{extensions:{todo:doc}}};for(const fn of listeners)fn();return doc; }
        if(method.endsWith('.read'))return structuredClone(saved);
        if(method.endsWith('.write')){saved=structuredClone(payload);return saved;}
      }};
      const session={snapshot:()=>state,subscribe:()=>()=>{}};
      let mounts=0;
      const Placeholder=()=>{React.useEffect(()=>{mounts++},[]);return <textarea aria-label="Chat draft" defaultValue="Unsent draft"/>};
      const Tool=()=>null;
      const ui={subscribe:()=>()=>{},snapshot:()=>revision,component:()=>Placeholder,renderer:s=>surfaces.get(s.id)??Tool,contributionRenderer:()=>undefined,
        overlays:{open:id=>overlays.add(id),close:id=>overlays.delete(id)},
        registerSurface:(owner,id,component)=>{surfaces.set(id,component);if(id==='workspace-layout')surface=component},
        registerRoot:(owner,id,component)=>{modal=component},
        registerStyle:(owner,id,css)=>owner.effect(()=>{const el=document.createElement('style');el.dataset.pluginStyle=id;el.textContent=css;document.head.append(el);return()=>el.remove()})};
      const effects=[];
      const owner={effect:fn=>{const cleanup=fn();effects.push(cleanup);return cleanup}};
      const ctx={...owner,provide:(_name,value)=>registry=value,clientUi:ui,clientHost:host,clientSession:session,
        clientSessionRouter:{setActive:()=>{},clearActive:()=>{}},clientSessionFactory:{create:()=>{
          const subs=new Set();let snap={...state,threadId:undefined};
          const paneSession={subscribe:fn=>{subs.add(fn);return()=>subs.delete(fn)},snapshot:()=>snap,openThread:async t=>{snap={...snap,threadId:t.id,threads:[t]};for(const fn of subs)fn()},newThread:()=>{},selectProject:()=>{}};
          const rename=(id,title)=>{snap={...snap,threads:snap.threads.map(t=>t.id===id?{...t,title}:t)};for(const fn of subs)fn()};paneRenamers.add(rename);
          return {session:paneSession,dispose:()=>{subs.clear();paneRenamers.delete(rename)}};
        }}};
      layoutPlugin(ctx);
      let groups=[];
      const enableGroups=()=>groupsPlugin({...ctx,clientWorkspaceLayout:registry,effect:fn=>{const cleanup=fn();groups.push(cleanup);return cleanup}});
      enableGroups();
      todoPlugin({...ctx,clientWorkspaceLayout:registry});
      window.boot=()=>{root=createRoot(document.getElementById('root'));const Surface=surface,Modal=modal;flushSync(()=>root.render(<><Surface surface={{id:'workspace-layout',kind:'workspace-layout'}}/><Modal/></>))};
      window.inspect=()=>({doc:structuredClone(doc),saved:structuredClone(saved),tabs:registry.tabs(),activePage:registry.activePage()?.id,mounts,overlays:[...overlays],available:registry.available()});
      window.click=selector=>flushSync(()=>{const el=document.querySelector(selector);if(!el)throw new Error('Missing '+selector);el.click()});
      window.textClick=(text,scope='button')=>flushSync(()=>{const el=[...document.querySelectorAll(scope)].find(el=>el.textContent.trim()===text);if(!el)throw new Error('Missing button '+text);el.click()});
      window.fill=(selector,value)=>flushSync(()=>{const el=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))});
      window.submit=selector=>flushSync(()=>document.querySelector(selector).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
      window.context=()=>flushSync(()=>{const el=document.querySelector('[data-workspace-tab=chat]'),b=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left+8,clientY:b.bottom}))});
      window.setFail=value=>{fail=value};
      window.linkedTask=()=>doc.projects.flatMap(project=>project.items).find(item=>item.chats.some(chat=>chat.thread.id==='chat-1'));
      window.renameTab=()=>flushSync(()=>registry.renameActiveTab());
      window.selectTab=id=>flushSync(()=>registry.selectTab(registry.tabs().findIndex(tab=>tab.id===id)));
      window.reproduceStaleNameBinding=()=>{
        window.teardown();
        const linked=saved.views.find(view=>view.nameBinding?.source==='todo');
        const unrelated={...linked,id:'unrelated-tab',focusedPaneId:'unrelated-pane',root:{type:'pane',id:'unrelated-pane',workspace:'/repo',thread:{...thread,id:'unrelated-chat',title:'Different work'}}};
        saved={...saved,views:[...saved.views,unrelated]};
        localStorage.setItem('codex-cordis.workspace-layout',JSON.stringify(saved));
        window.boot();
      };
      window.key=(selector,key)=>flushSync(()=>document.querySelector(selector).dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})));
      window.disableGroups=()=>flushSync(()=>{groups.reverse().forEach(fn=>fn());groups=[]});
      window.teardown=()=>flushSync(()=>root.unmount());
      window.reload=()=>{window.teardown();window.boot()};
      window.boot();
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all(['src/client/styles.css','program/plugins/ui/default.css','program/plugins/theme.css'].map(file=>fs.readFile(file,'utf8')))).join('\n').replace(/@import[^;]+;/g,'')
  const server=http.createServer((request,response)=>response.end('<!doctype html><style>'+css+'\n#root{height:100vh}</style><div id="root"></div>'))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const win=new BrowserWindow({show:false,width:1200,height:760,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}})
  const run=code=>win.webContents.executeJavaScript(code)
  const until=async expression=>{for(let i=0;i<100;i++){if(await run(expression))return;await new Promise(resolve=>setTimeout(resolve,20))}throw new Error('Timed out: '+expression+' '+JSON.stringify(await run('inspect()')))}
  const settle=()=>run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  try {
    await win.loadURL('http://127.0.0.1:'+server.address().port)
    await run(bundle.outputFiles[0].text)
    await until('inspect().available')
    await run("click('[aria-label=\"Tasks\"]')")
    await until("document.querySelector('[aria-label=\"Tasks list\"]')")
    assert.equal(await run("document.querySelector('.todo-project[aria-label=\"example-docs\"]')"),null,'Empty projects stay out of the task list until expanded')
    await run("click('.todo-other-toggle');click('[aria-label=\"New task in example-docs\"]')")
    assert.equal(await run("document.activeElement.getAttribute('aria-label')"),'Add a task to example-docs','An empty project can be opened directly for adding a task')
    await run("click('[aria-label=\"Collapse example-docs\"]');click('.todo-other-toggle')")
    assert.equal((await run('inspect()')).tabs.length,1)
    assert.equal(await run("[...document.querySelectorAll('button')].some(el=>el.textContent==='New project')"),false)
    await run("click('[aria-label=\"Tasks\"]')")
    assert.equal((await run('inspect()')).tabs.length,1,'Tasks never creates a tab')
    assert.equal((await run('inspect()')).activePage,undefined,'The button toggles back to chat')
    const before=await run('inspect().mounts')
    await run("click('[aria-label=\"Tasks\"]')")
    assert.equal(await run("[...document.querySelectorAll('[role=tabpanel]')].every(el=>el.hidden)"),true)
    assert.equal(await run("document.querySelector('[aria-label=\"Chat draft\"]').value"),'Unsent draft')
    await run("click('[data-workspace-tab=chat]')")
    assert.equal((await run('inspect()')).activePage,undefined,'Selecting a chat returns to it')
    assert.equal(await run('inspect().mounts'),before,'Changing views keeps chats mounted')
    await run("click('[aria-label=\"Tasks\"]')")
    await run("fill('[aria-label=\"Add a task to Unsorted\"]','Triage issue');submit('.todo-unsorted form')")
    await until("inspect().doc.projects.at(-1).items.length===1")
    await run("click('[aria-label=\"Complete Triage issue\"]')")
    await until("inspect().doc.projects.at(-1).items[0].done")
    await run("click('[aria-label=\"Close Tasks\"]')")
    await until('inspect().tabs.length===1')
    await run('context()')
    await run("textClick('Move to Tasks…')")
    await until("document.querySelector('[aria-label=\"Filter destinations\"]')")
    assert.equal(await run("document.querySelector('.todo-destinations button[aria-pressed=true]').textContent"),'alpha')
    await run("setFail(true);textClick('Move chat')")
    await until("document.querySelector('.todo-error')?.textContent==='Disk unavailable'")
    assert.ok((await run('inspect()')).tabs.some(tab=>tab.id==='chat'),'A failed save must leave the chat tab open')
    await run("setFail(false);textClick('Move chat')")
    await until("!document.querySelector('[role=dialog]')")
    assert.ok(!(await run('inspect()')).tabs.some(tab=>tab.id==='chat'),'Successful move closes the exact source tab')
    assert.equal((await run('linkedTask()')).chats[0].thread.id,'chat-1')
    assert.equal((await run('linkedTask()')).text,'Search','The new task takes the tab name, not the conversation name')
    await run("click('[aria-label=\"Rename Fix the search flow\"]');fill('[aria-label=\"Conversation name\"]','   ')")
    assert.equal(await run("document.querySelector('[aria-label=\"Save conversation name\"]').disabled"),true)
    await run("fill('[aria-label=\"Conversation name\"]','Discard this');key('[aria-label=\"Conversation name\"]','Escape')")
    assert.equal((await run('inspect()')).activePage,'todo','Escape cancels the rename, not Tasks')
    assert.equal((await run('linkedTask()')).chats[0].thread.title,'Fix the search flow')
    await run("click('[aria-label=\"Rename Fix the search flow\"]');fill('[aria-label=\"Conversation name\"]','Finish search support');setFail(true);submit('.todo-chat-rename')")
    await until("document.querySelector('.todo-chat .todo-error')?.textContent==='Disk unavailable'")
    assert.ok(await run("document.querySelector('[aria-label=\"Conversation name\"]')!==null"),'Failed rename stays editable')
    await run("setFail(false);submit('.todo-chat-rename')")
    await until("!document.querySelector('.todo-chat-rename')")
    assert.equal((await run('linkedTask()')).chats[0].thread.title,'Finish search support')
    assert.equal((await run('inspect()')).tabs.length,1,'Renaming never opens the conversation')
    await run("textClick('Finish search support','.todo-chat-link')")
    await until("inspect().tabs.some(tab=>tab.threadIds.includes('chat-1'))")
    assert.equal((await run('inspect()')).tabs.length,2,'Saved chats reopen in full tabs')
    await run("click('[aria-label=\"Tasks\"]')")
    await run("click('[aria-label=\"Rename Finish search support\"]');fill('[aria-label=\"Conversation name\"]','Ship search support');submit('.todo-chat-rename')")
    await until("linkedTask().chats[0].thread.title==='Ship search support'")
    assert.ok((await run('inspect()')).tabs.some(tab=>tab.title==='Search'),'Conversation names do not rename the task or tab')
    assert.equal((await run('inspect()')).activePage,'todo','Renaming an open chat keeps Tasks visible')
    await run("click('[title=\"Edit Search\"]');fill('[aria-label=\"Edit Search\"]','Finish release');key('[aria-label=\"Edit Search\"]','Enter')")
    await until("inspect().tabs.some(tab=>tab.title==='Finish release') && linkedTask().text==='Finish release'")
    assert.equal((await run('linkedTask()')).chats[0].thread.title,'Ship search support','Task edits leave conversation names intact')
    await run("renameTab();fill('.workspace-tab-name-input','Release ready');setFail(true);key('.workspace-tab-name-input','Enter')")
    await until("document.querySelector('.workspace-tab-rename-error')?.getAttribute('aria-label')==='Disk unavailable'")
    assert.equal((await run('linkedTask()')).text,'Finish release','A failed tab rename leaves the shared name unchanged')
    await run("setFail(false);key('.workspace-tab-name-input','Enter')")
    await until("inspect().tabs.some(tab=>tab.title==='Release ready') && linkedTask().text==='Release ready'")
    assert.equal((await run('linkedTask()')).chats[0].thread.title,'Ship search support','Tab edits leave conversation names intact')
    await run("renameTab();fill('.workspace-tab-name-input','Discard this');key('.workspace-tab-name-input','Escape');click('[aria-label=\"Tasks\"]')")
    assert.equal((await run('linkedTask()')).text,'Release ready')

    await settle()
    for(const width of [1200,360]){
      win.setContentSize(width,760)
      await run("document.documentElement.dataset.desktopPlatform='darwin'")
      await settle()
      const metrics=await run(`(()=>{const bar=document.querySelector('.workspace-tabbar').getBoundingClientRect(),button=document.querySelector('[aria-label="Tasks"]').getBoundingClientRect(),page=document.querySelector('.todo-content').getBoundingClientRect();return {bar:bar.height,buttonRight:button.right,pageRight:page.right,paneWidth:document.querySelector('.todo-pane').getBoundingClientRect().width,scroll:document.documentElement.scrollWidth}})()`)
      assert.ok(metrics.paneWidth>=width-2,JSON.stringify(metrics))
      assert.ok(metrics.bar<=52 && metrics.buttonRight<=width && metrics.pageRight<=width && metrics.scroll<=width,JSON.stringify(metrics))
      if(process.env.ALTO_TODO_ARTIFACT_DIR){await fs.mkdir(process.env.ALTO_TODO_ARTIFACT_DIR,{recursive:true});await fs.writeFile(path.join(process.env.ALTO_TODO_ARTIFACT_DIR,'todo-'+width+'.png'),(await win.webContents.capturePage()).toPNG())}
      await run("click('[aria-label=\"Move Review search flow\"]')")
      await settle()
      const dialog=await run("(()=>{const b=document.querySelector('[role=dialog]').getBoundingClientRect();return {left:b.left,right:b.right,bottom:b.bottom}})()")
      assert.ok(dialog.left>=0 && dialog.right<=width && dialog.bottom<=760,JSON.stringify(dialog))
      if(process.env.ALTO_TODO_ARTIFACT_DIR)await fs.writeFile(path.join(process.env.ALTO_TODO_ARTIFACT_DIR,'move-'+width+'.png'),(await win.webContents.capturePage()).toPNG())
      await run("click('[aria-label=\"Cancel move\"]')")
    }
    const taskIdBeforeReload=(await run('linkedTask()')).id
    await run('reload()')
    await until("document.querySelector('.todo-chat-link')")
    assert.equal((await run('linkedTask()')).chats.length,1)
    assert.ok((await run('inspect()')).tabs.some(tab=>tab.title==='Release ready' && tab.nameBinding?.id===(taskIdBeforeReload)), 'Reload keeps the task binding')
    // The default strip must expose plugin actions even when tab grouping is disabled.
    await run('disableGroups()')
    await run("(()=>{const tab=[...document.querySelectorAll('[data-workspace-tab]')].find(el=>el.textContent.includes('Release ready'));tab.dataset.workspaceTab='chat';const b=tab.getBoundingClientRect();tab.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left,clientY:b.bottom}))})()")
    await until("document.querySelector('.workspace-tab-action-menu')")
    await run("textClick('Move to Tasks…','.workspace-tab-action-menu button')")
    await until("document.querySelector('[role=dialog]')")
    const taskIdBeforeMove=(await run('linkedTask()')).id
    await run("textClick('Unsorted','.todo-destinations button');textClick('Move chat')")
    await until("!document.querySelector('[role=dialog]')")
    assert.equal((await run('inspect()')).doc.projects.at(-1).items.find(item=>item.id===(taskIdBeforeMove)).chats[0].thread.id,'chat-1')
    await run("textClick('Ship search support','.todo-chat-link')")
    await until("inspect().tabs.some(tab=>tab.threadIds.includes('chat-1'))")
    await run("click('[aria-label=\"Tasks\"]');click('[aria-label=\"Options for Ship search support\"]');textClick('Move to…','.todo-row-options button')")
    await until("document.querySelector('[role=dialog]')")
    await run("textClick('beta','.todo-destinations button');textClick('Move chat')")
    await until("!document.querySelector('[role=dialog]')")
    assert.equal((await run('linkedTask()')).id,taskIdBeforeMove,'Moving a conversation to a project preserves its task')
    assert.equal((await run('linkedTask()')).text,'Release ready')
    assert.ok((await run('inspect()')).tabs.some(tab=>tab.title==='Release ready' && tab.nameBinding?.id===taskIdBeforeMove))
    assert.equal(await run("document.querySelector('.todo-project[aria-label=beta] .todo-count').textContent"),'2','Moved conversations have task rows and count toward their project')
    assert.ok((await run('inspect()')).doc.projects.every(project=>project.chats.length===0),'No bare project chats remain after moving a conversation')
    // Persisted task bindings must stop following a tab after it changes chats.
    await run('reproduceStaleNameBinding()')
    await until("inspect().tabs.some(tab=>tab.id==='unrelated-tab' && !tab.nameBinding)")
    const linkedTabId=(await run('inspect()')).tabs.find(tab=>tab.threadIds.includes('chat-1')).id
    await run("selectTab('unrelated-tab');renameTab();fill('.workspace-tab-name-input','Independent work');key('.workspace-tab-name-input','Enter')")
    await until("inspect().tabs.some(tab=>tab.id==='unrelated-tab' && tab.title==='Independent work')")
    assert.equal((await run('linkedTask()')).text,'Release ready','An unrelated tab rename does not rename the original task')
    await run(`selectTab(${JSON.stringify(linkedTabId)});renameTab();fill('.workspace-tab-name-input','Backup ready');key('.workspace-tab-name-input','Enter')`)
    await until("linkedTask().text==='Backup ready'")
    assert.equal((await run('inspect()')).tabs.find(tab=>tab.id==='unrelated-tab').title,'Independent work','Renaming the linked tab leaves the repaired tab alone')
    await run('reload()')
    await until("inspect().tabs.some(tab=>tab.id==='unrelated-tab' && tab.title==='Independent work' && !tab.nameBinding)")
    assert.ok((await run('inspect()')).tabs.some(tab=>tab.threadIds.includes('unrelated-chat')),'Repair preserves the unrelated conversation')
    await run("click('[aria-label=\"Tasks\"]');click('[aria-label=\"Delete Backup ready\"]')")
    await until('!linkedTask()')
    assert.ok((await run('inspect()')).tabs.some(tab=>tab.threadIds.includes('chat-1')),'Deleting a task keeps the conversation open')
    assert.equal(await run("document.querySelector('.todo-project[aria-label=beta] .todo-count').textContent"),'1')
    assert.ok((await run('inspect()')).doc.projects.every(project=>project.chats.length===0),'Deleting a task does not create uncounted project chats')
    await run('teardown()')
    assert.equal((await run('inspect()')).overlays.length,0)
    console.log('Tasks browser checks passed')
  } finally {win.destroy();await new Promise(resolve=>server.close(resolve))}
}
check().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)})
