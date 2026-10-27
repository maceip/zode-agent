const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const http = require('node:http')

// Exercise Chromium's real contenteditable focus behavior without opening a
// visible window or connecting to the user's Alto server.
async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(), sourcefile: 'composer-focus.tsx', loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { Composer } from './program/plugins/ui/composer';
        import composerClient, { ComposerSurface } from './program/plugins/composer.client';
        import { focusComposerEditor } from './program/plugins/ui/composer-focus';
        const root = createRoot(document.getElementById('root'));
        window.submitted = 0;
        let props = {
          value:'draft', images:[], attachments:[], skills:[], models:[],
          permissionMode:'full', workspaceLabel:'No workspace', workspaceOptions:[],
          capabilities:[], placeholder:'Focus test', focusHeight:156, maxHeight:180,
          autoFocus:true, disabled:false, readOnly:false, sending:false,
          activeTurn:false, allowSubmitDuringTurn:true,
          onChange:()=>{}, onImagesChange:()=>{}, onAttachmentsChange:()=>{},
          onAttachFile:async()=>{}, onModelChange:()=>{}, onEffortChange:()=>{},
          onPermissionModeChange:()=>{}, onWorkspaceChange:()=>{},
          onSubmit:()=>window.submitted++, onInterrupt:()=>{}
        };
        window.updateComposer = next => {
          props = {...props, ...next};
          flushSync(() => root.render(<Composer {...props}/>));
        };
        window.editor = () => document.querySelector('[data-cordis-composer-editor]');
        window.focusState = () => ({
          focused:document.activeElement === editor(),
          editable:editor().contentEditable,
          text:editor().textContent,
          offset:getSelection().focusOffset,
          sendDisabled:document.querySelector('.send-button').disabled,
          submitted:window.submitted
        });
        window.updateComposer({});
        let state = {
          connected:true, harness:{codex:{status:'ready',models:[]}}, projects:[],
          session:{workspace:'', permissionMode:'full'}, turn:{tag:'idle'},
          skills:[], canAcceptDirectInput:true, projectScope:'unscoped'
        };
        const listeners = new Set();
        const session = {snapshot:()=>state, subscribe:listener=>{
          listeners.add(listener); return ()=>listeners.delete(listener);
        }, setProvider:providerId=>window.updateSession({providerId}), loadModels:async()=>{
          window.modelRequests++;
          if(window.modelRequests===1) throw new Error('Codex CLI is not installed');
          window.updateSession({harness:{codex:{status:'ready',models:[{id:'test',displayName:'Test model'}]}}});
        }};
        window.modelRequests=0;
        window.clickPicker = label => flushSync(()=>{
          const button = [...document.querySelectorAll('.composer-model-picker button')]
            .find(button=>button.textContent.trim()===label || button.firstElementChild?.textContent===label);
          if(!button) throw new Error('Missing picker button: '+label);
          button.click();
        });
        const cleanup = [];
        composerClient({
          clientSession:session,
          clientHost:{command:()=>Promise.resolve()},
          clientUi:new Proxy({overlays:{}},{get:(target,key)=>target[key]??(()=>{})}),
          effect:fn=>{const dispose=fn(); cleanup.push(dispose); return dispose;},
          provide:(name,value)=>{if(name==='clientComposer')window.composerService=value;}
        },{});
        window.disposeService=()=>cleanup.reverse().forEach(dispose=>dispose?.());
        window.requestEditorFocus=focusComposerEditor;
        const preference = {autoExpand:false};
        const preferences = {snapshot:()=>preference, subscribe:()=>()=>{}};
        const composer = window.composerService;
        const surface = {id:'focus-test',kind:'composer',capabilities:[]};
        window.mountSurface = () => flushSync(()=>root.render(
          <ComposerSurface surface={surface} session={session} composer={composer}
            preferences={preferences} autoFocus={true}
            draftStore={{read:()=>({message:'draft',images:[],attachments:[]}),write:()=>{}}}/>
        ));
        window.updateSession = next => flushSync(()=>{
          state={...state,...next}; for(const listener of listeners) listener();
        });
        window.delayNativeFocus = () => {
          const pending = [];
          window.__ALTO_DESKTOP__ = {nativeViews:{focusHost:()=>new Promise(resolve=>pending.push(resolve))}};
          window.pendingNativeFocus = () => pending.length;
          window.finishNativeFocus = async () => {
            for (const resolve of pending.splice(0)) resolve();
            await Promise.resolve();
          };
        };
      `,
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const server = http.createServer((_request, response) => {
    response.end('<html><body><div id="root"></div><button id="other">Other control</button></body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  const run = code => window.webContents.executeJavaScript(code)
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    assert.equal((await run('focusState()')).focused, true)
    await run('getSelection().setBaseAndExtent(editor().firstChild, 2, editor().firstChild, 2)')

    // Metadata refreshes and repeated reconnects must preserve the editor and
    // its caret. Submission stays blocked while the transport is unavailable.
    for (const width of [1440, 900, 480]) {
      window.setContentSize(width, 800)
      await run('updateComposer({models:[], disabled:true})')
      const disconnected = await run('focusState()')
      assert.equal(disconnected.focused, true)
      assert.equal(disconnected.offset, 2)
      assert.equal(disconnected.editable, 'plaintext-only')
      assert.equal(disconnected.sendDisabled, true)
      await run("editor().dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))")
      assert.equal((await run('focusState()')).submitted, 0)
      await run('updateComposer({disabled:false})')
      const connected = await run('focusState()')
      assert.equal(connected.focused, true)
      assert.equal(connected.offset, 2)
      assert.equal(connected.sendDisabled, false)
    }

    await run('updateComposer({disabled:true})')
    await run("document.execCommand('insertText', false, 'x')")
    await run('updateComposer({disabled:false})')
    assert.equal((await run('focusState()')).text, 'drxaft')

    // A reconnect must not reclaim focus after the user chooses another control.
    await run("document.getElementById('other').focus(); updateComposer({disabled:true})")
    await run('updateComposer({disabled:false})')
    assert.equal(await run('document.activeElement.id'), 'other')

    await run('updateComposer({disabled:true, readOnly:true})')
    assert.equal((await run('focusState()')).editable, 'false')
    assert.equal((await run('focusState()')).sendDisabled, true)
    await run('updateComposer({disabled:true, readOnly:undefined})')
    assert.equal((await run('focusState()')).editable, 'false')

    // A native focus acknowledgement can arrive after keyboard navigation has
    // moved into another split's editor. It must not select the old editor again.
    await run(`
      delayNativeFocus();
      updateComposer({autoFocus:false, disabled:false, readOnly:false});
      updateComposer({autoFocus:true});
      const second = document.createElement('div');
      second.id = 'second-composer';
      second.contentEditable = 'plaintext-only';
      second.textContent = 'other draft';
      document.body.append(second);
      second.focus();
      getSelection().setBaseAndExtent(second.firstChild, 3, second.firstChild, 3);
    `)
    assert.equal(await run('document.activeElement.id'), 'second-composer')
    assert.equal(await run('pendingNativeFocus()'), 1)
    await run('finishNativeFocus()')
    assert.equal(await run('document.activeElement.id'), 'second-composer')
    assert.equal(await run('getSelection().focusOffset'), 3)

    // Explicit focus shortcuts use the same protection as pane autofocus.
    await run(`
      composerService.focus();
      document.getElementById('second-composer').focus();
      getSelection().setBaseAndExtent(second.firstChild, 3, second.firstChild, 3);
    `)
    assert.equal(await run('pendingNativeFocus()'), 1)
    await run('finishNativeFocus()')
    assert.equal(await run('document.activeElement.id'), 'second-composer')
    assert.equal(await run('getSelection().focusOffset'), 3)

    await run("composerService.focus(); document.getElementById('other').focus()")
    await run('finishNativeFocus()')
    assert.equal(await run('document.activeElement.id'), 'other')

    // Unchanged focus still receives the native acknowledgement without moving
    // the caret. Cleanup also cancels requests from a previous pane activation.
    await run(`
      window.focusCalls = 0;
      const original = editor().focus;
      editor().focus = function(options) { window.focusCalls++; original.call(this, options); };
      window.cancelFocus = requestEditorFocus(editor());
      getSelection().setBaseAndExtent(editor().firstChild, 2, editor().firstChild, 2);
    `)
    await run('finishNativeFocus()')
    assert.equal(await run('focusCalls'), 2)
    assert.equal((await run('focusState()')).offset, 2)
    await run('window.cancelFocus = requestEditorFocus(editor()); cancelFocus()')
    await run('finishNativeFocus()')
    assert.equal(await run('focusCalls'), 3)
    await run('window.focusCurrent = true; requestEditorFocus(editor(), () => focusCurrent); window.focusCurrent = false')
    await run('finishNativeFocus()')
    assert.equal(await run('focusCalls'), 4)

    // A hidden or read-only editor must not request native-window focus at all.
    await run(`
      document.getElementById('other').focus();
      editor().style.display = 'none';
      void requestEditorFocus(editor());
    `)
    assert.equal(await run('pendingNativeFocus()'), 0)
    assert.equal(await run('document.activeElement.id'), 'other')
    await run("editor().style.display = ''; updateComposer({readOnly:true}); void requestEditorFocus(editor())")
    assert.equal(await run('pendingNativeFocus()'), 0)
    await run('delete window.__ALTO_DESKTOP__; document.getElementById("second-composer").remove()')

    // Check the real surface's mapping from transport/ownership state to props.
    await run('mountSurface()')
    assert.equal((await run('focusState()')).focused, true)
    await run('getSelection().setBaseAndExtent(editor().firstChild, 2, editor().firstChild, 2)')
    for (const update of [
      '{connected:false}', '{connected:true}',
      '{harness:{codex:{status:"connecting",models:[]}}}',
      '{harness:{codex:{status:"ready",models:[]}}}',
    ]) {
      await run(`updateSession(${update})`)
      assert.equal((await run('focusState()')).focused, true)
      assert.equal((await run('focusState()')).offset, 2)
    }

    // Opening the agent menu must work before Codex starts. Only opening its
    // model list requests the CLI, and a failed request remains retryable.
    await run(`updateSession({providerId:'codex',providers:[
      {id:'codex',label:'Codex'},{id:'claude',label:'Claude'}
    ],harness:{codex:{status:'stopped',models:[]}}})`)
    assert.equal((await run('focusState()')).sendDisabled, false)
    await run("document.querySelector('.composer-model-trigger').click()")
    await run("clickPicker('Agent')")
    assert.equal(await run('modelRequests'), 0)
    await run("clickPicker('Claude')")
    assert.equal(await run('modelRequests'), 0)
    assert.equal((await run('focusState()')).sendDisabled, false)
    await run("updateSession({providerId:'codex'}); document.querySelector('.composer-model-trigger').click()")
    await run("clickPicker('Model')")
    assert.equal(await run('modelRequests'), 1)
    assert.equal(await run("document.querySelector('[role=alert]')?.textContent"), 'Codex CLI is not installed')
    await run("clickPicker('Retry')")
    assert.equal(await run('modelRequests'), 2)
    assert.equal(await run("document.querySelector('[role=alert]')?.textContent"), undefined)
    assert.match(await run("document.querySelector('.composer-picker-options').textContent"), /Test model/)
    await run('updateSession({canAcceptDirectInput:false})')
    assert.equal((await run('focusState()')).editable, 'false')
    assert.equal((await run('focusState()')).sendDisabled, true)
    await run('disposeService()')
    console.log('Composer focus checks passed')
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
