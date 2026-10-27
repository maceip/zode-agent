const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

async function check() {
  await app.whenReady()
  const staged = process.env.ALTO_GIT_PANE_STAGED
  const read = async file => {
    if (staged && file.startsWith('program/plugins/')) {
      try { return await fs.readFile(path.join(staged, path.basename(file)), 'utf8') } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    return fs.readFile(file, 'utf8')
  }
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'git-pane-context-check.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {Context} from 'cordis';
      import {Columns2,Rows2,Maximize2,X,Pencil} from 'lucide-react';
      import workTargets from './program/plugins/work-targets.client';
      import gitPaneStatus from './program/plugins/git-pane-status.client';

      const listeners=new Set(),addons=[];
      const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};
      const emit=()=>listeners.forEach(listener=>listener());
      const now='2026-10-15T20:00:00Z',localPath='/Users/test/development/alto';
      const branch='feature/pane-context';
      const local={id:'local',kind:'local',projectId:'alto',branch,label:'Alto',location:localPath,
        repository:'block/alto',head:'abc1234',primary:true};
      const other={...local,id:'other',branch:'main',label:'Main',location:'/Users/test/development/alto-main',primary:false};
      const blox={id:'blox',checkoutId:'blox',kind:'blox',projectId:'alto',branch,label:'jm-pane-context',
        location:'/home/test/alto',repository:'block/alto',url:'https://blox.example.test/workstations/jm-pane-context',
        status:'Running',statusTone:'success',updatedAt:now};
      const pr=(number,checks,extras={})=>({number,title:'Pane context '+number,url:'https://github.com/block/alto/pull/'+number,
        state:'OPEN',draft:false,headBranch:branch,baseBranch:'main',...(checks?{checks}:{}),...extras});
      const passing=pr(40,'passing',{checkCount:1,checkDetails:[{name:'Typecheck',state:'passing',description:'Completed',url:'https://github.com/block/alto/actions/runs/40'}]});
      const pending=pr(41,'pending',{checkCount:2,checkDetails:[{name:'Build macOS',state:'pending',description:'In progress',url:'https://github.com/block/alto/actions/runs/41'},
        {name:'Unit tests',state:'passing',description:'Completed',url:'https://github.com/block/alto/actions/runs/42'}]});
      const failed=pr(42,'failing',{checkCount:1,checkDetails:[{name:'Browser regression',state:'failing',description:'Failed',url:'https://github.com/block/alto/actions/runs/43'}]});
      const unknown=pr(43,undefined);
      const mixed=pr(44,'failing',{checkCount:18,checkDetails:[
        ...Array.from({length:12},(_,index)=>({name:'Passing job '+(index+1),state:'passing',description:'Completed',
          url:'https://github.com/block/alto/actions/runs/'+(100+index)})),
        ...Array.from({length:2},(_,index)=>({name:'Pending job '+(index+1),state:'pending',description:'In progress'})),
        ...Array.from({length:4},(_,index)=>({name:'Failing job '+(index+1),state:'failing',description:'Failed',
          url:'https://github.com/block/alto/actions/runs/'+(200+index)})),
      ]});
      const stacked={...pending,stack:{id:'PS_context',number:7,baseBranch:'main',size:3,
        entries:[{position:1,pullRequest:passing},{position:2,pullRequest:pending},{position:3,pullRequest:failed}]}};
      let scenario='local',currentLocal=local,target,remoteLocation,remoteWorkspace,pullRequests=[pending],revision=0;
      let sessionState,contextState,gitState,gitSnapshot;
      window.actions=[];window.openedLinks=[];
      document.addEventListener('click',event=>{
        const anchor=event.target.closest('a');
        if(anchor){event.preventDefault();window.openedLinks.push(anchor.href)}
      },true);
      const rebuild=()=>{
        const thread={id:'thread',title:'Review changes',cwd:localPath,projectId:'alto',gitInfo:{branch:currentLocal.branch,sha:'abc1234'}};
        sessionState={threadId:'thread',threads:[thread],history:{entries:[]},activeProjectId:'alto',
          connected:true,session:{workspace:localPath},...(remoteLocation?{remoteLocation,remoteWorkspaceName:remoteWorkspace?.name??'unregistered-machine',
            ...(remoteWorkspace?{remoteWorkspace}:{}),
            providerId:'blox-codex',providers:[{id:'blox-codex',label:'Codex on Blox',agentId:'codex',location:{id:'blox',label:'Blox'}}]}: {})};
        contextState={version:1,revision:++revision,workstreams:[{id:'stream',projectId:'alto',name:'Alto',branch,
          repository:'block/alto',checkouts:[currentLocal,other,blox]}],
          providers:[{id:'blox',label:'Blox',supportsExistingTarget:true,supportsBranchTarget:true}],
          threadTargets:target?{thread:target}:{},updatedAt:now};
        gitState={root:localPath,branch:currentLocal.branch,head:'abc1234',upstream:'origin/main',ahead:2,behind:0,
          files:[{path:'program/plugins/git-pane-status.client.tsx',indexStatus:' ',worktreeStatus:'M'}],pullRequests,updatedAt:now};
        gitSnapshot={version:1,revision,aliases:{},repositories:{[localPath]:gitState},updatedAt:now};
      };
      rebuild();
      const session={subscribe,snapshot:()=>sessionState,ensureThread:async()=> 'thread'};
      const contexts={subscribe,snapshot:()=>contextState,refresh:async()=>{},
        localCheckoutForPath:()=>currentLocal,workstreamForPath:()=>contextState.workstreams[0],targetForThread:()=>target,
        setTarget:async(threadId,checkoutId)=>window.actions.push({kind:'set-target',threadId,checkoutId}),
        openLocation:async checkoutId=>{
          if(window.failLocation)throw new Error('This checkout could not be opened.');
          window.actions.push({kind:'open-location',checkoutId});
        },
        createLocalBranch:async()=>{},createProviderTarget:async()=>{},createProviderBranchTarget:async()=>{}};
      const git={subscribe,snapshot:()=>gitSnapshot,
        repositoryFor:()=>gitState,inspect:async()=>gitState,
        inspectBranch:async(location,branch)=>({branch,pullRequests:branch==='feature/remote-chat'?[pr(64,'passing')]:pullRequests,
          repository:'block/alto',updatedAt:now})};
      const ctx=new Context();
      ctx.provide('clientWorkContexts',contexts);
      ctx.provide('clientGitSupport',git);
      ctx.provide('clientWorkspaceLayout',{
        registerPaneAddon:(owner,addon)=>{addons.push(addon);return{dispose:async()=>{}}},
        openPane:request=>{window.actions.push({kind:'open-pane',request});return{paneId:'opened'}}
      });
      ctx.provide('clientHost',{
        request:async(method,args)=>{window.actions.push({kind:'request',method,args});return{}},
        call:async(method,args)=>{window.actions.push({kind:'call',method,args});return{}},
      });
      ctx.provide('clientUi',{registerStyle:(owner,id,css)=>owner.effect(()=>{
        const style=document.createElement('style');style.textContent=css;document.head.append(style);return()=>style.remove();
      })});
      const root=createRoot(document.getElementById('root'));
      const render=()=>flushSync(()=>root.render(<section className="workspace-chat-pane is-focused">
        <header className="workspace-pane-header">
          <div className="workspace-pane-title-control">
            <button className="workspace-pane-title"><span className="workspace-pane-title-text">Review changes</span></button>
            <button className="icon-button shell-control workspace-pane-title-rename" aria-label="Rename Review changes"><Pencil size={13}/></button>
          </div>
          {addons.sort((a,b)=>(a.order??0)-(b.order??0)).map(addon=>{const Addon=addon.renderer;return <Addon key={scenario+addon.id}
            workspaceId="workspace" paneId="pane" focused visible session={session}/>})}
          <div className="workspace-pane-actions">
            <div className="workspace-pane-action-group"><button aria-label="Split pane vertically"><Columns2 size={14}/></button><button aria-label="Split pane horizontally"><Rows2 size={14}/></button></div>
            <div className="workspace-pane-action-group"><button className="workspace-pane-fullscreen" aria-label="Full screen pane"><Maximize2 size={14}/></button><button aria-label="Close pane"><X size={14}/></button></div>
          </div>
        </header>
        <main className="fixture-content"><p>Review the changes in this workspace.</p><div className="fixture-composer">Ask Alto…</div></main>
      </section>));
      window.setScenario=name=>{
        scenario=name;currentLocal=local;target=undefined;remoteLocation=undefined;remoteWorkspace=undefined;pullRequests=[pending];
        if(name==='blox')target=blox;
        if(name==='remote'){
          remoteLocation='Blox';
          remoteWorkspace={name:'jm-remote-chat',url:'https://blox.example.test/workstations/jm-remote-chat',
            cwd:'/home/test/remote-alto',branch:'feature/remote-chat',repository:'block/alto'};
        }
        if(name==='remote-unknown')remoteLocation='Blox';
        if(name==='multiple')pullRequests=[failed,unknown];
        if(name==='stack')pullRequests=[stacked];
        if(name==='unknown')pullRequests=[unknown];
        if(name==='mixed')pullRequests=[mixed];
        if(name==='long'){
          currentLocal={...local,branch:'feature/very-long-branch-name-with-more-context-than-fits-in-a-narrow-pane'};
          pullRequests=[stacked];
        }
        rebuild();emit();render();
      };
      window.observe=()=>({text:document.body.innerText,actions:window.actions,links:window.openedLinks,
        header:[...document.querySelector('.workspace-pane-header').children].map(element=>{
          const box=element.getBoundingClientRect();return{className:element.className,left:box.left,right:box.right,width:box.width};
        }),overflow:document.documentElement.scrollWidth>innerWidth,
        controls:[...document.querySelectorAll('.git-pane-pr,.work-target-location,.work-target-branch-button')].map(element=>({
          className:element.className,scroll:element.scrollWidth,client:element.clientWidth,
          left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,
        })),branchTextWidth:document.querySelector('.work-target-branch')?.getBoundingClientRect().width,
        anchors:[...document.querySelectorAll('a')].map(a=>({href:a.href,text:a.innerText})),
        buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText,label:b.getAttribute('aria-label'),title:b.title,disabled:b.disabled}))});
      Promise.all([ctx.plugin(workTargets,{}),ctx.plugin(gitPaneStatus,{})]).then(()=>{render();window.ready=true});
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
    plugins: staged ? [{ name: 'staged-git-pane', setup(plugin) {
      plugin.onResolve({ filter: /^\.\.?\// }, async args => {
        if (!args.importer.includes('/program/plugins/') && args.namespace !== 'staged-git-pane') return
        const name = path.basename(args.path)
        const candidate = path.resolve(staged, name.endsWith('.js') ? name.slice(0, -3) + '.ts' : name)
        try {
          await fs.access(candidate)
          return { path: candidate, namespace: 'staged-git-pane' }
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      })
      plugin.onLoad({ filter: /.*/, namespace: 'staged-git-pane' }, async args => ({
        contents: await fs.readFile(args.path, 'utf8'), resolveDir: path.resolve('program/plugins'),
        loader: args.path.endsWith('.css') ? 'text' : args.path.endsWith('.tsx') ? 'tsx' : 'ts',
      }))
      plugin.onLoad({ filter: /[\\/]program[\\/]plugins[\\/].+\.(?:tsx?|css)$/ }, async args => {
        const candidate = path.join(staged, path.basename(args.path))
        try {
          return { contents: await fs.readFile(candidate, 'utf8'), resolveDir: path.dirname(args.path),
            loader: args.path.endsWith('.css') ? 'text' : args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      })
    } }] : [],
  })
  const css = (await Promise.all([
    'src/client/styles.css', 'program/plugins/ui/default.css', 'program/plugins/theme.css',
    'program/plugins/workspace-layout.css', 'program/plugins/git-support.css',
  ].map(read))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => response.end('<!doctype html><meta charset="utf-8"><style>' + css + `
    html,body{height:100%;margin:0;overflow:hidden}body{background:var(--canvas);font-family:var(--sans)}
    .fixture-tabs{height:38px;display:flex;align-items:center;gap:24px;padding:0 24px;border-bottom:1px solid var(--border-soft);font-size:12px;color:var(--muted)}
    .fixture-tabs strong{color:var(--text);font-weight:500}#root{height:calc(100% - 38px);display:flex}
    .fixture-content{flex:1;display:flex;flex-direction:column;justify-content:space-between;padding:50px 28px 22px;color:var(--muted);font-size:14px}
    .fixture-content p{max-width:650px;width:100%;margin:0 auto}.fixture-composer{max-width:650px;width:100%;margin:0 auto;box-sizing:border-box;padding:22px;border:1px solid var(--border);border-radius:24px;background:var(--panel);color:var(--muted-soft)}
  </style><nav class="fixture-tabs"><strong>Pane context</strong><span>Alto</span></nav><div id="root"></div>`))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const win = new BrowserWindow({ show: false, width: 1100, height: 460, webPreferences: {
    offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const run = async code => {
    try { return await win.webContents.executeJavaScript(code) } catch (error) {
      throw new Error(`Browser expression failed: ${code.slice(0, 300)}\n${error.message}`)
    }
  }
  const until = async expression => {
    for (let i = 0; i < 125; i++) {
      if (await run(expression)) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Timed out: ' + expression + '\n' + JSON.stringify(await run('observe()')))
  }
  const settle = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const scenario = async name => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 440 })
    await run(`setScenario(${JSON.stringify(name)})`)
    await settle()
  }
  const hover = async selector => {
    const point = await run(`(()=>{const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return{x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)}})()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  }
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const escape = () => run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  const screenshot = async name => {
    if (!process.env.ALTO_GIT_PANE_ARTIFACT_DIR) return
    await fs.mkdir(process.env.ALTO_GIT_PANE_ARTIFACT_DIR, { recursive: true })
    await fs.writeFile(path.join(process.env.ALTO_GIT_PANE_ARTIFACT_DIR, name + '.png'), (await win.webContents.capturePage()).toPNG())
    await fs.writeFile(path.join(process.env.ALTO_GIT_PANE_ARTIFACT_DIR, name + '.json'), JSON.stringify(await run('observe()'), null, 2))
  }
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await until('window.ready')
    await settle()
    assert.match(await run("document.querySelector('.work-target-location').textContent"), /Local/)
    assert.match(await run("document.querySelector('.work-target-branch-button').textContent"), /feature\/pane-context/)
    await click('.work-target-location')
    assert.deepEqual(await run('actions.at(-1)'), { kind: 'open-location', checkoutId: 'local' })
    assert.equal(await run("!!document.querySelector('.work-target-popover')"), false, 'Opening the place does not open the branch picker')
    await run('window.failLocation=true')
    await click('.work-target-location')
    await until("!!document.querySelector('.work-target-location-error[role=alert]')")
    assert.equal(await run("(()=>{const alert=document.querySelector('.work-target-location-error'),box=alert.getBoundingClientRect();return alert.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))})()"), true,
      'A failed location action remains visible below the header')
    await click('[aria-label="Dismiss location error"]')
    await run('window.failLocation=false')

    await click('.work-target-branch-button')
    await until("!!document.querySelector('.work-target-popover')")
    await run("[...document.querySelectorAll('.work-target-checkouts .work-target-option')].find(button=>button.textContent.includes('main')).click()")
    await until("!document.querySelector('.work-target-popover')")
    assert.deepEqual(await run('actions.at(-1)'), { kind: 'set-target', threadId: 'thread', checkoutId: 'other' })

    await hover('.git-pane-pr')
    await until("!!document.querySelector('.git-pane-popover')")
    assert.match(await run("document.querySelector('.git-pane-popover').innerText"), /Build macOS/)
    assert.doesNotMatch(await run("document.querySelector('.git-pane-popover').innerText"), /Unit tests/, 'Passing checks stay collapsed by default')
    assert.equal(await run("document.querySelector('.git-pane-passing-checks').open"), false)
    assert.match(await run("document.querySelector('.git-pane-passing-checks summary').textContent"), /1 passing/)
    assert.equal(await run("document.querySelector('.git-pane-pr').tagName"), 'A', 'A single PR opens its GitHub page directly')
    await screenshot('git-pane-context-local-ci')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 440 })
    await until("!document.querySelector('.git-pane-popover')")
    // The hidden window deliberately never takes native focus from the user.
    await run("(()=>{const link=document.querySelector('.git-pane-pr');link.focus();link.dispatchEvent(new FocusEvent('focusin',{bubbles:true}))})()")
    await until("!!document.querySelector('.git-pane-popover')")
    await escape()
    await until("!document.querySelector('.git-pane-popover')")
    await click('.git-pane-pr')
    assert.equal(await run('openedLinks.at(-1)'), 'https://github.com/block/alto/pull/41')

    await scenario('blox')
    assert.match(await run("document.querySelector('.work-target-location').textContent"), /Blox/)
    assert.equal(await run("document.querySelector('.work-target-location').href"), 'https://blox.example.test/workstations/jm-pane-context')
    await click('.work-target-location')
    assert.equal(await run('openedLinks.at(-1)'), 'https://blox.example.test/workstations/jm-pane-context')
    await screenshot('git-pane-context-blox')
    await click('.work-target-branch-button')
    await until("!!document.querySelector('.work-target-popover')")
    await escape()

    await scenario('remote')
    assert.equal(await run("document.querySelector('.work-target-location').href"), 'https://blox.example.test/workstations/jm-remote-chat')
    assert.match(await run("document.querySelector('.work-target-branch-button').textContent"), /feature\/remote-chat/)
    assert.equal(await run("document.querySelector('.work-target-branch-button').disabled"), true, 'An ACP workspace branch is informative, not a local checkout picker')
    await until("document.querySelector('.git-pane-pr')?.textContent.includes('64')")
    assert.doesNotMatch(await run("document.querySelector('.workspace-pane-header').textContent"), /#41/, 'Remote chat context does not inherit local PRs')
    await screenshot('git-pane-context-remote')

    await scenario('remote-unknown')
    assert.equal(await run("!!document.querySelector('.work-target-location[href]')"), false, 'No destination is invented for a remote chat without workspace metadata')
    assert.doesNotMatch(await run("document.querySelector('.work-target-control').textContent"), /Local|feature\/pane-context/, 'Unknown remote context does not show the local checkout branch')

    await scenario('multiple')
    assert.match(await run("document.querySelector('.git-pane-pr').textContent"), /PRs\s*2/)
    await hover('.git-pane-pr')
    await until("document.querySelectorAll('.git-pane-pr-row').length===2")
    assert.deepEqual(await run("[...document.querySelectorAll('.git-pane-pr-row')].map(row=>row.href)"), [
      'https://github.com/block/alto/pull/42', 'https://github.com/block/alto/pull/43',
    ])
    assert.doesNotMatch(await run("document.querySelector('.git-pane-popover').textContent"), /Stack/, 'Separate PRs are not presented as a native stack')
    await click('.git-pane-check-list a')
    assert.equal(await run('openedLinks.at(-1)'), 'https://github.com/block/alto/actions/runs/43')

    await scenario('unknown')
    assert.equal(await run("document.querySelector('.git-pane-pr').classList.contains('is-pending')"), false, 'Missing check information is neutral, not running')
    await hover('.git-pane-pr')
    await until("!!document.querySelector('.git-pane-popover')")
    assert.match(await run("document.querySelector('.git-pane-popover').textContent"), /No checks reported/)
    assert.equal(await run("document.querySelectorAll('.git-pane-popover .is-pending').length"), 0)

    await scenario('stack')
    assert.match(await run("document.querySelector('.git-pane-pr').textContent"), /Stack\s*3/)
    await hover('.git-pane-pr')
    await until("document.querySelectorAll('.git-pane-pr-row').length===3")
    assert.deepEqual(await run("[...document.querySelectorAll('.git-pane-pr-row')].map(row=>row.href)"), [
      'https://github.com/block/alto/pull/40', 'https://github.com/block/alto/pull/41', 'https://github.com/block/alto/pull/42',
    ], 'Native stack members follow their order from the base branch')
    const stackText = await run("document.querySelector('.git-pane-popover').innerText")
    assert.doesNotMatch(stackText, /Typecheck|Unit tests/, 'Passing checks stay compact for each PR in a stack')
    assert.match(stackText, /Build macOS/)
    assert.match(stackText, /Browser regression/)
    assert.equal(await run("document.querySelectorAll('.git-pane-passing-checks:not([open])').length"), 2)
    await screenshot('git-pane-context-stack-ci')
    await click('.git-pane-pr')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 440 })
    await run('new Promise(resolve=>setTimeout(resolve,250))')
    assert.equal(await run("!!document.querySelector('.git-pane-popover')"), true, 'Clicking a stack keeps the details open when the pointer leaves')
    await escape()
    await until("!document.querySelector('.git-pane-popover')")

    await scenario('mixed')
    await hover('.git-pane-pr')
    await until("!!document.querySelector('.git-pane-popover')")
    const visibleChecks = () => run("[...document.querySelectorAll('.git-pane-check-list li')].filter(row=>row.checkVisibility()).map(row=>row.querySelector('a,span').textContent)")
    const attentionChecks = ['Failing job 1', 'Failing job 2', 'Failing job 3', 'Failing job 4', 'Pending job 1', 'Pending job 2']
    assert.deepEqual(await visibleChecks(), attentionChecks,
      'All failing and pending checks are visible, with failures first even when successful checks precede them in the response')
    assert.match(await run("document.querySelector('.git-pane-passing-checks summary').textContent"), /12 passing/)
    await screenshot('git-pane-context-many-passing-wide')
    await click('.git-pane-passing-checks summary')
    await until("document.querySelector('.git-pane-passing-checks').open")
    assert.deepEqual(await visibleChecks(), [...attentionChecks, ...Array.from({ length: 12 }, (_, index) => `Passing job ${index + 1}`)],
      'Expanding the successful checks retains every failure and exposes every passing result')
    await click('.git-pane-passing-checks a')
    assert.equal(await run('openedLinks.at(-1)'), 'https://github.com/block/alto/actions/runs/100', 'Expanded checks retain their CI links')
    await screenshot('git-pane-context-many-passing-expanded')
    await click('.git-pane-passing-checks summary')
    await until("!document.querySelector('.git-pane-passing-checks').open")
    assert.deepEqual(await visibleChecks(), attentionChecks, 'Collapsing passing checks keeps all failures visible')
    await escape()

    for (const theme of ['light', 'dark']) {
      for (const width of [1100, 640, 360]) {
        win.setContentSize(width, 460)
        await until(`innerWidth===${width}`)
        await run(`document.documentElement.dataset.altoTheme=${JSON.stringify(theme)}`)
        await scenario('long')
        const state = await run('observe()')
        await screenshot(`git-pane-context-${theme}-${width}`)
        assert.equal(state.overflow, false, `Long branches fit at ${width}px`)
        for (const child of state.header) {
          assert.ok(child.left >= 0 && child.right <= width, `Header control stays within ${width}px: ${JSON.stringify(child)}`)
        }
        for (const control of state.controls) {
          assert.ok(control.scroll <= control.client + 1, `Control contents do not overlap adjacent controls at ${width}px: ${JSON.stringify(control)}`)
        }
        assert.ok(state.branchTextWidth >= 12, 'A narrow pane keeps some branch text visible alongside the icon')
        await hover('.git-pane-pr')
        await until("!!document.querySelector('.git-pane-popover')")
        const popover = await run("(()=>{const box=document.querySelector('.git-pane-popover').getBoundingClientRect();return {left:box.left,right:box.right,top:box.top,bottom:box.bottom}})()")
        assert.ok(popover.left >= 0 && popover.right <= width && popover.top >= 0 && popover.bottom <= 460,
          `CI details stay within ${width}px: ${JSON.stringify(popover)}`)
        await screenshot(`git-pane-context-${theme}-${width}-ci`)
      }
    }
    win.setContentSize(1100, 460)
    await until('innerWidth===1100')
    await run("document.getElementById('root').style.width='360px'")
    await scenario('long')
    const split = await run('observe()')
    await screenshot('git-pane-context-narrow-split')
    assert.ok(split.header.every(child => child.left >= 0 && child.right <= 360), 'Header controls also fit a narrow pane within a wide window')
    assert.ok(split.controls.every(control => control.scroll <= control.client + 1), 'Narrow split controls do not spill over one another')
    assert.ok(split.branchTextWidth >= 12)
    await hover('.git-pane-pr')
    await until("!!document.querySelector('.git-pane-popover')")
    assert.equal(await run("(()=>{const box=document.querySelector('.git-pane-popover').getBoundingClientRect();return box.left>=0&&box.right<=360})()"), true,
      'The hover preview stays inside its chat pane rather than covering an adjacent native pane')
    await screenshot('git-pane-context-narrow-split-ci')
    await scenario('mixed')
    await hover('.git-pane-pr')
    await until("!!document.querySelector('.git-pane-popover')")
    assert.deepEqual(await visibleChecks(), attentionChecks, 'A narrow split keeps every failing and pending check available')
    assert.equal(await run("(()=>{const box=document.querySelector('.git-pane-popover').getBoundingClientRect();return box.left>=0&&box.right<=360&&box.bottom<=460})()"), true,
      'A check list with many passing jobs fits within the narrow pane')
    await screenshot('git-pane-context-many-passing-narrow')
    console.log('Git pane context browser checks passed')
  } finally {
    win.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
