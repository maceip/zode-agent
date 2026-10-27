const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'search-check.tsx', loader: 'tsx', contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
      import layoutPlugin from './program/plugins/workspace-layout.client';
      import searchPlugin from './program/plugins/search.client';
      const thread=(id,updatedAt,title=id)=>({id,title,preview:'Conversation '+id,cwd:'/repo',createdAt:1,updatedAt});
      const current=thread('current',100,'Current conversation'),newest=thread('newest-unread',1,'Newest unread conversation'),older=thread('older-unread',90,'Older unread conversation'),read=thread('read',95,'Read conversation'),closed=thread('closed',200,'Closed conversation');
      const extras=Array.from({length:14},(_,index)=>thread('extra-'+index,80-index,'Extra conversation '+index));
      const view=(id,name,t)=>({id,name,workspace:'/repo',focusedPaneId:'pane-'+id,root:{type:'pane',id:'pane-'+id,workspace:'/repo',thread:t}});
      let saved={version:2,activeViewId:'current-tab',views:[view('current-tab','Current work',current),view('unread-tab','Unread work',newest),view('read-tab','Read work',read),view('older-tab','Older work',older),...extras.map((item,index)=>view('extra-tab-'+index,'Extra tab '+index,item))]};
      localStorage.setItem('codex-cordis.workspace-layout',JSON.stringify(saved));
      let statuses={revision:0,running:[],finished:['current','newest-unread','older-unread']};
      const statusListeners=new Set(),layoutListeners=new Set(),overlayListeners=new Set();let overlay;
      const previewRequests=[],paneUpdates=new Map();
      const activities=id=>id==='read'?[]:[{kind:'user',content:'Opening '+id},{kind:'agent',content:'Latest reply for '+id},{kind:'tool',content:'Tool output is not a message'}];
      const status={subscribe:fn=>{statusListeners.add(fn);return()=>statusListeners.delete(fn)},snapshot:()=>statuses,acknowledge:id=>{statuses={...statuses,revision:statuses.revision+1,finished:statuses.finished.filter(t=>t!==id)};for(const fn of statusListeners)fn()}};
      const state={connected:true,threadId:'current',session:{workspace:'/repo',permissionMode:'full'},projects:[],threads:[closed],skills:[],turn:{tag:'running'},activities:[],history:{tag:'ready',entries:[]},harness:{extensions:{'session.workspace':'/tmp/alto-scratch'},server:{projectRoot:'/repo'},codex:{status:'ready',models:[]},ui:{surfaces:[],contributions:[],regions:[]}}};
      const session={snapshot:()=>state,subscribe:()=>()=>{},openThread:()=>{throw Error('Must not replace current chat')},newThread:()=>{throw Error('Must not replace current chat')}};
      const host={snapshot:()=>({connectionEpoch:1}),subscribe:()=>()=>{},call:async(method,payload)=>{if(method==='search.preview'){previewRequests.push(payload.threadId);if(payload.threadId==='read')throw Error('History unavailable');return {preview:'Latest saved reply for '+payload.threadId}}if(method.endsWith('.read'))return saved;if(method.endsWith('.write'))saved=structuredClone(payload)}};
      const overlays={subscribe:fn=>{overlayListeners.add(fn);return()=>overlayListeners.delete(fn)},snapshot:()=>overlay,open:id=>{overlay=id;for(const fn of overlayListeners)fn()},close:id=>{if(overlay===id){overlay=undefined;for(const fn of overlayListeners)fn()}},toggle:id=>{overlay===id?overlays.close(id):overlays.open(id)}};
      let Surface,SearchRoot,registry;const effects=[];
      const Placeholder=()=> <textarea aria-label="Chat draft" defaultValue="Keep my draft"/>;
      const ui={subscribe:()=>()=>{},snapshot:()=>0,overlays,component:()=>Placeholder,renderer:()=>()=>null,contributionRenderer:()=>undefined,
        registerSurface:(_owner,_id,component)=>{Surface=component},registerRoot:(_owner,_id,component)=>{SearchRoot=component},registerStyle:(_owner,_id,css)=>{const e=document.createElement('style');e.textContent=css;document.head.append(e)}};
      const ctx={effect:fn=>{const cleanup=fn();effects.push(cleanup);return cleanup},provide:(_name,value)=>{registry=value},clientUi:ui,clientSession:session,clientHost:host,
        clientSessionRouter:{setActive:()=>{},clearActive:()=>{}},clientSessionFactory:{create:()=>{let snap={...state,threadId:undefined};const listeners=new Set();return {session:{snapshot:()=>snap,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},openThread:async thread=>{snap={...snap,threadId:thread.id,threads:[thread],activities:activities(thread.id)};paneUpdates.set(thread.id,content=>{snap={...snap,activities:[...snap.activities,{kind:'agent',content}]};for(const fn of listeners)fn()});for(const fn of listeners)fn()},selectProject:()=>{}},dispose:()=>listeners.clear()}}},
        get:name=>name==='clientThreadStatus'?status:undefined,on:()=>()=>{}};
      layoutPlugin(ctx);searchPlugin({...ctx,clientWorkspaceLayout:registry});
      const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<><Surface surface={{id:'workspace-layout',kind:'workspace-layout'}}/><SearchRoot/></>));
      window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      window.cmdK=()=>flushSync(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true,cancelable:true})));
      window.key=key=>flushSync(()=>document.querySelector('.search-palette input').dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})));
      window.query=value=>flushSync(()=>{const e=document.querySelector('.search-palette input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))});
      window.updatePreview=(id,text)=>flushSync(()=>paneUpdates.get(id)(text));
      window.inspect=()=>{const list=document.querySelector('.search-results'),selected=list?.querySelector('.search-result[aria-selected="true"]');const listRect=list?.getBoundingClientRect(),selectedRect=selected?.getBoundingClientRect();return {previewRequests,tabs:registry.tabs(),saved,overlay,finished:statuses.finished,scrollTop:list?.scrollTop??0,listBounds:listRect&&{top:listRect.top,bottom:listRect.bottom},selectedBounds:selectedRect&&{top:selectedRect.top,bottom:selectedRect.bottom},results:[...document.querySelectorAll('.search-result')].map(e=>({label:e.querySelector('strong').textContent,preview:e.querySelector('.search-result-copy > span')?.textContent,selected:e.getAttribute('aria-selected'),disabled:e.disabled}))}};
      window.select=id=>flushSync(()=>registry.selectTab(registry.tabs().findIndex(tab=>tab.id===id)));
      window.teardown=()=>{flushSync(()=>root.unmount());for(const cleanup of effects.reverse())cleanup?.()};
    ` }, bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',loader:{'.css':'text'},define:{'process.env.NODE_ENV':'"production"'},
  })
  const css=(await Promise.all(['src/client/styles.css','src/client/pane-toolbar.css','program/plugins/ui/default.css'].map(file=>fs.readFile(file,'utf8')))).join('\n').replace(/@import[^;]+;/g,'')
  const server=http.createServer((_request,response)=>response.end('<!doctype html><style>'+css+'#root{height:100vh}</style><div id="root"></div>'))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const win=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}})
  const run=code=>win.webContents.executeJavaScript(code)
  const until=async expression=>{for(let i=0;i<100;i++){if(await run(expression))return;await run('frame()')}throw Error('Timed out: '+expression)}
  try {
    await win.loadURL('http://127.0.0.1:'+server.address().port);await run(bundle.outputFiles[0].text)
    await until('inspect().tabs.length===18')
    await run('window.originalDraft=document.querySelector(".workspace-view:not([hidden]) textarea");cmdK()');await run('frame()')
    let result=await run('inspect()');assert.equal(await run('document.querySelector(".search-palette input").placeholder'),'Search conversations…');assert.equal(result.results[0].label,'Newest unread conversation');assert.equal(result.results[1].label,'Older unread conversation');assert.equal(result.results[0].selected,'true');assert.equal(result.results[0].disabled,false,'Navigation remains enabled while the current agent works')
    assert.equal(result.results.some((item)=>item.label==='Closed conversation'),false,'Closed conversations are excluded')
    assert.equal(result.results.some((item)=>item.label==='Unread work'),false,'Conversation titles replace tab names')
    assert.equal(await run('document.querySelectorAll(".search-result-icon").length'),0,'Result rows do not repeat a chat icon')
    assert.equal(await run('document.querySelectorAll(".search-palette kbd, .search-footer").length'),0,'Visible hotkey hints are removed')
    assert.equal(await run('document.activeElement===document.querySelector(".search-palette input")'),true)
    await until('inspect().results.some(r=>r.label==="Older unread conversation"&&r.preview==="Latest reply for older-unread")')
    result=await run('inspect()')
    assert.equal(result.results[0].preview,'Latest reply for newest-unread','Preview uses the latest chat message, not the first prompt or tool output')
    assert.equal(result.previewRequests.includes('newest-unread'),false,'Open pane history is reused')
    assert.equal(result.results.find(r=>r.label==='Read conversation').preview,'/repo','A failed history read keeps the picker usable without an opening-message preview')
    assert.equal(result.tabs.length,18,'Reading saved previews does not open chats')
    await run('updatePreview("newest-unread","A newer reply arrives while the picker is open")')
    await until('inspect().results[0].preview==="A newer reply arrives while the picker is open"')
    assert.equal((await run('inspect()')).results[0].selected,'true','Live previews keep the selected unread stable')
    for(let index=0;index<12;index+=1)await run('key("ArrowDown")')
    await run('frame()')
    result=await run('inspect()');assert.ok(result.scrollTop>0,'Arrow navigation scrolls the result list');assert.ok(result.selectedBounds.top>=result.listBounds.top&&result.selectedBounds.bottom<=result.listBounds.bottom,'The active result stays visible')
    await run('key("Escape")');assert.equal((await run('inspect()')).overlay,undefined);await run('cmdK()');await run('frame()')
    for(const width of [1100,390]) {
      win.setSize(width,760);await run('frame()')
      const bounds=await run('(()=>{const p=document.querySelector(".search-palette").getBoundingClientRect();return {left:p.left,right:p.right,scroll:document.documentElement.scrollWidth,width:innerWidth}})()')
      assert.ok(bounds.left>=0&&bounds.right<=bounds.width&&bounds.scroll<=bounds.width,JSON.stringify(bounds))
      if(process.env.ALTO_SEARCH_ARTIFACT_DIR){await fs.mkdir(process.env.ALTO_SEARCH_ARTIFACT_DIR,{recursive:true});await fs.writeFile(process.env.ALTO_SEARCH_ARTIFACT_DIR+'/search-'+width+'.png',(await win.webContents.capturePage()).toPNG())}
    }
    win.setSize(1100,760)

    await run('key("Enter")');await until('inspect().tabs.find(t=>t.active)?.id==="unread-tab"')
    result=await run('inspect()');assert.equal(result.tabs.length,18,'Existing tab is reused');assert.equal(result.finished.includes('newest-unread'),false);assert.equal(result.overlay,undefined)
    assert.ok(await run('originalDraft.isConnected && originalDraft.value==="Keep my draft"'))
    assert.equal(result.tabs.find(t=>t.id==='current-tab').threadIds[0],'current')
    await run('cmdK()');await run('frame()');assert.equal((await run('inspect()')).results[0].label,'Older unread conversation');await run('key("Enter")')
    await until('inspect().tabs.find(t=>t.active)?.id==="older-tab"');assert.equal((await run('inspect()')).tabs.length,18)
    assert.ok(await run('originalDraft.isConnected && originalDraft.value==="Keep my draft"'))
    await run('cmdK();query("Read work")');await run('frame()');assert.equal((await run('inspect()')).results.length,0,'Tab names are not searched');assert.equal(await run('document.querySelector(".search-empty").textContent'),'No matching conversations.')
    await run('query("Read conversation")');await run('frame()');assert.equal((await run('inspect()')).results[0].label,'Read conversation');await run('key("Enter")');await until('inspect().tabs.find(t=>t.active)?.id==="read-tab"')
    assert.equal((await run('inspect()')).tabs.length,18,'Read chats also switch to their existing tabs')
    await run('cmdK();query("New chat")');await run('frame()');assert.equal((await run('inspect()')).results.length,0,'Conversation-only search has no new-chat action');await run('key("Enter")');assert.equal((await run('inspect()')).tabs.length,18);await run('key("Escape")')
    assert.ok(await run('originalDraft.isConnected && originalDraft.value==="Keep my draft"'))
    await run('teardown()');console.log('Search browser checks passed: titles, open-tab scope, scrolling, keyboard navigation, composer styling inputs, and preserved draft')
  } finally {win.destroy();await new Promise(resolve=>server.close(resolve))}
}
check().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)})
