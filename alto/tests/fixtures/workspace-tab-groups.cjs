const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'groups-check.tsx', loader: 'tsx', contents: `
      import React,{useEffect} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import plugin from './program/plugins/workspace-layout.client';
      import groupsPlugin from './program/plugins/workspace-tab-groups.client';
      import {parseWorkspaceLayout} from './program/plugins/workspace-layout-state';
      let saved={version:2,activeViewId:'a',views:['Alto','Incident','Design','Review','Notes'].map((name,i)=>{
        const id=String.fromCharCode(97+i);return {id,name,workspace:'/repo',focusedPaneId:'pane-'+id,root:{type:'pane',id:'pane-'+id,workspace:'/repo',kind:'test'}};
      })};
      localStorage.setItem('codex-cordis.workspace-layout',JSON.stringify(saved));
      const state={connected:true,session:{workspace:'/repo',permissionMode:'full'},projects:[],threads:[],skills:[],turn:{tag:'idle'},activities:[],history:{tag:'ready',entries:[]},harness:{codex:{status:'ready',models:[]},ui:{surfaces:[],contributions:[],regions:[]}}};
      const host={subscribe:()=>()=>{},snapshot:()=>({connectionEpoch:1}),call:async(method,payload)=>{
        if(method.endsWith('.read'))return structuredClone(saved);
        if(method.endsWith('.write')){saved=parseWorkspaceLayout(payload);return null;}
      }};
      let Surface,registry,overlay,root;
      const session={snapshot:()=>state,subscribe:()=>()=>{}};
      const Placeholder=()=>null;
      const Tool=()=> <button aria-label="Test settings" style={{width:28,height:28}}>⚙</button>;
      const ui={subscribe:()=>()=>{},snapshot:()=>0,component:()=>Placeholder,renderer:()=>Tool,contributionRenderer:()=>undefined,
        overlays:{open:id=>{overlay=id},close:id=>{if(overlay===id)overlay=undefined}},
        registerSurface:(_owner,_id,component)=>{Surface=component},
        registerStyle:(owner,id,css)=>{const install=()=>{const el=document.createElement('style');el.dataset.pluginStyle=id;el.textContent=css;document.head.append(el);return ()=>el.remove()};if(owner.effect)owner.effect(install);else install()}};
      const ctx={provide:(_name,value)=>{registry=value},clientUi:ui,clientHost:host,clientSession:session,
        clientSessionRouter:{setActive:()=>{},clearActive:()=>{}},clientSessionFactory:{create:()=>{throw new Error('Unexpected chat creation')}}};
      plugin(ctx);
      let groupEffects=[];
      const enableGroups=()=>groupsPlugin({...ctx,clientWorkspaceLayout:registry,effect:fn=>{const cleanup=fn();groupEffects.push(cleanup);return cleanup}});
      window.enableGroups=()=>flushSync(enableGroups);
      window.disableGroups=()=>flushSync(()=>{for(const cleanup of groupEffects.reverse())cleanup();groupEffects=[]});
      enableGroups();
      window.mounts=0;
      const Pane=({pane})=>{useEffect(()=>{window.mounts++},[]);return <main className="test-pane"><p>Conversation in {pane.id}</p><textarea id={'draft-'+pane.id} defaultValue={'Draft for '+pane.id}/></main>};
      registry.registerPaneKind({effect:fn=>fn()},{id:'test',label:'Test pane',renderer:Pane});
      window.boot=()=>{root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<Surface surface={{id:'workspace-layout',kind:'workspace-layout'}}/>))};
      window.reload=()=>{flushSync(()=>root.unmount());window.boot()};
      window.inspect=()=>({saved:structuredClone(saved),overlay,mounts:window.mounts,
        visible:[...document.querySelectorAll('[data-workspace-tab]:not([inert])')].map(el=>el.dataset.workspaceTab),
        groups:[...document.querySelectorAll('[data-workspace-group]')].map(el=>({id:el.dataset.workspaceGroup,expanded:el.getAttribute('aria-expanded'),text:el.textContent})),
        activePanel:document.querySelector('.workspace-view:not([hidden]) textarea')?.id});
      window.context=selector=>flushSync(()=>{const el=document.querySelector(selector),b=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:Math.min(innerWidth-5,b.left+8),clientY:b.bottom}))});
      window.clickText=text=>flushSync(()=>{const el=[...document.querySelectorAll('.workspace-tab-group-menu button')].find(el=>el.textContent.trim()===text);if(!el)throw new Error('Missing button '+text);el.click()});
      window.click=selector=>flushSync(()=>document.querySelector(selector).click());
      window.renameGroup=text=>flushSync(()=>{const el=document.querySelector('.workspace-tab-group-name input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}))});
      window.key=key=>flushSync(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})));
      let dragged,transfer;
      window.dragStart=source=>{flushSync(()=>{dragged=document.querySelector(source);transfer=new DataTransfer();dragged.dispatchEvent(new DragEvent('dragstart',{dataTransfer:transfer,bubbles:true,cancelable:true}))});const c=document.querySelector('.workspace-tab-drag-image');window.dragImageProbe=c?{corner:c.getContext('2d').getImageData(0,0,1,1).data[3],center:c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data[3],background:getComputedStyle(c).backgroundColor}:undefined};
      const dragEvent=(kind,target,fraction)=>{const to=document.querySelector(target),b=to.getBoundingClientRect();to.dispatchEvent(new DragEvent(kind,{dataTransfer:transfer,bubbles:true,cancelable:true,clientX:b.left+b.width*fraction,clientY:b.top+b.height/2}))};
      window.dragHover=(target,fraction=0.5)=>flushSync(()=>dragEvent('dragover',target,fraction));
      window.dragCancel=()=>flushSync(()=>dragged.dispatchEvent(new DragEvent('dragend',{dataTransfer:transfer,bubbles:true,cancelable:true})));
      window.dragDrop=(target,fraction=0.5)=>{flushSync(()=>dragEvent('drop',target,fraction));window.dragCancel()};
      window.drop=(source,target,fraction=0.5)=>{window.dragStart(source);window.dragHover(target,fraction);window.dragDrop(target,fraction)};
      window.select=index=>flushSync(()=>registry.selectTab(index));
      window.teardown=()=>flushSync(()=>root.unmount());
      window.boot();
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all(['src/client/styles.css', 'program/plugins/ui/default.css', 'program/plugins/theme.css'].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/fonts/')) {
      void fs.readFile(path.join('public', decodeURIComponent(request.url))).then(bytes => response.end(bytes)).catch(() => response.end())
      return
    }
    response.end('<!doctype html><style>' + css + '\n#root{height:100vh}.test-pane{padding:24px;width:100%}.test-pane textarea{width:100%;min-height:100px}</style><div id="root"></div>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, width: 1200, height: 760, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const run = code => window.webContents.executeJavaScript(code)
  const settle = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const finishMotion = async () => {
    await run("document.querySelector('.workspace-tabs').getAnimations({subtree:true}).forEach(animation=>animation.finish())")
    await settle()
  }
  const pauseMotion = time => run(`document.querySelector('.workspace-tabs').getAnimations({subtree:true}).forEach(animation=>{animation.pause();animation.currentTime=${time}})`)
  const motionMetrics = () => run(`(()=>{
    const strip=document.querySelector('.workspace-tabs'),label=strip.querySelector('[data-workspace-group]'),members=[...strip.querySelectorAll('.workspace-tab-group-member')];
    const bounds=label.getBoundingClientRect(),following=document.querySelector('[data-workspace-tab=d]').getBoundingClientRect();
    return {widths:members.map(el=>el.getBoundingClientRect().width),inert:members.every(el=>el.inert),
      following:following.left,gap:following.left-bounds.right,bar:document.querySelector('.workspace-tabbar').getBoundingClientRect().height,
      toolsRight:document.querySelector('.workspace-tabbar-tools').getBoundingClientRect().right,scroll:document.documentElement.scrollWidth,
      expanded:label.getAttribute('aria-expanded'),animations:strip.getAnimations({subtree:true}).map(animation=>({property:animation.transitionProperty,target:animation.effect.target.className,playState:animation.playState,...animation.effect.getTiming()}))};
  })()`)
  const captureBar = async name => {
    if(!process.env.ALTO_TAB_GROUP_ARTIFACT_DIR) return
    await fs.mkdir(process.env.ALTO_TAB_GROUP_ARTIFACT_DIR,{recursive:true})
    const width=await run('innerWidth')
    await fs.writeFile(path.join(process.env.ALTO_TAB_GROUP_ARTIFACT_DIR,name+'.png'),(await window.webContents.capturePage({x:0,y:0,width,height:72})).toPNG())
  }
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await settle()
    assert.equal((await run('inspect()')).mounts, 5)
    await run("window.originalDraft=document.getElementById('draft-pane-a');originalDraft.value='Do not lose this draft';context('[data-workspace-tab=a]')")
    assert.equal((await run('inspect()')).overlay, 'workspace-tab-groups')
    await run("clickText('Add to new group');renameGroup('Release');key('Enter')")
    await settle()
    const groupId = (await run('inspect()')).groups[0].id
    assert.equal((await run('inspect()')).saved.groups[0].name, 'Release')
    await run("context('[data-workspace-group]');renameGroup('Release candidate');document.querySelector('.test-pane').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))")
    assert.equal((await run('inspect()')).saved.groups[0].name, 'Release candidate')
    await run("context('[data-workspace-group]');renameGroup('Release');key('Escape')")
    await run("context('[data-workspace-tab=c]');clickText('Release')")
    assert.deepEqual((await run('inspect()')).saved.views.map(view => view.id), ['a','c','b','d','e'])
    await run("context('[data-workspace-group]');click('[aria-label=Green]');key('Escape')")
    assert.equal((await run('inspect()')).saved.groups[0].color, 'green')
    await run("click('[data-workspace-group]')")
    assert.deepEqual((await run('inspect()')).visible, ['b','d','e'])
    assert.equal((await run('inspect()')).activePanel, 'draft-pane-a')
    assert.equal(await run("originalDraft===document.getElementById('draft-pane-a') && originalDraft.value==='Do not lose this draft'"), true)
    assert.equal((await run('inspect()')).mounts, 5)
    await run('select(1)')
    assert.equal((await run('inspect()')).groups[0].expanded, 'true')
    assert.equal((await run('inspect()')).activePanel, 'draft-pane-c')
    await run("drop('[data-workspace-tab=b]','[data-workspace-group]')")
    assert.equal((await run('inspect()')).saved.views.find(view => view.id === 'b').groupId, groupId)
    assert.equal((await run('inspect()')).mounts, 5)
    await run("drop('[data-workspace-group]','[data-workspace-tab=e]',0.75)")
    assert.deepEqual((await run('inspect()')).saved.views.map(view => view.id), ['d','e','a','c','b'])
    await run("drop('[data-workspace-group]','[data-workspace-tab=d]',0.1)")
    assert.deepEqual((await run('inspect()')).saved.views.map(view => view.id), ['a','c','b','d','e'])
    assert.equal((await run('inspect()')).mounts, 5)

    const beforeHover = (await run('inspect()')).saved
    await run("dragStart('[data-workspace-tab=b]');dragHover('[data-workspace-group]',0.1)")
    assert.deepEqual(await run('dragImageProbe'), { corner: 0, center: 255, background: 'rgba(0, 0, 0, 0)' })
    assert.equal(await run("document.querySelector('[data-workspace-group]').dataset.tabDrop"), 'before')
    assert.deepEqual((await run('inspect()')).saved, beforeHover)
    await run('dragCancel()')
    assert.deepEqual((await run('inspect()')).saved, beforeHover)
    await run("drop('[data-workspace-tab=b]','[data-workspace-group]',0.1)")
    assert.equal((await run('inspect()')).saved.views[0].id, 'b')
    assert.equal((await run('inspect()')).saved.views[0].groupId, undefined)
    await run("drop('[data-workspace-tab=b]','[data-workspace-tab=c]',0.1)")
    assert.equal((await run('inspect()')).saved.views.find(view => view.id === 'b').groupId, groupId)
    await run("drop('[data-workspace-tab=b]','.workspace-tab-add')")
    assert.equal((await run('inspect()')).saved.views.at(-1).id, 'b')
    assert.equal((await run('inspect()')).saved.views.at(-1).groupId, undefined)
    await run("drop('[data-workspace-tab=b]','[data-workspace-group]')")

    await run("click('[data-workspace-group]');context('[data-workspace-group]');disableGroups()")
    assert.equal((await run('inspect()')).overlay, undefined)
    assert.equal((await run('inspect()')).groups.length, 0)
    assert.equal((await run('inspect()')).visible.length, 5)
    assert.equal(await run("!!document.querySelector('[data-plugin-style=workspace-tab-groups]')"), false)
    assert.equal((await run('inspect()')).mounts, 5)
    await run('enableGroups()')
    assert.equal((await run('inspect()')).groups[0].expanded, 'false')
    assert.equal((await run('inspect()')).saved.groups[0].name, 'Release')
    assert.equal(await run("originalDraft===document.getElementById('draft-pane-a')"), true)
    await run("click('[data-workspace-group]')")

    for (const theme of ['light','dark']) {
      for (const width of [1200,360]) {
        window.setContentSize(width,760)
        await run(`document.documentElement.dataset.altoTheme='${theme}';document.documentElement.dataset.desktopPlatform='darwin'`)
        await settle()
        await run("document.querySelector('.workspace-tabs').scrollLeft=0;context('[data-workspace-group]')")
        await settle()
        const metrics = await run(`(()=>{const bar=document.querySelector('.workspace-tabbar').getBoundingClientRect(),menu=document.querySelector('.workspace-tab-group-menu').getBoundingClientRect(),tools=document.querySelector('.workspace-tabbar-tools').getBoundingClientRect();return {bar:bar.height,left:menu.left,right:menu.right,bottom:menu.bottom,width:innerWidth,height:innerHeight,toolsRight:tools.right,scroll:document.documentElement.scrollWidth}})()`)
        assert.equal(metrics.bar,52)
        assert.ok(metrics.left>=0 && metrics.right<=width && metrics.bottom<=760,JSON.stringify(metrics))
        assert.ok(metrics.toolsRight<=width && metrics.scroll<=width,JSON.stringify(metrics))
        if (process.env.ALTO_TAB_GROUP_ARTIFACT_DIR) {
          await fs.mkdir(process.env.ALTO_TAB_GROUP_ARTIFACT_DIR,{recursive:true})
          await fs.writeFile(path.join(process.env.ALTO_TAB_GROUP_ARTIFACT_DIR,`groups-${theme}-${width}.png`),(await window.webContents.capturePage()).toPNG())
        }
        await run("key('Escape')")
        assert.equal((await run('inspect()')).overlay, undefined)
        await finishMotion()
        const expanded=await motionMetrics()
        assert.ok(expanded.widths.every(width=>width>0))
        await captureBar(`motion-${theme}-${width}-expanded`)
        await run("click('[data-workspace-group]')")
        assert.equal((await run('inspect()')).saved.groups[0].collapsed,true)
        const collapse=await motionMetrics()
        assert.equal(collapse.inert,true)
        assert.ok(collapse.animations.some(animation=>animation.property==='flex-basis' && animation.duration===300 && animation.easing==='cubic-bezier(0.22, 1, 0.36, 1)'),JSON.stringify(collapse))
        await pauseMotion(70)
        const middle=await motionMetrics()
        assert.ok(middle.widths.every((memberWidth,index)=>memberWidth>0 && memberWidth<expanded.widths[index]),JSON.stringify({expanded,middle}))
        assert.equal(middle.bar,52)
        assert.ok(middle.toolsRight<=width && middle.scroll<=width)
        await captureBar(`motion-${theme}-${width}-collapsing`)
        await finishMotion()
        const collapsed=await motionMetrics()
        assert.ok(collapsed.widths.every(width=>width===0),JSON.stringify(collapsed))
        assert.equal(collapsed.gap,4)
        await captureBar(`motion-${theme}-${width}-collapsed`)
        await run("click('[data-workspace-group]')")
        await pauseMotion(70)
        const expanding=await motionMetrics()
        assert.ok(expanding.widths.every((memberWidth,index)=>memberWidth>0 && memberWidth<expanded.widths[index]),JSON.stringify({expanded,expanding}))
        await captureBar(`motion-${theme}-${width}-expanding`)
        await finishMotion()
        assert.deepEqual((await motionMetrics()).widths,expanded.widths)
        assert.equal(await run("originalDraft===document.getElementById('draft-pane-a') && originalDraft.value==='Do not lose this draft'"),true)
        assert.equal((await run('inspect()')).mounts,5)
      }
    }
    await run("click('[data-workspace-group]')")
    await pauseMotion(70)
    const reversing=await motionMetrics()
    await run("click('[data-workspace-group]')")
    const reversed=await motionMetrics()
    assert.ok(reversed.widths.every((width,index)=>Math.abs(width-reversing.widths[index])<1),JSON.stringify({reversing,reversed}))
    await finishMotion()
    assert.equal((await motionMetrics()).expanded,'true')

    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await settle()
    await run("click('[data-workspace-group]')")
    assert.ok((await motionMetrics()).widths.every(width=>width===0))
    assert.ok((await motionMetrics()).animations.every(animation=>animation.duration<=0.01 && animation.delay===0))
    await run("click('[data-workspace-group]')")
    assert.ok((await motionMetrics()).widths.every(width=>width>0))
    assert.ok((await motionMetrics()).animations.every(animation=>animation.duration<=0.01 && animation.delay===0))
    window.webContents.debugger.detach()
    await run("click('[data-workspace-group]');reload()")
    await settle()
    assert.equal((await run('inspect()')).saved.groups[0].name, 'Release')
    assert.equal((await run('inspect()')).groups[0].expanded, 'false')
    await run("context('[data-workspace-group]');clickText('Ungroup tabs')")
    assert.equal((await run('inspect()')).groups.length,0)
    assert.equal((await run('inspect()')).visible.length,5)
    assert.equal((await run('inspect()')).saved.groups,undefined)
    await run("context('[data-workspace-tab=a]');teardown()")
    assert.equal(await run('inspect().overlay'), undefined)
    console.log('Workspace tab group browser checks passed')
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)})
