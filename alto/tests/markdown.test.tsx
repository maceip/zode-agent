import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import remarkMath from 'remark-math'
import {
  ActivityCard,
  ActivityTimeline,
  DiffView,
  StreamingMarkdownBuffer,
  activityFrom,
  activityTurns,
  completeLatestTurn,
  fileChanges,
  formatDuration,
  groupToolActivities,
  mergeActivity,
  nextStreamRevealEnd,
  stableStreamingMarkdownPrefix,
  summarizeFileChanges,
} from '../program/plugins/ui/activity.js'
import type {
  MarkdownFileLinkHandler,
  MarkdownMathRenderer,
} from '../program/plugins/markdown-api.js'
import {
  MarkdownMathProvider,
  MessageMarkdown,
  smartLinkDetails,
} from '../program/plugins/ui/markdown.js'
import { activitiesFromThread } from '../program/plugins/ui/history.js'

describe('message markdown', () => {
  it('renders inline formatting and fenced code', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown source={'Use **care** and `const`, then:\n\n```ts\nconst x = 1\n```'} />,
    )

    expect(html).toContain('<strong>care</strong>')
    expect(html).toContain('<code>const</code>')
    expect(html).toContain('<pre><code class="language-ts">const x = 1')
  })

  it('wraps prose as inline line fragments for the working shimmer', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown source={'A paragraph that can wrap.\n\n- First item\n- Second item'} />,
    )

    expect(html).toContain('<p><span class="activity-text-line">A paragraph that can wrap.</span></p>')
    expect(html).toContain('<li><span class="activity-text-line">First item</span></li>')
    expect(html).toContain('<li><span class="activity-text-line">Second item</span></li>')
  })

  it('renders Markdown tables with accessible column resize handles', () => {
    const html = renderToStaticMarkup(<MessageMarkdown source={[
      '| Issue | Status | Reality |',
      '| --- | --- | --- |',
      '| S-002 | Merged | Strict enforcement remains paused. |',
    ].join('\n')} />)

    expect(html).toContain('class="markdown-table-shell"')
    expect(html).toContain('class="markdown-table-heading">Status</span>')
    expect(html.match(/aria-label="Resize table column"/g)).toHaveLength(3)
  })

  it('delegates fenced code blocks to a replaceable renderer', () => {
    const CodeBlock = ({ code, language }: { code: string; language?: string }) => (
      <section data-test-code-block={language}>{code}</section>
    )
    const html = renderToStaticMarkup(
      <MessageMarkdown source={'Before\n\n```rust\nlet value = 1;\n```'} codeBlock={CodeBlock} />,
    )

    expect(html).toContain('data-test-code-block="rust"')
    expect(html).toContain('let value = 1;')
    expect(html).not.toContain('<pre>')
  })

  it('renders inline and display equations through a replaceable math renderer', () => {
    const Math = ({ formula, display }: { formula: string; display: boolean }) => (
      <span className={display ? 'test-math-display' : 'test-math-inline'}>{formula}</span>
    )
    const renderer: MarkdownMathRenderer = {
      id: 'test-math',
      component: Math,
      remarkPlugins: [[remarkMath, { singleDollarTextMath: true }]],
    }
    const html = renderToStaticMarkup(
      <MarkdownMathProvider renderer={renderer}>
        <MessageMarkdown source={'Inline $R(x)$ and centered:\n\n$$\nR(x) \\cap R(y)\n$$'} />
      </MarkdownMathProvider>,
    )

    expect(html).toContain('<span class="test-math-inline">R(x)</span>')
    expect(html).toContain('<span class="test-math-display">R(x) \\cap R(y)</span>')
    expect(html).not.toContain('language-math')
    expect(html).not.toContain('<pre>')
  })

  it('leaves dollar notation untouched when the math fiber is absent', () => {
    const html = renderToStaticMarkup(<MessageMarkdown source="A price of $5 and $R(x)$" />)

    expect(html).toContain('A price of $5 and $R(x)$')
  })

  it('does not execute raw HTML', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown source={'before <script>alert(1)</script> after'} />,
    )

    expect(html).not.toContain('<script>')
  })

  it('compacts GitHub and Linear URLs into recognizable smart links', () => {
    expect(smartLinkDetails('https://github.com/example/project/pull/627')).toEqual({
      kind: 'github',
      label: '#627',
    })
    expect(smartLinkDetails('https://linear.app/acme/issue/ENG-577/track-the-change')).toEqual({
      kind: 'linear',
      label: 'ENG-577',
    })

    const html = renderToStaticMarkup(<MessageMarkdown source={[
      'https://github.com/example/project/pull/627',
      'https://linear.app/acme/issue/ENG-577/track-the-change',
    ].join(' and ')} />)

    expect(html).toContain('smart-link-github')
    expect(html).toContain('smart-link-linear')
    expect(html).toContain('<span>#627</span>')
    expect(html).toContain('<span>ENG-577</span>')
    expect(html).toContain('<svg')
  })

  it('exposes site destinations for hover and keyboard previews', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown source="[Documentation](https://example.com/docs?q=alto) and [email](mailto:hello@example.com)" />,
    )

    expect(html).toContain('data-link-preview="https://example.com/docs?q=alto"')
    expect(html).not.toContain('data-link-preview="mailto:hello@example.com"')
  })

  it('keeps an explicit smart-link label', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown source="[stacked PR](https://github.com/example/project/pull/627)" />,
    )

    expect(html).toContain('smart-link-github')
    expect(html).toContain('data-link-preview="https://github.com/example/project/pull/627"')
    expect(html).toContain('<span>stacked PR</span>')
    expect(html).not.toContain('<span>#627</span>')
  })

  it('marks code-labeled repository links for compact file styling', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown source={'[`protocol.rs:798`](https://github.com/example/project/blob/main/src/protocol.rs#L798)'} />,
    )

    expect(html).toContain('smart-link-github smart-link-code')
    expect(html).toContain('<code>protocol.rs:798</code>')
    expect(html).toContain('class="smart-link-icon"')
  })

  it('renders Codex file citations and git directives instead of leaking their syntax', () => {
    const html = renderToStaticMarkup(<MessageMarkdown source={[
      'Created :codex-file-citation{path="/tmp/output/report.pdf" purpose="output"}.',
      '',
      '::git-stage{cwd="/tmp/project"}',
      '::git-commit{cwd="/tmp/project"}',
      '::git-push{cwd="/tmp/project" branch="dev/polish-replies"}',
      '::git-create-pr{cwd="/tmp/project" branch="dev/polish-replies" url="https://github.com/example/project/pull/629" isDraft=true}',
    ].join('\n')} />)

    expect(html).toContain('class="file-citation"')
    expect(html).toContain('href="file:///tmp/output/report.pdf"')
    expect(html).toContain('<span>report.pdf</span>')
    expect(html).toContain('Staged changes')
    expect(html).toContain('Committed')
    expect(html).toContain('Pushed dev/polish-replies')
    expect(html).toContain('Opened draft #629')
    expect(html).toContain('href="https://github.com/example/project/pull/629"')
    expect(html).not.toContain(':codex-file-citation')
    expect(html).not.toContain('::git-')
  })

  it('recognizes absolute local file links as file citations', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown source="[Download report.md](/Users/test/project/report.md)" />,
    )

    expect(html).toContain('class="file-citation"')
    expect(html).toContain('href="file:///Users/test/project/report.md"')
    expect(html).toContain('<span>report.md</span>')
  })

  it('keeps source locations in the label but opens the underlying file', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown source="[session.client.ts:256](/Users/test/project/session.client.ts:256)" />,
    )

    expect(html).toContain('href="file:///Users/test/project/session.client.ts"')
    expect(html).toContain('title="/Users/test/project/session.client.ts"')
    expect(html).toContain('<span>session.client.ts:256</span>')
  })

  it('uses directive line metadata without adding it to the open path', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown source={':codex-file-citation{path="/Users/test/project/activity.tsx" line=438}'} />,
    )

    expect(html).toContain('href="file:///Users/test/project/activity.tsx"')
    expect(html).toContain('<span>activity.tsx:438</span>')
  })

  it('keeps file citation locations as structured link details', () => {
    expect(smartLinkDetails('codex-file-citation://open?path=%2Ftmp%2Fview.tsx&startLine=12&endLine=15&startColumn=4')).toMatchObject({
      kind: 'file',
      path: '/tmp/view.tsx',
      line: 12,
      endLine: 15,
      column: 4,
    })
    expect(smartLinkDetails('file:///tmp/view.tsx#L42C7')).toMatchObject({
      kind: 'file',
      path: '/tmp/view.tsx',
      line: 42,
      column: 7,
    })
  })

  it('does not crash on a malformed percent-encoded link', () => {
    expect(() => renderToStaticMarkup(
      <MessageMarkdown source="[%](/%E0%A4%A)" />,
    )).not.toThrow()
    expect(smartLinkDetails('/%E0%A4%A')).toBeUndefined()
  })

  it('identifies the plugin that owns an interactive file citation', () => {
    const handler: MarkdownFileLinkHandler = {
      id: 'markdown-viewer',
      extensions: ['.md'],
      open: () => undefined,
    }
    const html = renderToStaticMarkup(
      <MarkdownMathProvider renderer={undefined} fileLinks={[handler]}>
        <MessageMarkdown source="[Research prompt](/Users/test/project/prompt.md)" />
      </MarkdownMathProvider>,
    )

    expect(html).toContain('data-file-link-handler="markdown-viewer"')
  })

  it('leaves directive-looking text alone inside code blocks', () => {
    const html = renderToStaticMarkup(<MessageMarkdown source={[
      '```text',
      ':codex-file-citation{path="/tmp/example.txt" purpose="source"}',
      '::git-commit{cwd="/tmp/project"}',
      '```',
    ].join('\n')} />)

    expect(html).toContain(':codex-file-citation')
    expect(html).toContain('::git-commit')
    expect(html).not.toContain('class="file-citation"')
    expect(html).not.toContain('class="git-action')
  })

  it('renders conversational messages without role hints', () => {
    const user = renderToStaticMarkup(<ActivityCard item={{
      id: 'user-1',
      kind: 'user',
      title: 'You',
      content: 'Hello',
      timestamp: '',
    }} />)
    const agent = renderToStaticMarkup(<ActivityCard item={{
      id: 'agent-1',
      kind: 'agent',
      title: 'Codex',
      content: 'Hi',
      status: 'streaming',
      timestamp: '',
    }} />)

    expect(user).not.toContain('You')
    expect(agent).not.toContain('Codex')
    expect(user).toContain('Hello')
    expect(agent).toContain('Hi')
    expect(agent).toContain('activity-streaming')
  })

  it('marks only thinking and tool activity for the working shimmer', () => {
    const commentary = renderToStaticMarkup(<ActivityCard item={{
      id: 'agent-commentary',
      kind: 'agent',
      phase: 'commentary',
      title: 'Codex',
      content: 'I am checking the implementation.',
      status: 'streaming',
      timestamp: '',
    }} />)
    const reasoning = renderToStaticMarkup(<ActivityCard item={{
      id: 'reasoning',
      kind: 'reasoning',
      title: 'Thinking',
      content: 'Comparing implementations.',
      status: 'running',
      timestamp: '',
    }} />)
    const tool = renderToStaticMarkup(<ActivityCard item={{
      id: 'tool',
      kind: 'tool',
      title: 'Used the browser',
      content: '',
      status: 'running',
      timestamp: '',
    }} />)

    expect(commentary).not.toContain('activity-working-trace')
    expect(reasoning).toContain('activity-working-trace')
    expect(tool).toContain('activity-working-trace')
  })

  it('animates only the newest active trace invocation', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[{
      id: 'user-1',
      kind: 'user',
      title: 'You',
      content: 'Inspect it.',
      timestamp: '',
    }, {
      id: 'reasoning-completed',
      kind: 'reasoning',
      title: 'Thinking',
      content: 'Finished reasoning.',
      status: 'completed',
      timestamp: '',
    }, {
      id: 'reasoning-stale-running',
      kind: 'reasoning',
      title: 'Thinking',
      content: 'An older invocation.',
      status: 'running',
      timestamp: '',
    }, {
      id: 'reasoning-current',
      kind: 'reasoning',
      title: 'Thinking',
      content: 'The current invocation.',
      status: 'streaming',
      timestamp: '',
    }]} />)

    const article = (id: string): string => html.match(
      new RegExp(`<article[^>]+data-activity-id="${id}"`),
    )?.[0] ?? ''

    expect(article('reasoning-completed')).toContain('activity-working-trace')
    expect(article('reasoning-completed')).not.toContain('activity-active-trace')
    expect(article('reasoning-stale-running')).not.toContain('activity-active-trace')
    expect(article('reasoning-current')).toContain('activity-active-trace')
    expect(html.match(/activity-active-trace/g)).toHaveLength(1)
  })

  it('keeps one stable tool group and animates its full label while work is live', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[{
      id: 'user-1',
      kind: 'user',
      title: 'You',
      content: 'Inspect it.',
      timestamp: '',
    }, {
      id: 'tool-completed',
      kind: 'tool',
      title: 'Read files',
      content: 'done',
      status: 'completed',
      timestamp: '',
    }, {
      id: 'command-current',
      kind: 'command',
      title: 'Ran a command',
      content: 'running',
      status: 'running',
      timestamp: '',
    }]} />)

    const summaries = [...html.matchAll(
      /<button class="activity-tool-group-summary ([^"]*)"[^>]*>(.*?)<\/button>/g,
    )]
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.[1]).not.toContain('activity-active-trace')
    expect(summaries[0]?.[2]).toContain(
      '<span class="activity-tool-group-label activity-active-trace activity-working-shimmer">Read files, ran a command<span',
    )
    expect((summaries[0]?.[2] ?? '').match(/activity-active-trace/g)).toHaveLength(1)
  })

  it('keeps the latest trace active between tool events', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[{
      id: 'user-1',
      kind: 'user',
      title: 'You',
      content: 'Inspect it.',
      timestamp: '',
    }, {
      id: 'tool-completed',
      kind: 'tool',
      title: 'Used the browser',
      content: 'done',
      status: 'completed',
      timestamp: '',
    }]} />)

    expect(html).toContain('activity-turn-live-trace')
    expect(html).toContain(
      '<span class="activity-tool-group-label activity-active-trace activity-working-shimmer">Used the browser<span',
    )
  })

  it('offers timestamps and copy actions for prompts and completed replies', () => {
    const prompt = renderToStaticMarkup(<ActivityCard item={{
      id: 'user-complete',
      kind: 'user',
      title: 'You',
      content: 'A user prompt.',
      timestamp: '7:41 PM',
    }} />)
    const complete = renderToStaticMarkup(<ActivityCard item={{
      id: 'agent-complete',
      kind: 'agent',
      title: 'Codex',
      content: 'A complete reply.',
      status: 'completed',
      timestamp: '7:42 PM',
    }} />)
    const streaming = renderToStaticMarkup(<ActivityCard item={{
      id: 'agent-streaming',
      kind: 'agent',
      title: 'Codex',
      content: 'A partial reply.',
      status: 'streaming',
      timestamp: '',
    }} />)

    expect(prompt).toContain('aria-label="Copy prompt"')
    expect(prompt).toContain('activity-message-copy')
    expect(prompt).toContain('activity-message-timestamp')
    expect(prompt).toContain('7:41 PM')
    expect(complete).toContain('aria-label="Copy reply"')
    expect(complete).toContain('activity-message-copy')
    expect(complete).toContain('activity-message-timestamp')
    expect(complete).toContain('7:42 PM')
    expect(streaming).not.toContain('aria-label="Copy reply"')
  })

  it('summarizes structured file changes', () => {
    expect(fileChanges({
      changes: [{
        path: '/tmp/example.ts',
        kind: 'update',
        diff: '@@ -1 +1,2 @@\n-old\n+new\n+more',
      }],
    })).toEqual([{
      path: '/tmp/example.ts',
      kind: 'update',
      diff: '@@ -1 +1,2 @@\n-old\n+new\n+more',
      additions: 2,
      deletions: 1,
    }])
  })

  it('decodes App Server structured file-change kinds', () => {
    expect(fileChanges({
      changes: [{
        path: '/tmp/new.ts',
        kind: { type: 'add' },
        diff: 'export {}',
      }],
    })[0]).toMatchObject({ kind: 'add', additions: 1, deletions: 0 })
  })

  it('collapses repeated patches into one displayed file summary', () => {
    const changes = [{
      path: '/tmp/example.ts',
      kind: 'update',
      diff: '-one\n+two',
      additions: 1,
      deletions: 1,
    }, {
      path: '/tmp/example.ts',
      kind: 'update',
      diff: '-three\n+four\n+five',
      additions: 2,
      deletions: 1,
    }, {
      path: '/tmp/other.ts',
      kind: 'create',
      diff: '+new',
      additions: 1,
      deletions: 0,
    }]

    expect(summarizeFileChanges(changes)).toEqual([{
      path: '/tmp/example.ts',
      additions: 3,
      deletions: 2,
      changes: changes.slice(0, 2),
    }, {
      path: '/tmp/other.ts',
      additions: 1,
      deletions: 0,
      changes: changes.slice(2),
    }])
  })

  it('does not render the legacy inline summary for repeated patches', () => {
    const html = renderToStaticMarkup(<ActivityCard item={{
      id: 'file-repeated',
      kind: 'file',
      title: 'Files',
      content: '',
      timestamp: '',
      files: [{
        path: '/tmp/example.ts',
        kind: 'update',
        diff: '-one\n+two',
        additions: 1,
        deletions: 1,
      }, {
        path: '/tmp/example.ts',
        kind: 'update',
        diff: '-three\n+four\n+five',
        additions: 2,
        deletions: 1,
      }],
    }} />)

    expect(html).toBe('')
  })

  it('updates the file card as App Server streams a patch', () => {
    expect(activityFrom({
      method: 'item/fileChange/patchUpdated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'patch-1',
        changes: [{
          path: '/tmp/example.ts',
          kind: 'update',
          diff: '-old\n+new',
        }],
      },
    })).toMatchObject({
      id: 'file:thread-1:turn-1:patch-1',
      kind: 'file',
      status: 'running',
      files: [{ path: '/tmp/example.ts', additions: 1, deletions: 1 }],
    })
  })

  it('captures App Server reasoning summaries without exposing raw reasoning', () => {
    expect(activityFrom({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        summaryIndex: 0,
        delta: 'Checking the layout.',
      },
    })).toMatchObject({
      id: 'reasoning:thread-1:turn-1:reasoning-1',
      kind: 'reasoning',
      title: 'Thinking',
      content: 'Checking the layout.',
      status: 'streaming',
    })

    expect(activityFrom({
      method: 'item/reasoning/textDelta',
      params: { itemId: 'reasoning-1', delta: 'private reasoning' },
    })).toBeUndefined()
  })

  it('appends agent deltas after the started item snapshot', () => {
    const started = activityFrom({
      method: 'item/started',
      params: {
        item: {
          id: 'agent-1',
          type: 'agentMessage',
          text: '',
        },
      },
    })
    const firstDelta = activityFrom({
      method: 'item/agentMessage/delta',
      params: {
        itemId: 'agent-1',
        delta: 'No—DSH does not always delegate.',
      },
    })
    const secondDelta = activityFrom({
      method: 'item/agentMessage/delta',
      params: {
        itemId: 'agent-1',
        delta: '\n\nIts normal architecture is:',
      },
    })

    expect(started).toBeDefined()
    expect(firstDelta).toBeDefined()
    expect(secondDelta).toBeDefined()
    const activities = mergeActivity(
      mergeActivity(mergeActivity([], started!), firstDelta!),
      secondDelta!,
    )

    expect(activities[0]?.content).toBe(
      'No—DSH does not always delegate.\n\nIts normal architecture is:',
    )
  })

  it('appends identical consecutive deltas instead of guessing they are duplicates', () => {
    const delta = (content: string) => ({
      id: 'agent:agent-1',
      kind: 'agent' as const,
      title: 'Codex',
      content,
      contentUpdate: 'append' as const,
      status: 'streaming',
      timestamp: '',
    })

    const activities = mergeActivity(mergeActivity([], delta('ha')), delta('ha'))
    expect(activities[0]?.content).toBe('haha')
  })

  it('does not replace rendered output with a shorter interrupted snapshot', () => {
    const streamed = {
      id: 'agent:agent-1',
      kind: 'agent' as const,
      title: 'Codex',
      content: 'This text was already rendered before interruption.',
      status: 'streaming',
      timestamp: '',
    }
    const interrupted = {
      ...streamed,
      content: 'This text was already rendered',
      status: 'interrupted',
    }

    expect(mergeActivity([streamed], interrupted)[0]?.content).toBe(streamed.content)
  })

  it('reveals streaming prose gradually and accelerates through a backlog', () => {
    const short = 'A short response.'
    const long = 'x'.repeat(500)
    const shortEnd = nextStreamRevealEnd(short, 0, 24)
    const longEnd = nextStreamRevealEnd(long, 0, 24)

    expect(shortEnd).toBeGreaterThan(0)
    expect(shortEnd).toBeLessThan(short.length)
    expect(longEnd).toBeGreaterThan(shortEnd)
    expect(longEnd).toBeLessThan(long.length)
    expect(nextStreamRevealEnd(short, short.length, 24)).toBe(short.length)
  })

  it('never reveals half of a UTF-16 surrogate pair', () => {
    const text = `${'x'.repeat(11)}🚀 done`
    expect(nextStreamRevealEnd(text, 11, 8)).toBe(13)
  })

  it('parses completed streaming Markdown blocks only once', () => {
    const buffer = new StreamingMarkdownBuffer()

    expect(buffer.update('First paragraph')).toEqual({
      blocks: [],
      tail: 'First paragraph',
    })
    const settled = buffer.update('First paragraph\n\nSecond')
    expect(settled.blocks).toEqual(['First paragraph\n\n'])
    expect(settled.tail).toBe('Second')
    expect(buffer.update('First paragraph\n\nSecond paragraph').blocks).toBe(settled.blocks)
  })

  it('keeps incomplete fenced code in the mutable streaming tail', () => {
    const buffer = new StreamingMarkdownBuffer()
    const open = buffer.update('Before\n\n```ts\nconst value = 1\n')

    expect(open.blocks).toEqual(['Before\n\n'])
    expect(open.tail).toBe('```ts\nconst value = 1\n')
    expect(buffer.update('Before\n\n```ts\nconst value = 1\n```\nAfter')).toEqual({
      blocks: ['Before\n\n', '```ts\nconst value = 1\n```\n'],
      tail: 'After',
    })
  })

  it('resets the streaming Markdown buffer when content is replaced', () => {
    const buffer = new StreamingMarkdownBuffer()
    buffer.update('Old paragraph\n\nTail')

    expect(buffer.update('Replacement')).toEqual({
      blocks: [],
      tail: 'Replacement',
    })
  })

  it('withholds incomplete file citations until they can render atomically', () => {
    const prose = 'Created '
    const directive = ':codex-file-citation{path="/tmp/theme.css" purpose="output"}'

    for (let end = 1; end < directive.length; end += 1) {
      expect(stableStreamingMarkdownPrefix(`${prose}${directive.slice(0, end)}`)).toBe(prose)
    }
    expect(stableStreamingMarkdownPrefix(`${prose}${directive}`)).toBe(`${prose}${directive}`)
  })

  it('withholds incomplete Markdown links and inline code', () => {
    const prose = 'Read '
    const link = '[theme.css](/tmp/theme.css)'

    for (let end = 1; end < link.length; end += 1) {
      expect(stableStreamingMarkdownPrefix(`${prose}${link.slice(0, end)}`)).toBe(prose)
    }
    expect(stableStreamingMarkdownPrefix(`${prose}${link}`)).toBe(`${prose}${link}`)
    expect(stableStreamingMarkdownPrefix('Use `theme.css')).toBe('Use ')
    expect(stableStreamingMarkdownPrefix('Use `theme.css`')).toBe('Use `theme.css`')
  })

  it('withholds incomplete git actions and allows quoted closing braces', () => {
    expect(stableStreamingMarkdownPrefix('Done ::git-push{cwd="/tmp/project"')).toBe('Done ')
    expect(stableStreamingMarkdownPrefix(
      'Done ::git-push{cwd="/tmp/}project" branch="main"}',
    )).toBe('Done ::git-push{cwd="/tmp/}project" branch="main"}')
  })

  it('does not stabilize directive-looking text inside fenced or inline code', () => {
    const fenced = '```text\n:codex-file-citation{path="/tmp/theme.css"'
    const inline = 'Use `:codex-file-citation{path="/tmp/theme.css"`'

    expect(stableStreamingMarkdownPrefix(fenced)).toBe(fenced)
    expect(stableStreamingMarkdownPrefix(inline)).toBe(inline)
  })

  it('keeps unstable syntax out of the mutable block and flushes it at completion', () => {
    const buffer = new StreamingMarkdownBuffer()
    const partial = 'Read [theme.css](/tmp/theme'

    expect(buffer.update(partial, true)).toEqual({ blocks: [], tail: 'Read ' })
    expect(buffer.update(partial, false)).toEqual({ blocks: [], tail: partial })
  })

  it('never places incomplete link syntax in the streaming activity DOM', () => {
    const partial = renderToStaticMarkup(<ActivityCard item={{
      id: 'agent-link-partial',
      kind: 'agent',
      title: 'Codex',
      content: 'Read [theme.css](/tmp/theme',
      status: 'streaming',
      timestamp: '',
    }} />)
    const complete = renderToStaticMarkup(<ActivityCard item={{
      id: 'agent-link-complete',
      kind: 'agent',
      title: 'Codex',
      content: 'Read [theme.css](/tmp/theme.css)',
      status: 'streaming',
      timestamp: '',
    }} />)

    expect(partial).toContain('Read')
    expect(partial).not.toContain('theme.css')
    expect(complete).toContain('class="file-citation"')
    expect(complete).toContain('<span>theme.css</span>')
  })

  it('attaches and formats the completed turn duration on the latest reply', () => {
    const items = completeLatestTurn([{
      id: 'agent-1',
      kind: 'agent',
      title: 'Codex',
      content: 'Done',
      timestamp: '',
    }], 65_000)

    expect(items[0]?.durationMs).toBe(65_000)
    expect(formatDuration(65_000)).toBe('1m 5s')

    const html = renderToStaticMarkup(<ActivityCard item={items[0]!} />)
    expect(html).toContain('Worked for 1m 5s')
  })

  it('attaches turn duration to the final answer instead of commentary', () => {
    const items = completeLatestTurn([{
      id: 'commentary-1',
      kind: 'agent',
      phase: 'commentary',
      title: 'Codex',
      content: 'Checking.',
      timestamp: '',
    }, {
      id: 'final-1',
      kind: 'agent',
      phase: 'final_answer',
      title: 'Codex',
      content: 'Done.',
      timestamp: '',
    }], 1_000)

    expect(items[0]?.durationMs).toBeUndefined()
    expect(items[1]?.durationMs).toBe(1_000)
  })

  it('suppresses individual file patches before the completed turn handoff', () => {
    const html = renderToStaticMarkup(<ActivityCard item={{
      id: 'file-1',
      kind: 'file',
      title: 'Files',
      content: '{"type":"fileChange"}',
      timestamp: '',
      files: [{
        path: '/tmp/example.ts',
        kind: 'update',
        diff: '-old\n+new',
        additions: 1,
        deletions: 1,
      }],
    }} />)

    expect(html).toBe('')
  })

  it('renders one aggregated file handoff only after the turn completes', () => {
    const items = [{
      id: 'user-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      kind: 'user' as const,
      title: 'You',
      content: 'Update the files',
      timestamp: '',
    }, {
      id: 'file-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      kind: 'file' as const,
      title: 'Files',
      content: '',
      timestamp: '',
      files: [{
        path: '/tmp/project/src/example.ts',
        kind: 'update' as const,
        diff: '-old\n+new',
        additions: 1,
        deletions: 1,
      }],
    }, {
      id: 'file-2',
      threadId: 'thread-1',
      turnId: 'turn-2',
      kind: 'file' as const,
      title: 'Files',
      content: '',
      timestamp: '',
      files: [{
        path: '/tmp/project/src/example.ts',
        kind: 'update' as const,
        diff: '+again',
        additions: 1,
        deletions: 0,
      }, {
        path: '/tmp/project/src/other.ts',
        kind: 'create' as const,
        diff: '+other',
        additions: 1,
        deletions: 0,
      }],
    }, {
      id: 'agent-1',
      threadId: 'thread-1',
      turnId: 'turn-2',
      kind: 'agent' as const,
      phase: 'final_answer' as const,
      title: 'Codex',
      content: 'Done.',
      durationMs: 1_000,
      timestamp: '',
    }]

    const active = renderToStaticMarkup(<ActivityTimeline items={items} active />)
    expect(active).not.toContain('file-change-card')
    expect(active).not.toContain('Edited 2 files')

    const completed = renderToStaticMarkup(<ActivityTimeline items={items} />)
    expect(completed.match(/file-change-card/g)).toHaveLength(1)
    expect(completed).toContain('Edited 2 files')
    expect(completed).toContain('+3')
    expect(completed).toContain('−1')
    expect(completed).toContain('data-activity-id="file-summary:thread-1:turn-2"')
  })

  it('delegates expanded file diffs to the active code-block renderer', () => {
    const CodeBlock = ({ code, language }: { code: string; language?: string }) => (
      <section data-test-code-block={language}>{code}</section>
    )
    const html = renderToStaticMarkup(
      <DiffView diff={'@@ -1 +1 @@\n-old\n+new'} codeBlock={CodeBlock} />,
    )

    expect(html).toContain('class="file-change-diff-view"')
    expect(html).toContain('data-test-code-block="diff"')
    expect(html).toContain('@@ -1 +1 @@')
    expect(html).not.toContain('file-change-diff-deletion')
  })

  it('restores timing and file cards from reopened tasks', () => {
    const activities = activitiesFromThread({
      summary: {
        id: 'thread-1',
        title: 'Edit a file',
        preview: 'Edit a file',
        cwd: '/tmp/project',
        createdAt: 1,
        updatedAt: 2,
      },
      messages: [{
        id: 'agent-1',
        role: 'agent',
        text: 'Done.',
        durationMs: 5_000,
        fileChanges: [{
          path: '/tmp/project/app.ts',
          kind: 'update',
          diff: '-old\n+new',
        }],
      }],
    })

    expect(activities).toHaveLength(2)
    expect(activities[0]).toMatchObject({ kind: 'agent', durationMs: 5_000 })
    expect(activities[1]).toMatchObject({
      kind: 'file',
      files: [{ path: '/tmp/project/app.ts', additions: 1, deletions: 1 }],
    })
  })

  it('keeps the latest completed turn work visible behind the timing row', () => {
    const items = [{
      id: 'user-1',
      kind: 'user' as const,
      title: 'You',
      content: 'Make the change',
      timestamp: '',
    }, {
      id: 'tool-1',
      kind: 'tool' as const,
      title: 'Read files',
      content: 'internal detail',
      timestamp: '',
    }, {
      id: 'agent-1',
      kind: 'agent' as const,
      title: 'Codex',
      content: 'Done.',
      durationMs: 6_000,
      timestamp: '',
    }]

    expect(activityTurns(items)).toEqual([items])
    const html = renderToStaticMarkup(<ActivityTimeline items={items} />)
    expect(html).toContain('Worked for 6s')
    expect(html).toContain('activity-turn-latest')
    expect(html).toContain('Done.')
    expect(html).toContain('Read files')
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('internal detail')
  })

  it('keeps an earlier final answer visible when a later turn collapses its work', () => {
    const html = renderToStaticMarkup(<ActivityTimeline items={[{
      id: 'user-1',
      kind: 'user',
      title: 'You',
      content: 'Show a table',
      timestamp: '',
    }, {
      id: 'commentary-1',
      kind: 'agent',
      phase: 'commentary',
      title: 'Codex',
      content: 'I am assembling the rows.',
      timestamp: '',
    }, {
      id: 'final-1',
      kind: 'agent',
      phase: 'final_answer',
      title: 'Codex',
      content: [
        '| Item | Type |',
        '| --- | --- |',
        '| Alto | Harness |',
      ].join('\n'),
      durationMs: 2_000,
      timestamp: '',
    }, {
      id: 'user-2',
      kind: 'user',
      title: 'You',
      content: 'Continue',
      timestamp: '',
    }, {
      id: 'final-2',
      kind: 'agent',
      phase: 'final_answer',
      title: 'Codex',
      content: 'Still here.',
      durationMs: 1_000,
      timestamp: '',
    }]} />)

    expect(html).toContain('<table')
    expect(html).toContain('Alto')
    expect(html).toContain('Harness')
    expect(html).toContain('Still here.')
    expect(html).not.toContain('I am assembling the rows.')
  })

  it('retains unchanged turn groups when the latest activity changes', () => {
    const items = Array.from({ length: 24 }, (_, index) => ([{
      id: `user-${index}`,
      kind: 'user' as const,
      title: 'You',
      content: `Prompt ${index}`,
      timestamp: '',
    }, {
      id: `agent-${index}`,
      kind: 'agent' as const,
      title: 'Codex',
      content: `Reply ${index}`,
      timestamp: '',
    }])).flat()
    const first = activityTurns(items)
    const updated = [...items]
    updated[updated.length - 1] = {
      ...updated.at(-1)!,
      content: 'Updated reply',
    }
    const second = activityTurns(updated, first)

    expect(second).toHaveLength(first.length)
    for (let index = 0; index < first.length - 1; index += 1) {
      expect(second[index]).toBe(first[index])
    }
    expect(second.at(-1)).not.toBe(first.at(-1))
  })

  it('keeps the newest live reply below work inserted into the active turn', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[{
      id: 'user-1',
      kind: 'user',
      title: 'You',
      content: 'Make the change',
      timestamp: '',
    }, {
      id: 'commentary-1',
      kind: 'agent',
      phase: 'commentary',
      title: 'Codex',
      content: 'I am checking the layout.',
      timestamp: '',
    }, {
      id: 'reasoning-1',
      kind: 'reasoning',
      title: 'Thinking',
      content: 'Comparing the two layouts.',
      status: 'completed',
      timestamp: '',
    }, {
      id: 'tool-1',
      kind: 'tool',
      title: 'Used the browser',
      content: 'raw browser payload',
      status: 'completed',
      timestamp: '',
    }, {
      id: 'commentary-2',
      kind: 'agent',
      phase: 'commentary',
      title: 'Codex',
      content: 'I found the part that needs to change.',
      status: 'streaming',
      timestamp: '',
    }]} />)

    expect(html).toContain('Working for 1s')
    expect(html).toContain('I am checking the layout.')
    expect(html).toContain('Comparing the two layouts.')
    expect(html).toContain('Used the browser')
    expect(html).toContain('I found the part that needs to change.')
    expect(html).not.toContain('raw browser payload')
    expect(html).toContain('activity-turn-live-trace')
    expect(html).not.toContain('activity-turn-thinking')
    expect(html).toContain('activity-turn-work')
    expect(html).not.toContain('activity-turn-tail')
    expect(html.indexOf('I am checking the layout.')).toBeLessThan(html.indexOf('Comparing the two layouts.'))
    expect(html.indexOf('Used the browser')).toBeLessThan(html.indexOf('I found the part that needs to change.'))
  })

  it('keeps a steered prompt and earlier output in the same live turn', () => {
    const items = [{
      id: 'user-1',
      kind: 'user' as const,
      title: 'You',
      content: 'Start the work',
      timestamp: '',
    }, {
      id: 'commentary-1',
      kind: 'agent' as const,
      phase: 'commentary' as const,
      title: 'Codex',
      content: 'This intermediate output must remain visible.',
      status: 'streaming',
      timestamp: '',
    }, {
      id: 'command-1',
      kind: 'command' as const,
      title: 'Ran a command',
      content: 'internal output',
      status: 'running',
      timestamp: '',
    }, {
      id: 'user-steer',
      kind: 'user' as const,
      title: 'You',
      content: 'Change direction',
      continuesTurn: true,
      timestamp: '',
    }, {
      id: 'commentary-2',
      kind: 'agent' as const,
      phase: 'commentary' as const,
      title: 'Codex',
      content: 'Continuing with the new direction.',
      status: 'streaming',
      timestamp: '',
    }]

    expect(activityTurns(items)).toEqual([items])
    const html = renderToStaticMarkup(<ActivityTimeline active items={items} />)
    expect(html).toContain('This intermediate output must remain visible.')
    expect(html).toContain('Change direction')
    expect(html).toContain('Continuing with the new direction.')
    expect(html).not.toContain('activity-turn-stopped')
  })

  it('keeps a steered prompt visible after its older turn folds internal work', () => {
    const html = renderToStaticMarkup(<ActivityTimeline items={[{
      id: 'user-1',
      kind: 'user',
      title: 'You',
      content: 'Start the work',
      timestamp: '',
    }, {
      id: 'commentary-1',
      kind: 'agent',
      phase: 'commentary',
      title: 'Codex',
      content: 'Internal progress that can fold.',
      timestamp: '',
    }, {
      id: 'user-steer',
      kind: 'user',
      title: 'You',
      content: 'Keep this correction in the transcript',
      continuesTurn: true,
      timestamp: '',
    }, {
      id: 'final-1',
      kind: 'agent',
      phase: 'final_answer',
      title: 'Codex',
      content: 'Finished the first turn.',
      timestamp: '',
    }, {
      id: 'user-2',
      kind: 'user',
      title: 'You',
      content: 'Start another turn',
      timestamp: '',
    }, {
      id: 'final-2',
      kind: 'agent',
      phase: 'final_answer',
      title: 'Codex',
      content: 'Finished the second turn.',
      timestamp: '',
    }]} />)

    expect(html).toContain('Keep this correction in the transcript')
    expect(html).toContain('activity-turn-continuations')
    expect(html).not.toContain('Internal progress that can fold.')
  })

  it('does not move the latest commentary below a newly submitted steer', () => {
    const items = [{
      id: 'user-1',
      kind: 'user' as const,
      title: 'You',
      content: 'Start the work',
      timestamp: '',
    }, {
      id: 'commentary-1',
      kind: 'agent' as const,
      phase: 'commentary' as const,
      title: 'Codex',
      content: 'Already rendered commentary.',
      status: 'streaming',
      timestamp: '',
    }, {
      id: 'user-steer',
      kind: 'user' as const,
      title: 'You',
      content: 'Change direction',
      continuesTurn: true,
      timestamp: '',
    }]

    const html = renderToStaticMarkup(<ActivityTimeline active items={items} />)
    expect(html.indexOf('Already rendered commentary.')).toBeLessThan(html.indexOf('Change direction'))
  })

  it('folds an interrupted turn instead of exposing raw and empty work cards', () => {
    const html = renderToStaticMarkup(<ActivityTimeline items={[{
      id: 'user-1',
      kind: 'user',
      title: 'You',
      content: 'Start the work',
      timestamp: '',
    }, {
      id: 'command-1',
      kind: 'command',
      title: 'Ran a command',
      content: 'raw command output',
      status: 'running',
      timestamp: '',
    }, {
      id: 'reasoning-1',
      kind: 'reasoning',
      title: 'Thinking',
      content: '',
      status: 'streaming',
      timestamp: '',
    }, {
      id: 'commentary-1',
      kind: 'agent',
      phase: 'commentary',
      title: 'Codex',
      content: 'I made partial progress before the stop.',
      status: 'streaming',
      timestamp: '',
    }]} />)

    expect(html).toContain('activity-turn-stopped')
    expect(html).toContain('Stopped')
    expect(html).toContain('I made partial progress before the stop.')
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('activity-turn-running')
    expect(html).not.toContain('raw command output')
    expect(html).not.toContain('activity-reasoning')
  })

  it('keeps interrupted output visible after a queued turn starts', () => {
    const html = renderToStaticMarkup(<ActivityTimeline active items={[{
      id: 'user-1',
      turnId: 'turn-1',
      kind: 'user',
      title: 'You',
      content: 'Start the work',
      timestamp: '',
    }, {
      id: 'commentary-1',
      turnId: 'turn-1',
      kind: 'agent',
      phase: 'commentary',
      title: 'Codex',
      content: 'Keep this partial response visible.',
      status: 'interrupted',
      timestamp: '',
    }, {
      id: 'user-2',
      turnId: 'turn-2',
      kind: 'user',
      title: 'You',
      content: 'Continue with this instead',
      timestamp: '',
    }]} />)

    expect(html).toContain('Keep this partial response visible.')
    expect(html).toContain('activity-turn-stopped')
  })

  it('keeps turn events in append-only display order through completion', () => {
    const items = [{
      id: 'user-1',
      kind: 'user' as const,
      title: 'You',
      content: 'Make the change',
      timestamp: '',
    }, {
      id: 'tool-1',
      kind: 'tool' as const,
      title: 'Read files',
      content: 'first payload',
      timestamp: '',
    }, {
      id: 'commentary-1',
      kind: 'agent' as const,
      phase: 'commentary' as const,
      title: 'Codex',
      content: 'I found the relevant code.',
      timestamp: '',
    }, {
      id: 'command-1',
      kind: 'command' as const,
      title: 'Ran tests',
      content: 'second payload',
      timestamp: '',
    }, {
      id: 'commentary-2',
      kind: 'agent' as const,
      phase: 'commentary' as const,
      title: 'Codex',
      content: 'The regression is fixed.',
      timestamp: '',
    }, {
      id: 'final-1',
      kind: 'agent' as const,
      phase: 'final_answer' as const,
      title: 'Codex',
      content: 'Done.',
      durationMs: 4_000,
      timestamp: '',
    }]

    const html = renderToStaticMarkup(<ActivityTimeline items={items} />)
    const labels = [
      'Read files',
      'I found the relevant code.',
      'Ran tests',
      'The regression is fixed.',
      'Done.',
    ]
    const positions = labels.map((label) => html.indexOf(label))

    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(html).not.toContain('activity-turn-tail')
  })

  it('keeps the active turn label stable while tools run', () => {
    const html = renderToStaticMarkup(<ActivityTimeline items={[{
      id: 'user-1',
      kind: 'user',
      title: 'You',
      content: 'Inspect it.',
      timestamp: '',
    }, {
      id: 'command-1',
      kind: 'command',
      title: 'Ran a command',
      content: 'output',
      status: 'running',
      timestamp: '',
    }]} active />)

    expect(html).toContain('Working for 1s')
    expect(html).toContain('Ran a command')
    expect(html).not.toContain('activity-turn-thinking')
  })

  it('nests repeated tool calls behind one expandable row', () => {
    const work = [{
      id: 'tool-1',
      kind: 'tool' as const,
      title: 'Used cordis',
      content: 'first payload',
      timestamp: '',
    }, {
      id: 'reasoning-1',
      kind: 'reasoning' as const,
      title: 'Thinking',
      content: 'Checking the generated module.',
      timestamp: '',
    }, {
      id: 'command-1',
      kind: 'command' as const,
      title: 'Searched files',
      content: 'second payload',
      timestamp: '',
    }, {
      id: 'tool-2',
      kind: 'tool' as const,
      title: 'Used the browser',
      content: 'third payload',
      timestamp: '',
    }]

    expect(groupToolActivities(work)).toEqual([
      { kind: 'tool-group', items: [work[0]] },
      { kind: 'activity', item: work[1] },
      { kind: 'tool-group', items: [work[2], work[3]] },
    ])

    const html = renderToStaticMarkup(<ActivityTimeline active items={[{
      id: 'user-1',
      kind: 'user',
      title: 'You',
      content: 'Diagnose it',
      timestamp: '',
    }, ...work]} />)

    expect(html).toContain('Used cordis')
    expect(html).toContain('Searched files')
    expect(html).toContain('used the browser')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Checking the generated module.')
    expect(html).toContain('Searched files')
    expect(html).not.toContain('third payload')
  })
})
