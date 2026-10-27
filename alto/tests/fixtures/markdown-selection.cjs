const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')

async function check() {
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'markdown-selection-fixture.tsx', loader: 'tsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
      import markdownPlugin from './program/plugins/markdown-viewer.client'; import composerPlugin from './program/plugins/composer.client';
      import {markdownViewerResource} from './program/plugins/markdown-viewer-api';
      let Pane, Composer, composer, FileLink, visible=true, mounted=true, sourceOpen=true, focused='other';
      let resource=markdownViewerResource('/repo/notes.md','source');
      const cleanup=[],root=createRoot(document.getElementById('root'));window.sends=0;window.requests=[];
      let sourceText='# Project notes\\n\\nKeep **existing records** intact. Verify the migration before release.\\n\\n## Deployment\\n\\nDeploy to staging.\\n\\nDeploy to staging.\\n\\nA [linked passage](https://example.com) and '+String.fromCharCode(96)+'inline code'+String.fromCharCode(96)+' remain selectable.\\n\\n'+String.fromCharCode(96).repeat(3)+'ts\\nconst untouched = true;\\nconst selected = false;\\n'+String.fromCharCode(96).repeat(3)+'\\n\\n'+Array.from({length:30},(_,i)=>'Paragraph '+(i+1)+' keeps enough text in this pane to verify scrolling.').join('\\n\\n');
      const host={call:async(method,payload)=>{
        window.requests.push({method,payload});
        if(method==='markdown-viewer.write'){
          if(window.holdSave)await new Promise(resolve=>{window.releaseSave=resolve});
          if(window.failSave)throw Error('This Markdown file changed on disk. Reload it before saving.');
          sourceText=payload.source;window.saved=payload.source;
        }
        return {path:payload.path,name:payload.path.split('/').at(-1),source:sourceText,modifiedAt:1};
      }};
      const stateFor=id=>({revision:0,connected:true,threadId:id,session:{workspace:'/repo',permissionMode:'full'},turn:{tag:'idle'},projects:[],threads:[],skills:[],activities:[],harness:{codex:{status:'ready',models:[]},extensions:{},program:{proposals:[]}}});
      const session=id=>{const state=stateFor(id);return {snapshot:()=>state,subscribe:()=>()=>{},send:async()=>{window.sends++},steer:async()=>{window.sends++}}};
      const source=session('source'),other=session('other'),fresh=session(undefined);
      const image={name:'pixel.png',mediaType:'image/png',url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlSAAAAAASUVORK5CYII='};
      const store=message=>{let draft={message,images:[image],attachments:[{name:'context.txt',path:'/repo/context.txt'}]};return {read:()=>draft,write:value=>{draft=value}}};
      const drafts=[store('Existing draft'),store('Other draft'),store('New chat draft')];window.drafts=()=>drafts.map(d=>d.read());
      const targets=()=>[
        ...(sourceOpen?[{workspaceId:'work',paneId:'source',focused:focused==='source',session:source}]:[]),
        {workspaceId:'elsewhere',paneId:'other',focused:focused==='other',session:other},
        {workspaceId:'fresh-work',paneId:'fresh',focused:focused==='fresh',session:fresh}];
      const layout={registerPaneKind:(_owner,kind)=>{Pane=kind.renderer},paneTargets:targets,
        focusPane:(_workspace,id)=>{focused=id;render();return true},openPane:request=>{window.openRequest=request}};
      const ui={canSubmitDuringTurn:()=>false,registerComponent:(_owner,id,component)=>{if(id==='chat.composer')Composer=component},registerSurface:()=>{},registerSettingsPage:()=>{},
        registerStyle:(_owner,_id,css)=>{const el=document.createElement('style');el.textContent=css;document.head.append(el);cleanup.push(()=>el.remove())}};
      const markdownState={revision:0,codeBlocks:[{id:'fixture-code',component:({code})=><figure><figcaption>typescript <button>Copy</button></figcaption><pre><code>{code}</code></pre></figure>}],fileLinks:[]};
      const ctx={clientUi:ui,clientHost:host,clientSession:source,clientWorkspaceLayout:layout,
        clientMarkdown:{subscribe:()=>()=>{},snapshot:()=>markdownState,registerFileLink:(_owner,link)=>{FileLink=link}},
        provide:(_name,value)=>{composer=value},effect:fn=>{const dispose=fn();if(dispose)cleanup.push(dispose)}};
      composerPlugin(ctx);markdownPlugin({...ctx,clientComposer:composer});
      function render(){flushSync(()=>root.render(<>
        <div className="viewer-frame" hidden={!visible}>{mounted&&<Pane workspaceId={window.freshWorkspace?'fresh-work':'work'} pane={{type:'pane',id:'markdown',kind:'markdown-viewer',resource,workspace:'/repo'}} focused visible={visible}/>}</div>
        <div className="chat-fixture">{[source,other,fresh].map((session,index)=><section key={index} id={['source','other','fresh'][index]} data-workspace-pane-id={['source','other','fresh'][index]} className={'workspace-chat-pane '+(focused===['source','other','fresh'][index]?'is-focused':'')}><Composer surface={{id:'default-composer',kind:'composer',capabilities:['images','files']}} session={session} draftStore={drafts[index]}/></section>)}</div>
        <button id="outside">Outside</button>
      </>))}
      window.toggleVisible=value=>{visible=value;render()};window.toggleMounted=value=>{mounted=value;render()};
      window.closeSource=()=>{sourceOpen=false};window.openSource=()=>{sourceOpen=true};
      window.newChatTarget=()=>{window.freshWorkspace=true;resource='/repo/notes.md';render()};
      window.openLinkedFile=()=>FileLink.open({path:'/repo/linked file.md'},document.querySelector('#source'));
      window.selectQuote=(quote,occurrence=0,backward=false)=>{
        const el=document.querySelector('.markdown-viewer-document'),walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),nodes=[];
        while(walker.nextNode())nodes.push(walker.currentNode);
        const text=nodes.map(n=>n.data).join('');let start=-1;for(let i=0;i<=occurrence;i++)start=text.indexOf(quote,start+1);
        if(start<0)throw Error('Missing passage '+quote);
        let offset=0,first,last;
        for(const node of nodes){if(!first&&start<offset+node.length)first=[node,start-offset];if(first&&start+quote.length<=offset+node.length){last=[node,start+quote.length-offset];break}offset+=node.length}
        const selection=getSelection();el.parentElement.focus();
        if(backward)selection.setBaseAndExtent(...last,...first);else selection.setBaseAndExtent(...first,...last);
        document.dispatchEvent(new Event('selectionchange'));
      };
      window.click=label=>{const b=[...document.querySelectorAll('.viewer-frame button')].find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label);if(!b)throw Error('Missing button '+label);flushSync(()=>b.click())};
      window.escape=()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      window.teardown=()=>{flushSync(()=>root.unmount());for(const dispose of cleanup.reverse())dispose()};render();
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all(['src/client/styles.css', 'src/client/pane-toolbar.css', 'program/plugins/ui/default.css', 'program/plugins/theme.css'].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer(async (request, response) => {
    if (request.url?.startsWith('/fonts/')) {
      try { response.end(await fs.readFile(path.join('public/fonts', path.basename(decodeURIComponent(request.url))))); return }
      catch { response.statusCode = 404; response.end(); return }
    }
    response.end('<!doctype html><style>' + css + '\nbody{background:var(--canvas)}#root,.viewer-frame{height:100vh;display:flex;min-width:0}.viewer-frame{flex:1}.viewer-frame[hidden]{display:none}.chat-fixture{position:fixed;left:-2000px;width:600px}#outside{position:fixed;right:0;bottom:0}</style><div id="root"></div>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const win = new BrowserWindow({ show: false, width: 1050, height: 760, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level === 3) console.error(message) })
  const run = code => win.webContents.executeJavaScript(code)
  const frames = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const until = async expression => { for (let i = 0; i < 150; i++) { if (await run(expression)) return; await frames() }; throw Error('Timed out: ' + expression) }
  const click = async label => { await run(`click(${JSON.stringify(label)})`); await frames() }
  const menu = 'document.querySelector(".markdown-selection-menu")'
  const select = async (quote, occurrence = 0, backward = false) => {
    await run(`selectQuote(${JSON.stringify(quote)},${occurrence},${backward})`)
    await until(`!!${menu} && getComputedStyle(${menu}).visibility==='visible'`)
  }
  const screenshot = async name => {
    if (!process.env.ALTO_SELECTION_ARTIFACT_DIR) return
    await fs.mkdir(process.env.ALTO_SELECTION_ARTIFACT_DIR, { recursive: true })
    await fs.writeFile(path.join(process.env.ALTO_SELECTION_ARTIFACT_DIR, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await until('!!document.querySelector(".markdown-viewer-document")')
    await run('openLinkedFile()')
    assert.equal(await run('openRequest.anchorThreadId'), 'source')
    assert.equal(await run('openRequest.resource'), 'markdown:%2Frepo%2Flinked%20file.md?thread=source')

    await select('Keep existing records intact.', 0, true)
    await screenshot('selection-light')
    await run("document.documentElement.dataset.altoTheme='dark'"); await frames(); await screenshot('selection-dark')
    await run("document.documentElement.dataset.altoTheme='light'")
    const before = await run('drafts()')
    await click('Add to chat')
    const after = await run('drafts()')
    assert.equal(after[0].message, 'Existing draft\n\nFrom /repo/notes.md:\n\n> Keep existing records intact.')
    assert.deepEqual(after[0].images, before[0].images)
    assert.deepEqual(after[0].attachments, before[0].attachments)
    assert.deepEqual(after.slice(1), before.slice(1))
    assert.equal(await run('window.sends'), 0)
    assert.equal(await run('document.activeElement.closest("section")?.id'), 'source')
    assert.equal(await run(`!!${menu}`), false)

    await select('Deploy to staging.', 1)
    await click('Edit')
    assert.equal(await run('getSelection().toString()'), 'Deploy to staging.')
    assert.equal(await run('document.activeElement.classList.contains("markdown-viewer-rendered-editor")'), true)
    await run("document.execCommand('insertText',false,'Deploy after the smoke tests pass.')")
    await frames()
    assert.equal(await run(`!!${menu}`), false)
    await run('window.holdSave=true')
    await click('Finish editing Markdown')
    await until('!!window.releaseSave')
    assert.equal(await run('document.querySelector(".markdown-viewer-rendered-editor").isContentEditable'), false, 'The saved snapshot cannot change while the write is pending')
    assert.equal(await run(`document.querySelector('[aria-label="Finish editing Markdown"]').disabled`), true)
    await run('document.querySelector(".markdown-viewer-pane").dispatchEvent(new KeyboardEvent("keydown",{key:"s",metaKey:true,bubbles:true,cancelable:true}))')
    assert.equal(await run('requests.filter(r=>r.method==="markdown-viewer.write").length'), 1, 'Repeated saves must not start another write')
    await run('window.holdSave=false;window.releaseSave()')
    await until(`!!document.querySelector('[aria-label="Edit Markdown file"]')`)
    assert.match(await run('saved'), /Deploy to staging\.\n\nDeploy after the smoke tests pass\./)

    await click('Edit Markdown file')
    await screenshot('editing-light')
    await click('Finish editing Markdown')
    assert.equal(await run('requests.filter(r=>r.method==="markdown-viewer.write").length'), 1, 'Leaving an unchanged document must not rewrite its Markdown')
    await click('Reload Markdown file')
    await until('document.querySelector(".markdown-viewer-document")?.textContent.includes("Deploy after the smoke tests pass.")')

    await select('migration')
    await click('Edit')
    await run("document.execCommand('insertText',false,'release checklist')"); await frames()
    await run('window.failSave=true'); await click('Finish editing Markdown')
    await until('document.querySelector("[role=alert]")?.textContent.includes("changed on disk")')
    assert.ok((await run('document.querySelector(".markdown-viewer-document").textContent')).includes('release checklist'))
    assert.equal(await run('document.querySelector(".markdown-viewer-rendered-editor").isContentEditable'), true, 'A failed save keeps the draft editable')
    assert.equal(await run(`!!document.querySelector('[aria-label="Cancel Markdown edits"]')`), false, 'Exiting edit mode must not silently discard the draft')
    await run('window.failSave=false')
    await click('Finish editing Markdown')
    await until(`!!document.querySelector('[aria-label="Edit Markdown file"]')`)
    assert.ok((await run('saved')).includes('release checklist'), 'Retry saves the retained draft')
    await select('const selected = false;'); await click('Edit')
    assert.equal(await run('getSelection().toString()'), 'const selected = false;', 'Code selection survives replacing the display renderer with editable Markdown')
    await run("document.execCommand('insertText',false,'const selected = true;')"); await frames()
    await run('document.querySelector(".markdown-viewer-pane").dispatchEvent(new KeyboardEvent("keydown",{key:"s",metaKey:true,bubbles:true,cancelable:true}))')
    await until(`!!document.querySelector('[aria-label="Edit Markdown file"]')`)
    assert.ok((await run('saved')).includes('const selected = true;'))
    assert.ok((await run('saved')).includes('const untouched = true;'))

    await select('existing records')
    await run('escape()'); await frames(); assert.equal(await run(`!!${menu}`), false)
    await select('existing records')
    await run("document.querySelector('#outside').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.querySelector('#outside').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))")
    await frames(); assert.equal(await run(`!!${menu}`), false)

    await select('Keep existing records intact.')
    await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))")
    assert.equal(await run('document.activeElement.textContent'), 'Add to chat')
    await run('escape()'); await frames()
    await select('Keep existing records intact.')
    await run("window.retained=document.querySelector('.markdown-viewer-document');toggleVisible(false);toggleVisible(true)")
    await frames()
    assert.equal(await run(`!!${menu}`), false)
    assert.equal(await run('retained===document.querySelector(".markdown-viewer-document")'), true)
    assert.equal(await run("requests.filter(r=>r.method==='markdown-viewer.read').length"), 2)

    await select('Keep existing records intact.')
    await run("document.querySelector('.markdown-viewer-scroll').scrollTop=700")
    await frames()
    assert.equal(await run(`getComputedStyle(${menu}).visibility`), 'hidden')
    await run("document.querySelector('.markdown-viewer-scroll').scrollTop=0")
    await frames()
    assert.equal(await run(`getComputedStyle(${menu}).visibility`), 'visible')
    win.setContentSize(360, 760); await frames()
    await select('Keep existing records intact.')
    const bounds = await run(`(()=>{const menu=${menu}.getBoundingClientRect(),pane=document.querySelector('.markdown-viewer-pane').getBoundingClientRect(),header=document.querySelector('.markdown-viewer-toolbar').getBoundingClientRect();return {fits:menu.left>=pane.left&&menu.right<=pane.right&&menu.top>=header.bottom,height:menu.height,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    assert.equal(bounds.fits, true); assert.equal(bounds.overflow, false); assert.ok(bounds.height <= 36)
    await screenshot('selection-narrow')
    await click('Edit')
    await screenshot('editing-narrow')
    await click('Finish editing Markdown')
    await select('Keep existing records intact.')

    await run('closeSource()'); await click('Add to chat')
    await until('document.querySelector("[role=alert]")?.textContent.includes("Open the source chat")')
    assert.deepEqual(await run('drafts()'), after)
    await run('newChatTarget()')
    await select('Keep existing records intact.'); await click('Add to chat')
    assert.ok((await run('drafts()[2].message')).includes('From /repo/notes.md:'))
    assert.equal(await run('window.sends'), 0, 'A new chat also receives a draft without submission')

    await select('Keep existing records intact.')
    await click('Edit')
    await win.webContents.insertText('Plain ')
    for (const char of '**bold**') await win.webContents.insertText(char)
    await frames()
    const firstParagraph = 'document.querySelector(".markdown-viewer-document p")'
    assert.equal(await run(`${firstParagraph}.querySelector('strong, b')?.textContent`), 'bold', 'Typing paired asterisks formats bold text while editing')
    await run("document.execCommand('undo')")
    assert.ok((await run(`${firstParagraph}.textContent`)).includes('**bold*'), 'Undo restores the text before the formatting keystroke')
    await run("document.execCommand('redo')")
    assert.equal(await run(`${firstParagraph}.querySelector('strong, b')?.textContent`), 'bold')
    await win.webContents.insertText(' plain ')
    for (const char of '*italic*') await win.webContents.insertText(char)
    await win.webContents.insertText(' tail ')
    await win.webContents.insertText(' wrapped ')
    assert.equal(await run(`${firstParagraph}.querySelector('em, i')?.textContent`), 'italic')
    assert.deepEqual(await run(`[...${firstParagraph}.querySelectorAll('strong, b')].map(node=>node.textContent)`), ['bold'], 'Typing after a closing marker does not extend bold formatting')

    await run("selectQuote('wrapped');getSelection().collapseToStart()")
    await win.webContents.insertText('**')
    await run("selectQuote('wrapped');getSelection().collapseToEnd()")
    await win.webContents.insertText('**')
    assert.ok((await run(`[...${firstParagraph}.querySelectorAll('strong, b')].map(node=>node.textContent)`)).includes('wrapped'), 'Existing words can be wrapped in bold markers')
    await win.webContents.insertText(' \\*literal* ')
    assert.ok((await run(`${firstParagraph}.textContent`)).includes('\\*literal*'), 'Escaped asterisks remain literal')
    assert.equal(await run(`${firstParagraph}.querySelector('em, i')?.textContent`), 'italic')

    await win.webContents.insertText('**composed*')
    assert.equal(await run('document.querySelector(".markdown-viewer-rendered-editor").dispatchEvent(new InputEvent("beforeinput",{bubbles:true,cancelable:true,inputType:"insertText",data:"*",isComposing:true}))'), true, 'Composition input is not intercepted')
    assert.ok((await run(`${firstParagraph}.textContent`)).includes('**composed*'))
    await win.webContents.insertText('*')
    assert.ok((await run(`[...${firstParagraph}.querySelectorAll('strong, b')].map(node=>node.textContent)`)).includes('composed'))

    await run("selectQuote('const selected = true;')")
    await win.webContents.insertText('**code stays literal**')
    assert.equal(await run('!!document.querySelector(".markdown-viewer-document pre strong, .markdown-viewer-document pre em")'), false)
    await screenshot('formatting-narrow')
    win.setContentSize(1050, 760); await frames()
    await screenshot('formatting-light')
    await click('Finish editing Markdown')
    assert.ok((await run('saved')).includes('**bold**'))
    assert.ok((await run('saved')).includes('*italic*'))
    assert.ok((await run('saved')).includes('**wrapped**'))
    assert.ok((await run('saved')).includes('**code stays literal**'))
    await click('Reload Markdown file')
    await until(`${firstParagraph}?.querySelector('strong')?.textContent==='bold'`)
    assert.equal(await run(`${firstParagraph}.querySelector('em')?.textContent`), 'italic', 'Formatting survives saving and reloading')

    await run('toggleMounted(false)'); await frames()
    assert.equal(await run(`!!${menu}`), false)
    await run('teardown()')
    console.log('Markdown selection browser checks passed')
  } finally {
    win.destroy(); await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
