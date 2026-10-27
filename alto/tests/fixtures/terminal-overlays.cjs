const { app, BrowserWindow, ipcMain } = require('./background-electron.cjs')
const { build } = require('esbuild')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
app.on('window-all-closed', () => {})
async function check() {
  await app.whenReady()
  const root = await mkdtemp('/tmp/alto-terminal-overlays-')
  const main = await build({stdin:{resolveDir:process.cwd(),contents:`export {NativeTerminalManager} from './src/desktop/native-terminal-manager';export {nativeTerminalIpc} from './src/shared/native-terminals'`,loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',external:['electron'],define:{'import.meta.url':JSON.stringify(pathToFileURL(__filename).href)}})
  const loaded = {exports:{}}
  new Function('require','module','exports',main.outputFiles[0].text)(require,loaded,loaded.exports)
  const {NativeTerminalManager,nativeTerminalIpc} = loaded.exports
  await build({entryPoints:['src/desktop/preload.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:path.join(root,'preload.cjs')})
  const browser = await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import ghostty from './program/plugins/ghostty-terminal.client';
    import {ClientNativeTerminals} from './src/client/native-terminals';
    import {OverlayStore} from './src/client/plugin-runtime';
    import {WorkspaceTabSwitcher} from './program/plugins/workspace-tab-switcher';
    import {TabSwitcherPopup} from './program/plugins/workspace-tab-switcher.client';
    import switcherCss from './program/plugins/workspace-tab-switcher.css';
    import css from './src/client/styles.css';
    const styles=document.createElement('style');styles.textContent=css+switcherCss;document.head.append(styles);
    const overlays=new OverlayStore();let service;const cleanup=[];
    const ui={overlays,registerStyle:(_owner,_id,css)=>{const s=document.createElement('style');s.textContent=css;document.head.append(s)}};
    ghostty({clientNativeTerminals:new ClientNativeTerminals(),clientUi:ui,clientHost:{},provide:(_id,value)=>service=value,effect:run=>{const dispose=run();cleanup.push(dispose);return dispose}},{});
    const tabs=['Current Neovim workspace','Review source changes','Another workspace'].map((title,i)=>({id:String(i),title,active:i===0,threadIds:[]}));
    const controller=new WorkspaceTabSwitcher({tabs:()=>tabs,selectTab:()=>controller.cancel(),subscribe:()=>()=>{}},overlays);
    cleanup.push(controller.activate());
    const statusValue={revision:0,running:[],finished:[]};const status={snapshot:()=>statusValue,subscribe:()=>()=>{}};
    const root=createRoot(document.getElementById('root'));
    function App(){const state=React.useSyncExternalStore(controller.subscribe,controller.snapshot);const Terminal=service.renderer;
      return <><div style={{position:'fixed',inset:'40px 0 0',background:'white'}}><Terminal workingDirectory="/tmp" command={window.command} focused={true}/></div>
      {state.selectedId&&<TabSwitcherPopup controller={controller} state={state} threadStatus={status}/>}</>}
    window.showOverlay=()=>flushSync(()=>controller.cycle(1));window.hideOverlay=()=>flushSync(()=>controller.cancel());
    window.keydown=e=>{if(e.key==='Escape')hideOverlay()};window.addEventListener('keydown',window.keydown);
    window.stop=()=>{root.unmount();for(const dispose of cleanup.reverse())dispose?.();window.removeEventListener('keydown',keydown)};
    window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    flushSync(()=>root.render(<App/>));
  `},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',loader:{'.css':'text'},define:{'process.env.NODE_ENV':'"production"'}})
  const window = new BrowserWindow({show:false,width:1000,height:700,title:'Alto native overlay check',webPreferences:{preload:path.join(root,'preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false}})
  const native = new NativeTerminalManager(window, process.cwd())
  const states=[]
  for(const [channel,fn] of Object.entries({create:options=>native.create(options),bounds:(id,b)=>native.setBounds(id,b),visible:(id,v)=>{states.push({visible:v});native.setVisible(id,v)},overlay:(id,b)=>{states.push({overlay:b});native.setOverlay(id,b)},focus:id=>{states.push({focus:true});native.focus(id)},configure:(id,c)=>native.configure(id,c),destroy:id=>native.destroy(id)})) ipcMain.handle(nativeTerminalIpc[channel],(_event,...args)=>fn(...args))
  const run=code=>window.webContents.executeJavaScript(code)
  const paint=()=>run('frame()')
  try {
    const source=path.join(root,'overlay-check.rs')
    await writeFile(source,Array.from({length:70},(_,i)=>`// Line ${i+1}: Neovim should remain visible around the popup.\n`).join(''))
    await window.loadURL('data:text/html,<html><title>Alto native overlay check</title><body style="margin:0"><div id="root"></div></body></html>')
    await run('window.command='+JSON.stringify("/opt/homebrew/bin/nvim --clean -n -i NONE "+source))
    await run(browser.outputFiles[0].text)
    await paint()
    for(let i=0;i<50&&!states.some(s=>s.visible);i++)await new Promise(r=>setTimeout(r,40))
    assert.ok(states.some(s=>s.visible))
    states.length=0
    await run('showOverlay()');await paint()
    assert.ok(states.some(s=>s.overlay?.width>0),'The popup bounds are sent to the native bridge')
    assert.ok(!states.some(s=>s.visible===false),'The terminal stays visible while the popup opens')
    for(const [width,height] of [[1000,700],[600,500]]){
      window.setContentSize(width,height);await paint()
      const bounds=await run('(()=>{const r=document.querySelector("[role=dialog]").getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()')
      const overlay=states.filter(s=>s.overlay).at(-1).overlay
      for(const key of ['x','y','width','height']) assert.equal(overlay[key],bounds[key])
    }
    await run('hideOverlay()');await paint()
    assert.equal(states.filter(s=>'overlay'in s).at(-1).overlay,null,'Dismissing the popup removes the mask')
    assert.ok(states.findLastIndex(s=>s.focus) > states.findLastIndex(s=>s.overlay===null),'Keyboard focus returns after the input-blocking mask clears')
    assert.ok(!states.some(s=>s.visible===false),'Opening, resizing, and closing do not hide the terminal')
    if(process.env.ALTO_OVERLAY_INTERACTIVE){
      window.setContentSize(1000,700);window.showInactive();await run('showOverlay()');await paint()
      console.log('Native overlay ready for visual inspection; press Return in the fixture to finish.')
      await new Promise(resolve=>process.stdin.once('data',resolve))
    }
    await run('stop()')
    console.log('Native terminal overlay checks passed: popup clipping, resize, dismissal, and no hiding.')
  } finally {
    native.destroyAll();window.destroy();await rm(root,{recursive:true,force:true})
  }
}
check().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)})
