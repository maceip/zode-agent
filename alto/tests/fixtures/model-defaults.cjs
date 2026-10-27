const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'alto-model-defaults-ui-'))
app.setPath('userData', userData)
app.once('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }))

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'model-defaults-fixture.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import install from './program/plugins/ui-surfaces.client';
      const root=createRoot(document.getElementById('root'));
      const providers=[
        {id:'claude',agentId:'claude',label:'Claude',protocol:'acp',location:{id:'local',label:'Local'}},
        {id:'gemini',agentId:'gemini',label:'Gemini',protocol:'acp',location:{id:'local',label:'Local'}},
        {id:'pi',agentId:'pi',label:'Pi',protocol:'acp',location:{id:'local',label:'Local'}},
        {id:'cloud-gemini',agentId:'gemini',label:'Gemini',protocol:'remote',location:{id:'cloud',label:'Cloud'}}
      ];
      let hostState={connected:true,revision:1,connectionEpoch:1,connection:'online',snapshot:{
        codex:{models:[{id:'codex-global',displayName:'Codex global',isDefault:true,defaultReasoningEffort:'high',
          supportedReasoningEfforts:[{reasoningEffort:'high'}]}]},
        extensions:{'model-defaults':{providerId:'codex',choices:{codex:{model:'codex-global',effort:'high'}}},
          'agent-chats':{providers,threads:[]}},server:{projectRoot:'/tmp/project'}
      }};
      const listeners=new Set();
      const calls=[],setters=[];
      let fail=false;
      const publish=preferences=>{
        hostState={...hostState,revision:hostState.revision+1,snapshot:{...hostState.snapshot,
          extensions:{...hostState.snapshot.extensions,'model-defaults':preferences}}};
        listeners.forEach(listener=>listener());
      };
      const host={snapshot:()=>hostState,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
        command:()=>{throw new Error('Settings invoked a native session command')},call:async(method,payload)=>{
          calls.push({method,payload});
          if(fail){fail=false;throw new Error('Cannot save test defaults')}
          if(method==='model-defaults.discover')return {configOptions:[{id:'model',name:'Model',category:'model',currentValue:'gemini-native',
            options:[{value:'gemini-4-argon',name:'Gemini 4 Argon'},{value:'gemini-native',name:'Gemini native'}]}]};
          if(method!=='model-defaults.set')throw new Error('Unexpected agent startup: '+method);
          const preferences=structuredClone(hostState.snapshot.extensions['model-defaults']);
          preferences.providerId=payload.providerId;
          const choice=preferences.choices[payload.providerId]??={};
          for(const key of ['model','effort'])if(key in payload){
            if(payload[key]===null)delete choice[key];else choice[key]=payload[key];
          }
          publish(preferences);return preferences;
        }};
      const state={revision:1,connected:true,providerId:'gemini',providers,models:[{id:'session-only',displayName:'Session Argon'}],
        session:{workspace:'/tmp/project',permissionMode:'ask',model:'session-only'},threadId:'active-chat',turn:{tag:'idle'},projects:[],
        harness:{codex:{models:[{id:'wrong-model',displayName:'Wrong focused Codex model',isDefault:true}]}}};
      const session={snapshot:()=>state,subscribe:()=>()=>{},setModel:value=>setters.push(['model',value]),
        setEffort:value=>setters.push(['effort',value]),setProvider:value=>setters.push(['provider',value])};
      const overlayListeners=new Set();let overlay='settings';
      const overlays={snapshot:()=>overlay,subscribe:listener=>{overlayListeners.add(listener);return()=>overlayListeners.delete(listener)},
        close:()=>{overlay=undefined;overlayListeners.forEach(listener=>listener())},
        open:id=>{overlay=id;overlayListeners.forEach(listener=>listener())}};
      const surfaces=new Map();const cleanups=[];
      const programState={diagnostics:[]};
      const program={subscribe:()=>()=>{},snapshot:()=>programState};
      const ui={overlays,subscribe:()=>()=>{},snapshot:()=>1,settingsPages:()=>[],
        registerStyle:(_ctx,id,css)=>{const style=document.createElement('style');style.dataset.id=id;style.textContent=css;document.head.append(style)},
        registerSurface:(_ctx,id,component)=>surfaces.set(id,component),registerComponent:()=>{},registerContributionRenderer:()=>{}};
      install({clientHost:host,clientSession:session,clientUi:ui,clientProgram:program,clientMarkdown:{},
        effect:callback=>{const cleanup=callback();if(typeof cleanup==='function')cleanups.push(cleanup)}});
      const Settings=surfaces.get('default-settings');
      window.boot=()=>flushSync(()=>root.render(<Settings surface={{id:'default-settings',kind:'settings'}}/>));
      window.showModels=()=>flushSync(()=>[...document.querySelectorAll('.program-modal-nav-item')].find(node=>node.textContent==='Model & reasoning').click());
      window.choose=(label,value)=>flushSync(()=>{const element=document.querySelector('select[aria-label="'+label+'"]');
        element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}))});
      window.click=label=>flushSync(()=>[...document.querySelectorAll('button')].find(node=>node.textContent===label).click());
      window.reopen=()=>{flushSync(()=>overlays.close());flushSync(()=>overlays.open('settings'))};
      window.publish=value=>flushSync(()=>publish(value));
      window.failSave=()=>{fail=true};
      window.read=()=>({preferences:hostState.snapshot.extensions['model-defaults'],calls,setters,threadId:state.threadId,text:document.body.textContent,
        selects:[...document.querySelectorAll('.model-defaults-settings select')].map(node=>({label:node.getAttribute('aria-label'),value:node.value,disabled:node.disabled,
          options:[...node.options].map(option=>({value:option.value,label:option.textContent,disabled:option.disabled}))}))});
      window.bounds=()=>({width:innerWidth,overflow:document.body.scrollWidth>innerWidth,
        modal:(()=>{const rect=document.querySelector('.program-modal').getBoundingClientRect();return {left:rect.left,right:rect.right}})(),
        controls:[...document.querySelectorAll('.model-defaults-settings select,.model-defaults-load,[aria-label="Close settings"]')]
          .map(node=>{const rect=node.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width}})});
      window.teardown=()=>{root.unmount();cleanups.reverse().forEach(cleanup=>cleanup())};
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await fsp.readFile('src/client/styles.css', 'utf8')).replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => {
    response.end('<!doctype html><style>' + css + '</style><div class="shell-kernel"><div id="root"></div></div>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const run = code => window.webContents.executeJavaScript(code)
  const settle = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const select = (label, value) => run(`choose(${JSON.stringify(label)},${JSON.stringify(value)})`).then(settle)
  const read = () => run('read()')
  const get = (state, label) => state.selects.find(select => select.label === label)
  const screenshot = async name => {
    if (!process.env.ALTO_MODEL_DEFAULTS_ARTIFACT_DIR) return
    await run('document.getAnimations().forEach(animation=>animation.finish())')
    await settle()
    const painted = new Promise(resolve => window.webContents.once('paint', resolve))
    window.webContents.invalidate()
    await painted
    await fsp.mkdir(process.env.ALTO_MODEL_DEFAULTS_ARTIFACT_DIR, { recursive: true })
    await fsp.writeFile(path.join(process.env.ALTO_MODEL_DEFAULTS_ARTIFACT_DIR, name), (await window.webContents.capturePage()).toPNG())
  }
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await run('boot()')
    assert.match((await read()).text, /Session Argon/)
    assert.equal((await read()).calls.length, 0)
    await run('showModels()')
    let state = await read()
    assert.deepEqual(get(state, 'Default agent').options.map(option => option.value), ['codex', 'claude', 'gemini', 'pi', 'cloud-gemini'])
    assert.equal(get(state, 'Default agent').options.at(-1).label, 'Gemini · Cloud')
    assert.equal(get(state, 'Default model').value, 'codex-global')
    assert.ok(!get(state, 'Default model').options.some(option => option.value === 'wrong-model'))
    assert.equal(state.calls.length, 0)

    await select('Default agent', 'claude')
    state = await read()
    assert.equal(get(state, 'Default model').options.filter(option => option.label === 'Agent default').length, 1)
    await select('Default agent', 'codex')
    await run('read().calls.length=0')

    await select('Default agent', 'gemini')
    state = await read()
    assert.ok(get(state, 'Default model').options.some(option => option.value === 'gemini-4-argon'))
    assert.equal(get(state, 'Default reasoning effort').disabled, true)
    assert.equal(get(state, 'Default reasoning effort').options[0].label, 'Agent default')
    await select('Default model', 'gemini-4-argon')
    state = await read()
    assert.equal(state.preferences.providerId, 'gemini')
    assert.equal(state.preferences.choices.gemini.model, 'gemini-4-argon')
    assert.deepEqual(state.calls.slice(0, 2), [
      { method: 'model-defaults.set', payload: { providerId: 'gemini' } },
      { method: 'model-defaults.set', payload: { providerId: 'gemini', model: 'gemini-4-argon' } },
    ])
    assert.deepEqual(state.setters, [])
    assert.equal(state.threadId, 'active-chat')
    for (const width of [480, 1280]) {
      window.setContentSize(width, 900)
      await settle()
      await screenshot(`gemini-defaults-${width}.png`)
    }
    window.setContentSize(1280, 900)

    await run('reopen()')
    await run('showModels()')
    state = await read()
    assert.equal(get(state, 'Default agent').value, 'gemini')
    assert.equal(get(state, 'Default model').value, 'gemini-4-argon')
    assert.equal(state.calls.length, 2)

    await select('Default agent', 'claude')
    await select('Default model', 'haiku')
    assert.equal(get(await read(), 'Default reasoning effort').disabled, true)
    await select('Default model', 'opus')
    assert.ok(get(await read(), 'Default reasoning effort').options.some(option => option.value === 'max'))
    await select('Default reasoning effort', 'max')
    await select('Default model', 'sonnet')
    state = await read()
    assert.ok(!get(state, 'Default reasoning effort').options.some(option => option.value === 'max' && !option.disabled))
    assert.equal(state.preferences.choices.claude.effort, undefined)
    assert.deepEqual(state.calls.at(-1), { method: 'model-defaults.set', payload: { providerId: 'claude', model: 'sonnet', effort: null } })
    await select('Default reasoning effort', 'high')
    await select('Default model', 'haiku')
    assert.equal((await read()).preferences.choices.claude.effort, undefined)

    await select('Default agent', 'pi')
    assert.equal(get(await read(), 'Default model').disabled, true)
    assert.equal(get(await read(), 'Default reasoning effort').disabled, true)
    await select('Default agent', 'cloud-gemini')
    state = await read()
    assert.ok(!state.text.includes('Load models'))
    assert.ok(state.calls.every(call => call.method === 'model-defaults.set'))

    await select('Default agent', 'gemini')
    await run('click("Load models")')
    await settle()
    state = await read()
    assert.deepEqual(state.calls.at(-1), { method: 'model-defaults.discover', payload: { providerId: 'gemini', cwd: '/tmp/project' } })
    assert.ok(get(state, 'Default model').options.some(option => option.value === 'gemini-native'))
    assert.equal(get(state, 'Default model').value, 'gemini-4-argon')
    assert.equal(get(state, 'Default reasoning effort').disabled, true)

    await run(`publish({providerId:'gemini',choices:{gemini:{model:'retired-'+ 'a'.repeat(180),effort:'extreme'}}})`)
    state = await read()
    assert.match(get(state, 'Default model').options.find(option => option.value === get(state, 'Default model').value).label, /saved; unavailable/)
    assert.equal(get(state, 'Default reasoning effort').value, '')
    assert.match(state.text, /Saved reasoning “extreme” is unavailable/)
    for (const width of [1280, 700, 480, 340]) {
      window.setContentSize(width, 900)
      await settle()
      const bounds = await run('bounds()')
      assert.equal(bounds.overflow, false, JSON.stringify(bounds))
      assert.ok(bounds.modal.left >= 0 && bounds.modal.right <= width, JSON.stringify(bounds))
      for (const control of bounds.controls) assert.ok(control.width > 0 && control.left >= bounds.modal.left && control.right <= bounds.modal.right, JSON.stringify(bounds))
      await screenshot(`stale-defaults-${width}.png`)
    }
    await run(`publish({providerId:'removed-agent',choices:{'removed-agent':{model:'missing'}}})`)
    assert.equal(get(await read(), 'Default agent').value, 'removed-agent')
    await select('Default agent', 'gemini')
    await run('failSave()')
    await select('Default model', 'gemini-4-argon')
    state = await read()
    assert.match(state.text, /Cannot save test defaults/)
    assert.equal(state.preferences.choices.gemini?.model, undefined)
    await select('Default model', 'gemini-4-argon')
    assert.equal((await read()).preferences.choices.gemini.model, 'gemini-4-argon')
    assert.deepEqual((await read()).setters, [])
    await run('teardown()')
    console.log('Any-agent settings checks passed')
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
