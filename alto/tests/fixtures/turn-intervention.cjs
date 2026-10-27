const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'turn-intervention.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {ConversationSurface} from './program/plugins/ui-surfaces.client';
      import {ComposerSurface,ComposerPreferenceController} from './program/plugins/composer.client';
      import {ComposerActions} from './program/plugins/composer-actions';
      import {createSteerSubmitMiddleware,SteerQueue} from './program/plugins/steer.client';

      // Offscreen windows have no OS focus. Exercise the visible conversation path.
      Object.defineProperty(document,'hasFocus',{value:()=>true});
      let state={revision:0,threadId:'chat-one',turn:{tag:'running'},connected:true,canAcceptDirectInput:true,
        projects:[],skills:[],session:{workspace:'/tmp',permissionMode:'full'},
        activities:[
          {id:'user',kind:'user',title:'You',content:'Apply this change',timestamp:'',createdAtMs:Date.now()},
          {id:'trace',kind:'reasoning',title:'Thinking',content:'Checking which workspace needs the change.',status:'completed',timestamp:''},
          {id:'question',kind:'agent',title:'Astra',content:'Which workspace should I use?',phase:'final_answer',timestamp:''}
        ],
        harness:{codex:{status:'ready',models:[],threadStates:{'chat-one':{status:{type:'active',activeFlags:[]}}}},pendingRequests:[],program:{proposals:[]}}
      };
      const listeners=new Set();
      const publish=()=>{state={...state,revision:state.revision+1};for(const fn of listeners)fn()};
      window.setFlags=flags=>flushSync(()=>{
        state={...state,harness:{...state.harness,codex:{...state.harness.codex,threadStates:{'chat-one':{status:{type:'active',activeFlags:flags}}}}}};
        publish();
      });
      window.calls=[];window.queueSizes=[];
      const session={snapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
        send:async draft=>window.calls.push({kind:'send',draft}),
        steer:async draft=>{window.calls.push({kind:'steer',draft});window.setFlags([])},
        interrupt:async()=>{},loadEarlierActivities:async()=>{},resolveRequest:async()=>{},resolveProposal:async()=>{}
      };
      const queue=new SteerQueue();queue.subscribe(()=>window.queueSizes.push(queue.snapshot().length));
      const middleware=createSteerSubmitMiddleware(queue,{snapshot:()=>({...state,threadId:'other-chat'}),steer:async()=>{throw new Error('Wrong pane')}});
      const ui={subscribe:()=>()=>{},snapshot:()=>0,component:()=>undefined,canSubmitDuringTurn:()=>true,
        submit:(draft,next,request)=>middleware(draft,next,request)};
      const markdownState={codeBlocks:[],fileLinks:[]};
      const markdown={subscribe:()=>()=>{},snapshot:()=>markdownState};
      const preferences=new ComposerPreferenceController(false,{getItem:()=>null,setItem:()=>{}});
      const composer={attach:async()=>{},actions:new ComposerActions()};
      flushSync(()=>createRoot(document.getElementById('root')).render(<>
        <header className="alto-pane-header">Astra · intervention test</header>
        <ConversationSurface surface={{id:'conversation',kind:'conversation'}} session={session} ui={ui} markdown={markdown}/>
        <ComposerSurface surface={{id:'composer',kind:'composer',capabilities:[]}} session={session} ui={ui} composer={composer} preferences={preferences}/>
      </>));
      window.typeDraft=text=>flushSync(()=>{
        const editor=document.querySelector('[data-cordis-composer-editor]');editor.focus();editor.textContent=text;
        editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
      });
      window.sendReply=()=>flushSync(()=>document.querySelector('[aria-label="Send reply"]').click());
      window.keySubmit=(metaKey=false)=>flushSync(()=>document.querySelector('[data-cordis-composer-editor]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey,bubbles:true,cancelable:true})));
      window.queueCount=()=>queue.snapshot().length;
      window.observe=()=>({
        summary:document.querySelector('.activity-turn-summary').textContent,
        shimmer:document.querySelectorAll('.activity-turn-live-trace').length,
        overlays:document.querySelectorAll('.activity-reasoning .activity-shimmer-sweep').length,
        label:document.querySelector('.send-button').getAttribute('aria-label'),
        draft:document.querySelector('[data-cordis-composer-editor]').textContent,
        focused:document.activeElement.hasAttribute('data-cordis-composer-editor'),
        bounds:[...document.querySelectorAll('.activity-turn-final,.composer,.send-button,.activity-turn-summary')].map(el=>{
          const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};
        }),width:innerWidth,height:innerHeight
      });
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all([
    'src/client/styles.css', 'program/plugins/ui/default.css', 'program/plugins/theme.css', 'program/plugins/ui/user-input.css',
  ].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((request, response) => {
    if (request.url === '/fonts/Inter[opsz,wght].ttf') {
      void fs.readFile('public/fonts/Inter[opsz,wght].ttf').then(bytes => response.end(bytes))
      return
    }
    response.end('<!doctype html><style>' + css + '\n#root{display:flex;flex-direction:column;height:100vh;width:100%;max-width:900px;margin:auto}</style><body><main id="root"></main></body>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const run = code => window.webContents.executeJavaScript(code)
  const settle = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await settle()
    await run("typeDraft('Use this workspace')")
    const working = await run('observe()')
    assert.equal(working.shimmer, 1)
    assert.ok(working.overlays > 0)
    assert.equal(working.label, 'Queue message')

    await run("setFlags(['waitingOnUserInput'])")
    const waiting = await run('observe()')
    assert.equal(waiting.summary, 'Waiting for your reply')
    assert.equal(waiting.shimmer, 0)
    assert.equal(waiting.overlays, 0)
    assert.equal(waiting.label, 'Send reply')
    assert.equal(waiting.draft, 'Use this workspace')
    assert.equal(waiting.focused, true)

    for (const width of [1000, 360]) {
      window.setContentSize(width, 760)
      await settle()
      const view = await run('observe()')
      for (const bounds of view.bounds) {
        assert.ok(bounds.left >= 0 && bounds.right <= width, JSON.stringify(view))
        assert.ok(bounds.top >= 0 && bounds.bottom <= view.height, JSON.stringify(view))
      }
      const content = await run("document.querySelector('.activity-turn-final').getBoundingClientRect().bottom")
      const composerTop = await run("document.querySelector('.composer').getBoundingClientRect().top")
      assert.ok(content <= composerTop, 'Question must stay above composer: ' + JSON.stringify(view))
      if (process.env.ALTO_INTERVENTION_ARTIFACT_DIR) {
        await fs.mkdir(process.env.ALTO_INTERVENTION_ARTIFACT_DIR, { recursive: true })
        await fs.writeFile(path.join(process.env.ALTO_INTERVENTION_ARTIFACT_DIR, `waiting-${width}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }

    await run('sendReply()')
    await settle()
    assert.deepEqual(await run('calls'), [{kind:'steer',draft:{text:'Use this workspace',images:[],attachments:[],skills:[]}}])
    assert.deepEqual(await run('queueSizes'), [], 'Reply must never appear in the queue')
    assert.equal(await run('queueCount()'), 0)
    const resumed = await run('observe()')
    assert.equal(resumed.draft, '')
    assert.equal(resumed.shimmer, 1)
    assert.ok(resumed.overlays > 0)
    assert.ok(resumed.summary.startsWith('Working for '))

    for (const metaKey of [false, true]) {
      await run("setFlags(['waitingOnUserInput']);typeDraft('Keyboard reply')")
      await run(`keySubmit(${metaKey})`)
      assert.equal(await run('calls.at(-1).kind'), 'steer')
      assert.equal(await run('queueCount()'), 0)
    }
    assert.equal(await run('calls.length'), 3)

    await run("setFlags(['waitingOnApproval']);typeDraft('A follow-up')")
    const approval = await run('observe()')
    assert.equal(approval.summary, 'Waiting for approval')
    assert.equal(approval.overlays, 0)
    assert.equal(approval.label, 'Queue message')
    await run('keySubmit()')
    assert.equal(await run('queueCount()'), 1, 'Ordinary text must not answer a pending approval')
    assert.equal(await run('calls.length'), 3)
    console.log('Turn intervention browser checks passed')
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
    app.quit()
  }
}
check().catch(error => { console.error(error); app.exit(1) })
