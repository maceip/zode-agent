const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'question-picker.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {ApprovalRequest} from './program/plugins/ui/inspectors';
      const root=createRoot(document.getElementById('root'));
      const sample={id:42,method:'item/tool/requestUserInput',receivedAt:'2026-09-09T00:00:00Z',params:{
        threadId:'chat-one',turnId:'turn-one',itemId:'item-one',isBlocking:true,
        questions:[{id:'scope',header:'Scope',question:'Where should I apply this change?',isOther:true,options:[
          {label:'This workspace (Recommended)',description:'Update the current project and leave other workspaces unchanged.'},
          {label:'All workspaces',description:'Apply the same change across every project.'}
        ]}]
      }};
      window.calls=[];
      window.request=structuredClone(sample);
      let extra;
      window.replyMode='success';
      const resolve=async(id,result)=>{
        window.calls.push({id,result});
        if(window.replyMode==='error')throw new Error('Temporary transport failure');
        if(window.replyMode==='deferred')await new Promise(r=>window.finishReply=r);
      };
      window.render=()=>flushSync(()=>root.render(<>
        <ApprovalRequest request={window.request} resolve={resolve}/>
        {extra && <ApprovalRequest request={extra} resolve={resolve}/>}</>));
      window.reset=(params={})=>{
        window.request={...structuredClone(sample),id:window.request.id+1,params:{...structuredClone(sample.params),...params}};
        extra=undefined;window.calls=[];window.replyMode='success';window.render();
      };
      window.addSecond=()=>{extra={...structuredClone(sample),id:91,params:{...structuredClone(sample.params),threadId:'chat-two'}};window.render()};
      window.click=selector=>flushSync(()=>document.querySelector(selector).click());
      window.type=(selector,value)=>flushSync(()=>{
        const input=document.querySelector(selector);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
        input.dispatchEvent(new Event('input',{bubbles:true}));
      });
      window.submit=()=>flushSync(()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
      window.teardown=()=>flushSync(()=>root.unmount());
      document.getElementById('draft').focus();window.render();
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all([
    'src/client/styles.css', 'program/plugins/ui/default.css', 'program/plugins/theme.css', 'program/plugins/ui/user-input.css',
  ].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((request, response) => {
    if (request.url === '/fonts/Inter[opsz,wght].ttf') {
      void fs.readFile('public/fonts/Inter[opsz,wght].ttf').then(bytes => response.end(bytes)).catch(() => { response.statusCode = 404; response.end() })
      return
    }
    response.end('<!doctype html><style>' + css + '</style><body style="background:var(--canvas);overflow:auto"><main style="max-width:768px;margin:auto;padding:18px"><p>Before I update the project, one choice:</p><div id="root"></div><div contenteditable="plaintext-only" id="draft" aria-label="Composer draft">Keep this draft untouched</div></main></body>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const run = code => window.webContents.executeJavaScript(code)
  const settle = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    assert.equal(await run('document.activeElement.id'), 'draft')
    assert.equal(await run('document.querySelector("button[type=submit]").disabled'), true)
    assert.equal(await run('document.querySelectorAll("input:checked").length'), 0)
    await run('click(".input-question-option")')
    assert.equal(await run('calls.length'), 0, 'Selecting is not permission to send yet')
    assert.equal(await run('document.querySelector("button[type=submit]").disabled'), false)
    await run('document.getElementById("draft").focus();window.request=structuredClone(window.request);render()')
    assert.equal(await run('document.querySelector("input:checked").value'), 'This workspace (Recommended)')
    assert.equal(await run('document.activeElement.id'), 'draft', 'Snapshot refresh must not grab focus')

    // Native radio groups support arrow keys without document-wide shortcuts.
    await run('document.querySelector("input[type=radio]").focus()')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
    await settle()
    assert.equal(await run('document.querySelector("input:checked").value'), 'All workspaces')
    await run("replyMode='deferred';submit();submit()")
    assert.equal(await run('calls.length'), 1)
    assert.deepEqual(await run('calls[0]'), { id: 42, result: { answers: { scope: { answers: ['All workspaces'] } } } })
    assert.equal(await run('document.querySelector("button[type=submit]").disabled'), true)
    await run('finishReply()')
    await settle()
    assert.equal(await run('document.querySelector("button[type=submit]").textContent'), 'Sent')
    await run('submit()')
    assert.equal(await run('calls.length'), 1)

    // A failed transport keeps the answer editable and allows an explicit retry.
    await run('reset();click(".input-question-option:last-child")')
    assert.equal(await run('document.querySelector("button[type=submit]").disabled'), true)
    await run('type(".input-question-custom input", "Only the toolbar");replyMode="error";submit()')
    await settle()
    assert.ok(await run('!!document.querySelector("[role=alert]")'))
    assert.equal(await run('document.querySelector(".input-question-custom input").value'), 'Only the toolbar')
    assert.equal(await run('document.querySelector("button[type=submit]").disabled'), false)
    await run('replyMode="success";submit()')
    await settle()
    assert.deepEqual(await run('calls[1].result'), { answers: { scope: { answers: ['Only the toolbar'] } } })

    // Multi-question requests require every answer. Secret input stays masked.
    await run(`reset({isBlocking:false,questions:[
      {id:'name',header:'Project',question:'Project name?',options:null},
      {id:'secret',header:'Credentials',question:'Access token?',isSecret:true,options:[]}
    ]})`)
    assert.equal(await run('document.querySelector("button[type=submit]").textContent'), 'Send answers')
    await run('type("input[type=text]", "Project name")')
    assert.equal(await run('document.querySelector("button[type=submit]").disabled'), true)
    await run('type("input[type=password]", "test-only-secret");submit()')
    await settle()
    assert.deepEqual(await run('calls[0].result'), { answers: { name: { answers: ['Project name'] }, secret: { answers: ['test-only-secret'] } } })

    // Two chats can ask the same question ID without sharing choices or replies.
    await run('reset();addSecond();click("form:nth-child(2) .input-question-option")')
    assert.equal(await run('document.querySelector("form:first-child button").disabled'), true)
    await run('click("form:nth-child(2) button[type=submit]")')
    await settle()
    assert.equal(await run('calls[0].id'), 91)

    await run('reset();click(".input-question-option")')
    for (const theme of ['light', 'dark']) {
      for (const width of [1000, 360]) {
        window.setContentSize(width, 760)
        await run(`document.documentElement.dataset.altoTheme='${theme}'`)
        await settle()
        const metrics = await run(`(()=>{const card=document.querySelector('form'),r=card.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,scroll:document.documentElement.scrollWidth,cardScroll:card.scrollWidth,cardWidth:card.clientWidth,choiceCount:card.querySelectorAll('input[type=radio]').length,font:getComputedStyle(card).fontSize}})()`)
        assert.ok(metrics.left >= 0 && metrics.right <= metrics.width, JSON.stringify(metrics))
        assert.ok(metrics.scroll <= metrics.width)
        assert.ok(metrics.cardScroll <= metrics.cardWidth)
        assert.equal(metrics.choiceCount, 3)
        assert.equal(metrics.font, '14px')
        if (process.env.ALTO_QUESTION_ARTIFACT_DIR) {
          await fs.mkdir(process.env.ALTO_QUESTION_ARTIFACT_DIR, { recursive: true })
          await fs.writeFile(path.join(process.env.ALTO_QUESTION_ARTIFACT_DIR, `${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG())
        }
      }
    }
    await run('replyMode="deferred";submit();teardown();finishReply()')
    await settle()
    assert.equal(await run('document.querySelector("form")'), null)
    assert.equal(await run('document.getElementById("draft").textContent'), 'Keep this draft untouched')
    console.log('Agent question picker checks passed')
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
