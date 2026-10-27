const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
app.on('window-all-closed',()=>{})
async function check(){
  await app.whenReady()
  const source='flowchart LR\n'+Array.from({length:12},(_,i)=>`N${i}["Stage ${i+1}"] --> N${i+1}["Stage ${i+2}"]`).join('\n')
  const bundle=await build({stdin:{resolveDir:process.cwd(),sourcefile:'mermaid-expand.tsx',loader:'tsx',contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import mermaid from './program/plugins/mermaid.client';import {OverlayStore} from './src/client/plugin-runtime';
    const overlays=new OverlayStore();window.overlays=overlays;let Diagram;
    mermaid({clientMarkdown:{registerCodeBlock:(_owner,renderer)=>Diagram=renderer.component},clientUi:{overlays,registerStyle:(_owner,_id,css)=>{const s=document.createElement('style');s.textContent=css;document.head.append(s)}}},{});
    const root=createRoot(document.getElementById('root'));
    window.render=code=>flushSync(()=>root.render(<div className="activity-markdown"><Diagram code={code} language="mermaid"/></div>));
    window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    window.open=()=>{const b=document.querySelector('[aria-label="Expand diagram"]');b.focus();b.click()};
    window.close=()=>document.querySelector('[aria-label="Close expanded diagram"]').click();
    window.teardown=()=>flushSync(()=>root.unmount());render(${JSON.stringify(source)});
  `},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',loader:{'.css':'text'},define:{'process.env.NODE_ENV':'"production"'}})
  const css=(await Promise.all(['src/client/styles.css','program/plugins/theme.css','program/plugins/ui/default.css'].map(f=>fs.readFile(f,'utf8')))).join('\n').replace(/@import[^;]+;/g,'')
  const win=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}})
  const run=code=>win.webContents.executeJavaScript(code)
  const frames=()=>run('frame()')
  const until=async expression=>{for(let i=0;i<140;i++){if(await run(expression))return;await frames()}throw new Error('Timed out: '+expression)}
  try{
    await win.loadURL('data:text/html,'+encodeURIComponent('<!doctype html><style>'+css+'body{margin:0;background:var(--canvas)}.shell-kernel{height:100vh}#root{max-height:60vh;max-width:700px;overflow:auto;transform:translateZ(0);margin:40px auto}</style><div class="shell-kernel"><div id="root"></div></div>'))
    await run(bundle.outputFiles[0].text)
    await until('!!document.querySelector(".cordis-mermaid-svg svg") && !document.querySelector("[aria-label=\\"Expand diagram\\"]").disabled')
    const height=await run('document.querySelector("figure").getBoundingClientRect().height')
    await run('open()');await frames()
    assert.ok(await run('!!document.querySelector("[role=dialog]")'))
    assert.equal(await run('document.querySelectorAll("svg[id^=alto-mermaid]").length'),1,'Expansion must not duplicate SVG IDs')
    assert.equal(await run('document.activeElement.getAttribute("aria-label")'),'Close expanded diagram')
    assert.ok(await run('overlays.nativeViewsOccluded()'),'The viewer participates in native surface coordination')
    assert.equal(await run('document.querySelector("figure").getBoundingClientRect().height'),height,'Expanding preserves conversation geometry')
    for(const width of [1100,360]){
      win.setContentSize(width,760);await frames()
      const metrics=await run(`(()=>{const d=document.querySelector('[role=dialog]'),r=d.getBoundingClientRect(),c=d.querySelector('[aria-label="Close expanded diagram"]').getBoundingClientRect(),v=d.querySelector('.cordis-mermaid-expanded-viewport'),s=d.querySelector('svg').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,area:r.width*r.height/(innerWidth*innerHeight),closeRight:c.right,scroll:document.documentElement.scrollWidth,svgWidth:s.width,availableWidth:v.clientWidth,svgHeight:s.height,availableHeight:v.clientHeight}})()`)
      assert.ok(metrics.left>=0&&metrics.right<=width&&metrics.top>=0&&metrics.bottom<=metrics.height,JSON.stringify(metrics))
      assert.ok(metrics.closeRight<=width&&metrics.scroll<=width,JSON.stringify(metrics))
      if(width===1100)assert.ok(metrics.area>0.4&&metrics.area<0.55,"Expanded diagram uses roughly half the window: "+JSON.stringify(metrics))
      assert.ok(metrics.svgWidth<=metrics.availableWidth+1&&metrics.svgHeight<=metrics.availableHeight+1,'Fit keeps the entire diagram visible')
      const fit=await run('document.querySelector("output").textContent')
      await run('for(let i=0;i<4;i++)document.querySelector("[aria-label=\\"Zoom in\\"]").click()');await frames()
      assert.notEqual(await run('document.querySelector("output").textContent'),fit)
      assert.ok(await run('(()=>{const e=document.querySelector(".cordis-mermaid-expanded-viewport");return e.scrollWidth>e.clientWidth})()'),'Zoomed diagram can be panned')
      await run('document.querySelector("[aria-label=\\"Fit diagram to window\\"]").click()');await frames()
      if(process.env.ALTO_MERMAID_ARTIFACT_DIR){await fs.mkdir(process.env.ALTO_MERMAID_ARTIFACT_DIR,{recursive:true});await fs.writeFile(path.join(process.env.ALTO_MERMAID_ARTIFACT_DIR,'mermaid-expanded-'+width+'.png'),(await win.webContents.capturePage()).toPNG())}
    }
    await run('document.querySelector(".cordis-mermaid-expanded-viewport").focus();document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}))')
    assert.equal(await run('document.activeElement===document.querySelector("[role=dialog] button:not(:disabled)")'),true,'Keyboard navigation stays inside the viewer')
    await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await frames()
    assert.equal(await run('!!document.querySelector("[role=dialog]")'),false)
    assert.equal(await run('document.activeElement.getAttribute("aria-label")'),'Expand diagram')
    assert.equal(await run('overlays.snapshot()'),undefined)
    assert.equal(await run('document.querySelectorAll(".cordis-mermaid-svg svg").length'),1)
    await run('open()');await frames();await run('close()');await frames()
    assert.equal(await run('!!document.querySelector("[role=dialog]")'),false)
    await run('open()');await frames();await run('overlays.open("another-dialog")');await frames()
    assert.equal(await run('!!document.querySelector("[role=dialog]")'),false)
    assert.equal(await run('overlays.snapshot()'),'another-dialog')
    await run('overlays.closeAll();render("flowchart TD\\n A --> B")')
    await until('!!document.querySelector(".cordis-mermaid.is-ready .cordis-mermaid-svg svg")')
    await run('open()');await frames()
    assert.ok(await run('parseInt(document.querySelector("output").textContent,10)>100'),'Expansion enlarges vector diagrams to use the available space')
    await run("document.documentElement.dataset.altoTheme='dark'");await frames()
    assert.equal(await run('getComputedStyle(document.querySelector(".cordis-mermaid-expanded-viewport")).colorScheme'),'light','The diagram keeps its readable Mermaid palette in dark mode')
    await run('teardown()');await frames()
    assert.equal(await run('!!document.querySelector("[role=dialog]")'),false)
    assert.equal(await run('overlays.snapshot()'),undefined)
    console.log('Mermaid expansion browser checks passed at 1100 and 360 pixels')
  }finally{win.destroy()}
}
check().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)})
