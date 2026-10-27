const {app,BrowserWindow}=require('./background-electron.cjs')
const {build}=require('esbuild')
const assert=require('node:assert/strict')
const fs=require('node:fs/promises')
const http=require('node:http')

async function check(){
  await app.whenReady()
  const bundle=await build({
    stdin:{resolveDir:process.cwd(),sourcefile:'composer-placeholder.tsx',loader:'tsx',contents:`
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {Composer} from './program/plugins/ui/composer';
      const root=createRoot(document.getElementById('root'));
      flushSync(()=>root.render(<Composer value="" images={[]} attachments={[]} skills={[]} models={[]}
        permissionMode="full" workspaceLabel="No workspace" workspaceOptions={[]} capabilities={[]}
        placeholder="Let's build" focusHeight={156} maxHeight={180} autoFocus={false}
        disabled={false} readOnly={false} sending={false} activeTurn={false}
        onChange={value=>window.lastDraft=value} onImagesChange={()=>{}} onAttachmentsChange={()=>{}} onAttachFile={async()=>{}}
        onModelChange={()=>{}} onEffortChange={()=>{}} onPermissionModeChange={()=>{}}
        onWorkspaceChange={()=>{}} onSubmit={()=>{}} onInterrupt={()=>{}}/>));
      window.editor=()=>document.querySelector('[data-cordis-composer-editor]');
      window.placeholderState=()=>({
        text:editor().textContent,
        placeholder:getComputedStyle(editor(),'::before').content,
        focused:document.activeElement===editor(),
        sendDisabled:document.querySelector('.send-button').disabled,
        height:document.querySelector('.composer').getBoundingClientRect().height,
      });
    `},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',
    loader:{'.css':'text'},define:{'process.env.NODE_ENV':'"production"'},
  })
  const css=(await Promise.all(['src/client/styles.css','program/plugins/ui/default.css'].map(file=>fs.readFile(file,'utf8')))).join('\n').replace(/@import[^;]+;/g,'')
  const server=http.createServer((_,res)=>res.end('<!doctype html><style>'+css+'</style><div id="root"></div>'))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const window=new BrowserWindow({show:false,width:800,height:400,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}})
  const run=code=>window.webContents.executeJavaScript(code)
  const paint=()=>run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  try{
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    const initial=await run('placeholderState()')
    assert.equal(initial.placeholder,'"Let\'s build"')
    await run("editor().focus();document.execCommand('insertText',false,'Draft')");await paint()
    assert.equal((await run('placeholderState()')).placeholder,'none')
    for(const insert of [null,'insertParagraph']){
      if(insert){
        await run(`document.execCommand('${insert}')`);await paint()
        assert.ok((await run('lastDraft')).includes('\n'),'Keep deliberately inserted blank lines')
      }
      await run("document.execCommand('selectAll');document.execCommand('delete')");await paint()
      const cleared=await run('placeholderState()')
      assert.equal(cleared.text,'')
      assert.equal(cleared.placeholder,'"Let\'s build"','Clearing a native contenteditable restores its placeholder')
      assert.equal(cleared.sendDisabled,true)
      assert.equal(await run('lastDraft'),'','Native filler nodes are not draft content')
      assert.equal(cleared.focused,true)
      assert.equal(cleared.height,initial.height,'The placeholder must not add a line to the composer')
    }
    await run("document.execCommand('insertText',false,'Next draft')");await paint()
    assert.equal((await run('placeholderState()')).placeholder,'none')
    assert.equal((await run('placeholderState()')).text,'Next draft')
    console.log('Composer placeholder checks passed')
  }finally{window.destroy();await new Promise(resolve=>server.close(resolve))}
}
check().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)})
