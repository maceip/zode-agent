const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'queued-messages.tsx', loader: 'tsx', contents: `
      import React,{useSyncExternalStore} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {SessionService} from './program/plugins/session.client';
      import {SteerQueue,SteerSurface} from './program/plugins/steer.client';
      import {ActivityTimeline} from './program/plugins/ui/activity';
      const events=new Set();let remote=[],serial=0;
      const emit=(method,params)=>{for(const listener of events)listener({type:'codex.notification',payload:{method,params}})};
      const summary={id:'thread-a',title:'Test',preview:'',cwd:'/tmp',createdAt:1,updatedAt:1};
      const harness={codex:{status:'ready',models:[],activeThreadIds:[],threadStates:{},threadSettings:{}},
        program:{revision:0,profileText:'',plugins:[],files:[],tools:[],proposals:[]},projects:{revision:0,projects:[]},
        ui:{regions:[],surfaces:[],contributions:[]},extensions:{},pendingRequests:[],server:{port:1,host:'localhost',projectRoot:'/tmp'}};
      const state={revision:0,connectionEpoch:1,connection:'online',connected:true,snapshot:harness};
      window.starts=0;
      const accept=()=>{
        const message=remote.shift();if(!message)return;
        const turnId='turn-'+message.id;
        emit('thread/queue/changed',{threadId:'thread-a'});
        emit('turn/started',{threadId:'thread-a',turn:{id:turnId}});
        for(const method of ['item/started','item/completed']) emit(method,{threadId:'thread-a',turnId,
          item:{id:'input-'+message.id,type:'userMessage',content:message.input}});
        return {id:turnId};
      };
      const host={snapshot:()=>state,subscribe:()=>()=>{},journal:()=>[],programActivated:()=>{},
        onEvent:listener=>{events.add(listener);return()=>events.delete(listener)},
        command:async method=>method==='thread.open'?{summary,messages:[]}:[],
        call:async(method,payload)=>{
          if(method==='steer.queue.list')return [...remote];
          if(method==='steer.queue.add'){
            const message={id:String(++serial),input:[{type:'text',text:payload.draft.text}]};remote.push(message);return message;
          }
          if(method==='steer.queue.start'){window.starts++;return accept()}
          return [];
        }};
      const session=new SessionService(host),queue=new SteerQueue(host);
      const root=createRoot(document.getElementById('root'));
      function Chat(){const state=useSyncExternalStore(session.subscribe,session.snapshot);return <>
        <ActivityTimeline items={state.activities} active={state.turn.tag==='running'} markdown={false}/>
        <SteerSurface surface={{id:'queue',kind:'steer'}} session={session} queue={queue}/>
      </>}
      window.ready=(async()=>{await session.openThread(summary);
        emit('turn/started',{threadId:'thread-a',turn:{id:'initial'}});
        flushSync(()=>root.render(<Chat/>));
      })();
      window.enqueue=text=>queue.enqueue('thread-a',{text,images:[],attachments:[],skills:[]});
      window.autoStart=()=>flushSync(()=>{emit('turn/completed',{threadId:'thread-a',turn:{id:'initial',status:'completed'}});accept()});
      window.finish=()=>flushSync(()=>emit('turn/completed',{threadId:'thread-a',turn:{id:'turn-'+serial,status:'completed'}}));
      window.teardown=()=>{root.unmount();queue.dispose();session.dispose()};
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all([
    'src/client/styles.css', 'program/plugins/theme.css', 'program/plugins/steer.css',
  ].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => {
    response.end('<!doctype html><style>' + css + '</style><body style="margin:0"><main id="root" style="padding:16px;min-width:0"></main></body>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: {
    offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } })
  const run = code => window.webContents.executeJavaScript(code)
  const frames = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const until = async expression => {
    for (let index = 0; index < 100; index++) { if (await run(expression)) return; await frames() }
    throw new Error('Timed out: ' + expression)
  }
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await run('ready')
    await run("enqueue('Queued follow-up')")
    await until("document.querySelectorAll('.steer-row').length===1")
    assert.equal(await run("document.querySelectorAll('.activity-user').length"), 0)
    await run('autoStart()')
    await until("document.querySelectorAll('.steer-row').length===0 && document.querySelectorAll('.activity-user').length===1")
    assert.equal(await run('starts'), 0, 'App Server can start the message without the queue UI doing so')
    assert.equal(await run("document.querySelector('.activity-user').textContent.startsWith('Queued follow-up')"), true)

    await run("enqueue('Second queued follow-up')")
    await until("document.querySelectorAll('.steer-row').length===1")
    await run('finish()')
    await until("document.querySelectorAll('.steer-row').length===0 && document.querySelectorAll('.activity-user').length===2")
    assert.equal(await run('starts'), 1)
    assert.equal(await run("document.querySelectorAll('.activity-user')[1].textContent.startsWith('Second queued follow-up')"), true)
    for (const width of [1000, 360]) {
      window.setContentSize(width, 760)
      await frames()
      assert.equal(await run("[...document.querySelectorAll('.activity-user')].every(item=>item.getBoundingClientRect().width>0 && item.getBoundingClientRect().right<=innerWidth)"), true)
      assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'), true)
    }
    console.log('Queued message browser checks passed')
  } finally {
    await run('teardown()').catch(() => {})
    window.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
