const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'composer-reload.tsx', loader: 'tsx', contents: `
      import React, {useSyncExternalStore} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {BrowserProgramRuntime} from './src/client/plugin-runtime';
      import composer from './program/plugins/composer.client';
      import {COMPOSER_COMPONENT, CONVERSATION_COMPONENT} from './program/plugins/chat-surfaces-api';
      const root=createRoot(document.getElementById('root'));
      const state={connected:true,harness:{codex:{status:'ready',models:[]}},projects:[],
        session:{workspace:'',permissionMode:'full'},turn:{tag:'idle'},skills:[],
        canAcceptDirectInput:true,projectScope:'unscoped'};
      const session={snapshot:()=>state,subscribe:()=>()=>{}};
      let draft={message:'draft',images:[],attachments:[]};
      const draftStore={read:()=>draft,write:value=>{draft=value}};
      const provider=ctx=>ctx.provide('clientSession',session);
      provider.provide='clientSession';
      const view=(id,hash)=>({id,name:id,description:'Focus regression fixture',protocolVersion:1,
        depth:0,enabled:true,effectiveEnabled:true,state:'active',inject:[],provides:[],config:{},isolate:{},intercept:{},
        client:{module:id+'.ts',hash,url:'/'+id+'/'+hash,loadedAt:''}});
      let release,started,revision=1;
      const runtime=new BrowserProgramRuntime(async url=>{
        if(url.startsWith('/session/'))return {default:provider};
        if(url.startsWith('/composer/'))return {default:composer};
        const replacement=revision>1;
        const conversation=async ctx=>{
          if(replacement)await new Promise(resolve=>{release=resolve;started()});
          const Conversation=()=> <div className="conversation" style={{flex:1}}>Conversation revision {revision}</div>;
          ctx.clientUi.registerComponent(ctx,CONVERSATION_COMPONENT,Conversation);
        };
        conversation.inject=['clientUi'];
        return {default:conversation};
      });
      function Page(){
        useSyncExternalStore(runtime.ui.subscribe,runtime.ui.snapshot);
        const Composer=runtime.ui.component(COMPOSER_COMPONENT);
        const Conversation=runtime.ui.component(CONVERSATION_COMPONENT);
        if(!Composer||!Conversation)return <p>Loading interface</p>;
        return <main style={{height:'100vh',display:'flex',flexDirection:'column'}}><Conversation/>
          <Composer surface={{id:'default-composer',kind:'composer',capabilities:[]}}
            session={session} autoFocus={true} draftStore={draftStore}/></main>;
      }
      const entries=()=>[view('session','1'),view('composer','1'),view('conversation',String(revision))];
      window.boot=async()=>{await runtime.reconcile(revision,entries());flushSync(()=>root.render(<Page/>))};
      window.renderHostUpdate=()=>flushSync(()=>root.render(<Page/>));
      window.beginReload=()=>new Promise(resolve=>{
        revision++;started=resolve;window.reloading=runtime.reconcile(revision,entries());
      });
      window.finishReload=async()=>{release();await window.reloading};
      window.editor=()=>document.querySelector('[data-cordis-composer-editor]');
      window.watchEditor=()=>{
        window.originalEditor=editor();window.blurs=0;
        editor().addEventListener('blur',()=>window.blurs++);
      };
      window.focusState=()=>({same:editor()===window.originalEditor,focused:document.activeElement===editor(),
        anchor:getSelection().anchorOffset,offset:getSelection().focusOffset,blurs:window.blurs,
        draft:draft.message,text:editor()?.textContent});
      window.teardown=async()=>{root.unmount();await runtime.dispose()};
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all(['src/client/styles.css', 'program/plugins/ui/default.css']
    .map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => {
    response.end('<!doctype html><style>' + css + '</style><div id="root"></div>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, width: 1440, height: 800,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const run = code => window.webContents.executeJavaScript(code)
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await run('boot()')
    await run('watchEditor();getSelection().setBaseAndExtent(editor().firstChild,2,editor().firstChild,2)')
    for (const width of [1440, 480]) {
      window.setContentSize(width, 800)
      await run('beginReload()')
      // A transport update rerenders the shell before the new renderer registers.
      await run('renderHostUpdate()')
      assert.deepEqual(await run('focusState()'), {
        same: true, focused: true, anchor: 2, offset: 2, blurs: 0, draft: 'draft', text: 'draft',
      })
      await run("document.execCommand('insertText',false,'x')")
      await run('finishReload()')
      assert.deepEqual(await run('focusState()'), {
        same: true, focused: true, anchor: 3, offset: 3, blurs: 0, draft: 'drxaft', text: 'drxaft',
      })
      const bounds = await run(`(()=>{const editorBounds=editor().getBoundingClientRect(),send=document.querySelector('.send-button').getBoundingClientRect();
        return {editorLeft:editorBounds.left,editorRight:editorBounds.right,sendRight:send.right,width:innerWidth,overflow:document.body.scrollWidth>innerWidth}})()`)
      assert.ok(bounds.editorLeft >= 0 && bounds.editorRight <= width && bounds.sendRight <= width, JSON.stringify(bounds))
      assert.equal(bounds.overflow, false)
      if (process.env.ALTO_COMPOSER_ARTIFACT_DIR) {
        await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        await fs.mkdir(process.env.ALTO_COMPOSER_ARTIFACT_DIR, { recursive: true })
        await fs.writeFile(path.join(process.env.ALTO_COMPOSER_ARTIFACT_DIR, `composer-${width}.png`), (await window.webContents.capturePage()).toPNG())
      }
      await run("getSelection().setBaseAndExtent(editor().firstChild,2,editor().firstChild,3);document.execCommand('delete')")
    }
    // An explicit selection is preserved too, not collapsed to a restored caret.
    await run('getSelection().setBaseAndExtent(editor().firstChild,1,editor().firstChild,4);beginReload()')
    await run('renderHostUpdate();finishReload()')
    assert.deepEqual(await run('focusState()'), {
      same: true, focused: true, anchor: 1, offset: 4, blurs: 0, draft: 'draft', text: 'draft',
    })
    await run('teardown()')
    assert.equal(await run('editor()'), null)
    console.log('Composer reload checks passed')
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
