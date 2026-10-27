const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
app.on('window-all-closed', () => {})
async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
      import {EditorPane,EditorPanes} from './program/plugins/editor-pane.client';
      import styles from './program/plugins/editor-pane.css';
      const style=document.createElement('style');style.textContent=styles;document.head.append(style);
      const root=createRoot(document.getElementById('root'));let fail=false,visible=true;
      const host={call:async()=>{if(fail)throw new Error('Neovim is not installed. Install nvim, then retry opening the editor.');return {command:'nvim .',workingDirectory:'/repo'}}};
      const editors=new EditorPanes({},{});
      let mounts=0,unmounts=0;
      const Terminal=props=>{React.useEffect(()=>{mounts++;return()=>{unmounts++}},[]);return <div data-terminal="" data-active={props.active} style={{width:'100%',height:'100%',background:'var(--canvas)'}}>Neovim content</div>};
      let workspace='/repo';
      window.render=()=>flushSync(()=>root.render(<section className="workspace-chat-pane workspace-typed-pane" style={{height:'100vh',width:'100%'}}>
        <header className="workspace-pane-header"><div className="workspace-pane-actions"><button aria-label="Close pane">×</button></div></header>
        <div className="workspace-typed-pane-content"><EditorPane workspaceId="tab" pane={{id:'pane',workspace,kind:'editor'}} visible={visible} focused={true} host={host} Terminal={Terminal} editors={editors}/></div>
      </section>));
      window.hide=()=>{visible=false;render()};window.show=()=>{visible=true;render()};
      window.fail=()=>{fail=true;workspace='/missing';render()};window.recover=()=>{fail=false;document.querySelector('.editor-pane-status button').click()};
      window.metrics=()=>{const rect=s=>document.querySelector(s).getBoundingClientRect();return {terminalTop:rect('[data-terminal]').top,headerBottom:rect('.editor-pane-header').bottom,controlsBottom:rect('.workspace-pane-header').bottom,right:rect('[data-terminal]').right,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,mounts,unmounts}};
      window.teardown=()=>root.unmount();render();
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all(['src/client/styles.css','program/plugins/theme.css','program/plugins/workspace-layout.css'].map(file=>fs.readFile(file,'utf8')))).join('\n').replace(/@import[^;]+;/g,'')
  const window = new BrowserWindow({show:false,width:1000,height:650,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}})
  const run = code => window.webContents.executeJavaScript(code)
  const paint = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  try {
    await window.loadURL('data:text/html,'+encodeURIComponent('<!doctype html><style>'+css+'</style><div id="root" class="workspace-layout-root"></div>'))
    await run(bundle.outputFiles[0].text);await paint()
    for(const width of [1000,360]) {
      window.setContentSize(width,650);await paint()
      const metrics=await run('metrics()')
      assert.equal(metrics.overflow,false,JSON.stringify(metrics))
      assert.ok(metrics.terminalTop>=metrics.headerBottom && metrics.terminalTop>=metrics.controlsBottom,JSON.stringify(metrics))
      assert.ok(metrics.right<=width,JSON.stringify(metrics))
      if(process.env.ALTO_EDITOR_ARTIFACT_DIR){await fs.mkdir(process.env.ALTO_EDITOR_ARTIFACT_DIR,{recursive:true});await fs.writeFile(path.join(process.env.ALTO_EDITOR_ARTIFACT_DIR,`editor-${width}.png`),(await window.webContents.capturePage()).toPNG())}
    }
    await run('hide()');await paint();await run('show()');await paint()
    assert.equal((await run('metrics()')).mounts,1,'Tab switches keep the terminal mounted')
    assert.equal((await run('metrics()')).unmounts,0)
    await run('fail()');await paint()
    assert.equal(await run('!!document.querySelector("[role=alert]")'),true)
    await run('recover()');await paint()
    assert.equal(await run('!!document.querySelector("[data-terminal]")'),true)
    await run('teardown()')
    console.log('Editor pane layout checks passed at 1000 and 360 pixels')
  } finally { window.destroy() }
}
check().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)})
