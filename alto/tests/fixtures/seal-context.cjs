const { app, BrowserWindow } = require('./background-electron.cjs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')

async function check() {
  await app.whenReady()
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'seal-context-check.tsx', loader: 'tsx', contents: `
      import React,{useSyncExternalStore} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {Context} from 'cordis';
      import {MarkdownRendererRegistry} from './program/plugins/markdown.client';
      import {resolveMarkdownCodeBlock} from './program/plugins/markdown-api';
      import {ActivityCard} from './program/plugins/ui/activity';
      import sealContext from './program/plugins/seal-context.client';
      import codeBlocks from './program/plugins/code-blocks.client';
      import {sealMessageText} from './program/plugins/seal-context';

      const context = [
        'Current Neovim editor context. The buffer content is authoritative.',
        'Project root: /project',
        'File: /project/README.md',
        'Language: markdown',
        'Cursor: line 10, byte column 0',
        'The buffer matches the saved file.',
        'Selected lines: 10-15', '<selection>',
        '  <p>',
        '    <a href="https://github.com/bytecodealliance/cap-std/actions?query=workflow%3ACI"><img src="https://github.com/bytecodealliance/cap-std/workflows/CI/badge.svg" alt="Github Actions CI Status" /></a>',
        '    <a href="https://bytecodealliance.zulipchat.com/#narrow/stream/217126-wasmtime"><img src="https://img.shields.io/badge/zulip-join_chat-brightgreen.svg" alt="zulip chat" /></a>',
        '  </p>', '</div>', '',
        '</selection>', '<buffer lines="1-2000">',
        ...Array.from({length:2000},(_,i)=>'UNSELECTED_BUFFER_LINE_'+i), '</buffer>',
      ].join('\\n');
      const ctx=new Context(),markdown=new MarkdownRendererRegistry();
      ctx.provide('clientMarkdown',markdown);
      ctx.provide('clientUi',{registerStyle:(owner,id,css)=>owner.effect(()=>{
        const style=document.createElement('style');style.textContent=css;document.head.append(style);
        return()=>style.remove();
      })});
      const codeFiber=ctx.plugin(codeBlocks,{});
      const fiber=ctx.plugin(sealContext,{});
      function CodeBlock(props){
        const state=useSyncExternalStore(markdown.subscribe,markdown.snapshot,markdown.snapshot);
        const Renderer=resolveMarkdownCodeBlock(state.codeBlocks,props.language)?.component;
        return Renderer?<Renderer {...props}/>:<pre><code>{props.code}</code></pre>;
      }
      const root=createRoot(document.getElementById('message'));
      const item={id:'seal-test',kind:'user',title:'You',content:sealMessageText('test',context)};
      const render=()=>flushSync(()=>root.render(<ActivityCard item={item} codeBlock={CodeBlock} copyMessage={false}/>));
      Promise.all([codeFiber,fiber]).then(()=>{render();window.ready=true});
      window.renderAgain=render;
      window.observe=()=>{
        const card=document.querySelector('.seal-context'),figure=card.querySelector('figure');
        const pre=figure.querySelector('pre'),composer=document.querySelector('textarea'),header=document.querySelector('body>header');
        return {expandable:!!figure.querySelector('[aria-expanded],details'),height:card.getBoundingClientRect().height,
          overflow:document.documentElement.scrollWidth>innerWidth,
          cardWidth:card.getBoundingClientRect().width,messageWidth:document.getElementById('message').getBoundingClientRect().width,
          text:pre.textContent,meta:figure.querySelector('figcaption').innerText,
          codeClass:figure.className,figures:card.querySelectorAll('figure').length,
          nested:!!card.querySelector('figure figure,pre pre,details'),
          horizontalScroll:pre.scrollWidth>pre.clientWidth,verticalScroll:pre.scrollHeight>pre.clientHeight,
          highlighted:card.querySelectorAll('.token').length,
          copyButton:!!card.querySelector('button[aria-label="Copy code"]'),
          codeWhiteSpace:getComputedStyle(card.querySelector('code')).whiteSpace,
          background:getComputedStyle(card).backgroundColor,border:getComputedStyle(card).borderWidth,
          codeBackground:getComputedStyle(figure).backgroundColor,codeBorder:getComputedStyle(figure).borderWidth,
          codeHeight:card.querySelector('code').getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(card.querySelector('code')).lineHeight),
          composerBottom:composer.getBoundingClientRect().bottom,headerHeight:header.getBoundingClientRect().height};
      };
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  const css = (await Promise.all([
    'src/client/styles.css', 'program/plugins/ui/default.css', 'program/plugins/theme.css',
  ].map(file => fs.readFile(file, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const server = http.createServer((_request, response) => response.end('<!doctype html><meta charset="utf-8"><style>' + css + `
    html,body{margin:0;height:100%;overflow:hidden}body{display:flex;flex-direction:column;padding:16px;background:var(--canvas)}
    body>header{height:40px;flex:none;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}
    main{flex:1;min-height:0;overflow:auto}#message{max-width:720px;margin:0 auto;padding:16px 0}
    textarea{height:80px;width:100%;flex:none;resize:none;margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--panel)}
  </style><header><strong>Alto</strong><button>Chat controls</button></header><main><div id="message"></div></main><textarea placeholder="Follow up…"></textarea>`))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: {
    offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } })
  const run = code => win.webContents.executeJavaScript(code)
  const until = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await run(expression)) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Timed out: ' + expression)
  }
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}`)
    await run(bundle.outputFiles[0].text)
    await until('window.ready')
    for (const theme of ['light', 'dark']) {
    for (const width of [1000, 380]) {
      win.setContentSize(width, 760)
      await until(`innerWidth === ${width}`)
      await run(`document.documentElement.dataset.altoTheme='${theme}'`)
      await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const state = await run('observe()')
      assert.equal(state.expandable, false, 'There is no full-context expansion control')
      assert.doesNotMatch(state.text, /UNSELECTED_BUFFER/, 'The full buffer stays out of the chat display')
      assert.equal(state.overflow, false, 'Long paths and source do not widen the chat')
      assert.ok(state.cardWidth <= state.messageWidth)
      assert.ok(state.height < 180, 'Long selections stay compact even in a narrow chat')
      assert.ok(state.codeHeight <= state.lineHeight * 6 + 1, 'The preview is at most six visible lines')
      assert.ok(state.composerBottom <= 760, 'The composer remains on screen')
      assert.equal(state.headerHeight, 40)
      assert.match(state.text, /bytecodealliance\/cap-std\/actions/)
      assert.equal(state.meta, 'Seal · README.md:10-15')
      assert.equal(state.codeClass, 'cordis-code-block')
      assert.equal(state.figures, 1)
      assert.equal(state.nested, false)
      assert.equal(state.horizontalScroll, false, 'Long badge links wrap without a horizontal scrollbar')
      assert.equal(state.verticalScroll, false, 'The selection has no inner vertical scrollbar')
      assert.ok(state.highlighted > 0, 'Selections use normal syntax highlighting')
      assert.equal(state.copyButton, true)
      assert.equal(state.codeWhiteSpace, 'pre-wrap')
      assert.equal(state.background, 'rgba(0, 0, 0, 0)', 'No separate Seal card background')
      assert.equal(state.border, '0px')
      assert.equal(state.codeBackground, 'rgba(0, 0, 0, 0)', 'The user bubble supplies the only background')
      assert.equal(state.codeBorder, '0px', 'No nested border inside the user bubble')
      if (process.env.ALTO_SEAL_SCREENSHOTS) {
        await fs.mkdir(process.env.ALTO_SEAL_SCREENSHOTS, { recursive: true })
        await fs.writeFile(process.env.ALTO_SEAL_SCREENSHOTS + '/seal-context-' + theme + '-' + width + '.png', (await win.webContents.capturePage()).toPNG())
      }
    }
    }
    console.log('Seal context browser checks passed')
  } finally {
    win.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
check().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
