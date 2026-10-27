const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'question-spacing.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {ActivityTimeline} from './program/plugins/ui/activity';
      const root=createRoot(document.getElementById('root'));
      const question='Should this change keep synchronous delivery, or add durable background delivery? Background delivery changes when events are acknowledged and adds retry state.';
      let items=[];
      const session={snapshot:()=>({threadId:'chat',connected:true,turn:{tag:'running'}}),subscribe:()=>()=>{},
        steer:async draft=>{items=[...items,{id:'reply',kind:'user',title:'You',content:draft.text,timestamp:'',continuesTurn:true}];render()}};
      function render(){flushSync(()=>root.render(<ActivityTimeline items={items} active session={session}/>))}
      window.start=()=>{
        localStorage.clear();
        flushSync(()=>root.render(null));
        items=[{id:'question',kind:'agent',title:'Codex',content:question,status:'streaming',timestamp:'',delivery:'async',
          questions:[{title:question,options:['Keep synchronous delivery for this change','Add durable delivery with background retries','Investigate other approaches before changing behavior']}]}];
        render();
      };
      window.complete=()=>{items=items.map(item=>({...item,status:'completed'}));render()};
      window.answer=()=>{document.querySelector('input[type=radio]').click();
        flushSync(()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))};
      window.teardown=()=>flushSync(()=>root.unmount());
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all([
    'src/client/styles.css', 'program/plugins/ui/default.css', 'program/plugins/ui/user-input.css',
  ].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => response.end('<!doctype html><style>' + css + `
    body{margin:0;background:var(--canvas);overflow:auto}#root{width:auto;height:auto;max-width:720px;margin:auto;padding:24px}
  </style><div id="root"></div>`))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: {
    offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } })
  const run = code => win.webContents.executeJavaScript(code)
  const frames = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const until = async expression => {
    for (let index = 0; index < 100; index++) { if (await run(expression)) return; await frames() }
    throw new Error('Timed out: ' + expression)
  }
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    for (const width of [1000, 360]) {
      win.setContentSize(width, 760)
      await run('start()')
      await frames()
      const before = await run("document.querySelector('[data-activity-id=question]').getBoundingClientRect().height")
      await run('complete()')
      await until("!document.querySelector('.activity-streaming')")
      await run('answer()')
      await until("!!document.querySelector('.input-question-answered') && !!document.querySelector('[data-activity-id=reply]')")
      await frames()
      const metrics = await run(`(()=>{
        const question=document.querySelector('[data-activity-id=question]'),card=document.querySelector('.input-question-answered'),reply=document.querySelector('[data-activity-id=reply]');
        return {height:question.getBoundingClientRect().height,gap:reply.getBoundingClientRect().top-card.getBoundingClientRect().bottom,minHeight:question.style.minHeight};
      })()`)
      if (process.env.ALTO_QUESTION_SPACING_ARTIFACT_DIR) {
        await fs.mkdir(process.env.ALTO_QUESTION_SPACING_ARTIFACT_DIR, { recursive: true })
        await fs.writeFile(path.join(process.env.ALTO_QUESTION_SPACING_ARTIFACT_DIR, width + '.png'), (await win.webContents.capturePage()).toPNG())
      }
      assert.ok(metrics.height < before - 50, 'Answering should release the space used by choices: ' + JSON.stringify({ before, ...metrics }))
      assert.ok(metrics.gap >= 0 && metrics.gap <= 64, 'The reply should follow the answered card with normal chat spacing: ' + JSON.stringify(metrics))
    }
    await run('teardown()')
    console.log('Question spacing browser checks passed')
  } finally {
    win.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
