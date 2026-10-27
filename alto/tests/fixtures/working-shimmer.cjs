const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'working-shimmer-fixture.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {ActivityTimeline} from './program/plugins/ui/activity';
      const root=createRoot(document.getElementById('root'));
      const originalTimeout=window.setTimeout.bind(window), originalClear=window.clearTimeout.bind(window);
      window.pendingTimeouts=new Set();window.timeoutCalls=0;
      window.setTimeout=(callback,delay,...args)=>{
        const id=originalTimeout(()=>{pendingTimeouts.delete(id);timeoutCalls++;callback(...args)},delay);
        pendingTimeouts.add(id);return id;
      };
      window.clearTimeout=id=>{pendingTimeouts.delete(id);originalClear(id)};
      const prose='Inspecting **wrapped prose** with [Documentation](https://example.com/docs) and inline '+String.fromCharCode(96)+'code'+String.fromCharCode(96)+'. This sentence is long enough to wrap at narrow widths.\\n\\n- A list item with **emphasis** that wraps onto another line in a narrow pane.\\n- Second item';
      window.state={active:true,visible:true,waitingFor:undefined,tool:false,source:prose};
      window.render=patch=>{
        Object.assign(state,patch);
        const items=state.tool
          ? [{id:'tool:1',kind:'tool',title:'Reading files',content:'One',timestamp:'',status:'completed'},
             {id:'tool:2',kind:'tool',title:'Reading files',content:'Two',timestamp:'',status:'running'}]
          : [{id:'reasoning:1',kind:'reasoning',title:'Thinking',content:state.source,timestamp:'',status:'running'}];
        flushSync(()=>root.render(<ActivityTimeline items={items} active={state.active} visible={state.visible} waitingFor={state.waitingFor}/>));
      };
      window.teardown=()=>flushSync(()=>root.unmount());
      render({});
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all([
    'src/client/styles.css', 'program/plugins/ui/default.css',
    'program/plugins/markdown.css', 'program/plugins/theme.css',
  ].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => response.end('<!doctype html><style>' + css + `
    body{margin:0;background:var(--canvas)}#root{width:320px;margin:32px;color:var(--text)}
  </style><main id="root" class="shell-conversation"></main>`))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const win = new BrowserWindow({ show: false, width: 850, height: 650, webPreferences: {
    offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } })
  const run = code => win.webContents.executeJavaScript(code)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const sweeping = 'document.querySelectorAll(".is-shimmer-sweeping").length'
  const until = async expression => {
    for (let i = 0; i < 100; i++) { if (await run(expression)) return; await wait(25) }
    throw new Error('Timed out: ' + expression)
  }
  const screenshot = async name => {
    if (!process.env.ALTO_SHIMMER_ARTIFACT_DIR) return
    await fs.mkdir(process.env.ALTO_SHIMMER_ARTIFACT_DIR, { recursive: true })
    await fs.writeFile(path.join(process.env.ALTO_SHIMMER_ARTIFACT_DIR, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}`)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await run(bundle.outputFiles[0].text)
    assert.equal(await run(sweeping), 0, 'Starts with static text')
    const lineGeometry = "Array.from(document.querySelectorAll('.activity-markdown p,.activity-markdown li')).map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})"
    const activeGeometry = await run(lineGeometry)
    await run('render({visible:false})')
    assert.deepEqual(await run(lineGeometry), activeGeometry, 'Wrapping and list spacing stay unchanged when animation stops')
    await run('render({visible:true})')
    await until(sweeping + '>0')
    await wait(350)
    assert.equal(await run(`(()=>{
      const original=document.querySelector('.activity-text-line > strong'), copy=document.querySelector('.activity-shimmer-highlight strong');
      const a=original.getBoundingClientRect(),b=copy.getBoundingClientRect();
      return Math.abs(a.x-b.x)<.5 && Math.abs(a.y-b.y)<.5 && Math.abs(a.width-b.width)<.5;
    })()`), true, 'The highlight stays aligned while its mask moves')
    await screenshot('wrapped-sweep')
    assert.equal(await run(`(()=>{
      const el=document.querySelector('.activity-text-line'), r=document.createRange();
      r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);
      const text=getSelection().toString();getSelection().removeAllRanges();
      return text.split('Inspecting').length===2 && text.includes('Documentation');
    })()`), true, 'Selection contains the original text only')
    assert.equal(await run(`(()=>{
      const original=document.querySelector('.activity-text-line > a'), copy=document.querySelector('.activity-shimmer-highlight a');
      original.focus();const focused=document.activeElement===original;copy.focus();
      return focused && document.activeElement===original && copy.closest('[inert][aria-hidden="true"]')!==null;
    })()`), true, 'The real link works and its decorative copy cannot receive focus')
    const geometry = await run(`Array.from(document.querySelectorAll('.activity-markdown p,.activity-markdown li')).map(e=>e.getBoundingClientRect().height)`)
    await until(sweeping + '===0')
    await wait(1_200)
    assert.equal(await run(sweeping), 0, 'Rests between sweeps')
    await until(sweeping + '>0')
    await run("render({source:state.source+' More streamed text.'})")
    await until("Array.from(document.querySelectorAll('.activity-shimmer-highlight')).some(e=>e.textContent.includes('More streamed text.'))")
    await run("render({waitingFor:'input'})")
    assert.equal(await run("document.querySelectorAll('.activity-shimmer-sweep').length"), 0, 'Waiting for a reply removes the animation')
    assert.equal(await run('pendingTimeouts.size'), 0, 'Waiting cancels shimmer timers')
    await run("render({waitingFor:undefined,visible:false})")
    assert.equal(await run('pendingTimeouts.size'), 0, 'Inactive panes schedule no sweeps')
    await run("render({visible:true})")
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await until('pendingTimeouts.size===0')
    assert.equal(await run(sweeping), 0, 'Reduced motion stops the current sweep and timer')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await until(sweeping + '>0')
    await run("render({tool:true})")
    assert.equal(await run("document.querySelector('.activity-tool-group-label.activity-working-shimmer')!==null"), true, 'Grouped tools use the same shimmer')
    await run("document.querySelector('.activity-tool-group-summary').click()")
    await until("document.querySelector('.activity-title.activity-working-shimmer')!==null")
    await run("render({active:false})")
    assert.equal(await run('pendingTimeouts.size'), 0, 'Finishing work cancels every sweep')
    await run('render({active:true});teardown()')
    assert.equal(await run('pendingTimeouts.size'), 0, 'Unmount cancels every sweep')
    console.log('Working shimmer browser checks passed', JSON.stringify({ wrappedLineHeights: geometry }))
  } finally { win.destroy(); await new Promise(resolve => server.close(resolve)) }
}
check().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
