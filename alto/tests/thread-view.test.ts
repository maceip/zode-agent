import { describe, expect, it } from 'vitest'
import {
  readThreadSummary,
  readThreadView,
} from '../src/server/services/thread-view.js'

const thread = {
  id: 'thread-1',
  name: null,
  preview: 'Build a small history rail',
  cwd: '/tmp/project',
  createdAt: 100,
  updatedAt: 200,
  recencyAt: 240,
  gitInfo: {
    branch: 'feature/history-rail',
    sha: 'abc1234',
    originUrl: 'https://github.com/example/history.git',
  },
  turns: [{
    id: 'turn-1',
    startedAt: 150,
    durationMs: 5_650,
    items: [
      {
        id: 'user-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Build it' }],
      },
      { id: 'tool-1', type: 'commandExecution', command: 'npm test' },
      {
        id: 'file-1',
        type: 'fileChange',
        changes: [{
          path: '/tmp/project/src/app.ts',
          kind: 'update',
          diff: '@@ -1 +1 @@\n-old\n+new',
        }],
      },
      { id: 'agent-1', type: 'agentMessage', text: 'Done.' },
    ],
  }],
}

describe('thread view boundary', () => {
  it('reduces app-server metadata to a stable summary', () => {
    expect(readThreadSummary(thread)).toEqual({
      id: 'thread-1',
      title: 'Untitled conversation',
      preview: 'Build a small history rail',
      cwd: '/tmp/project',
      createdAt: 100,
      updatedAt: 200,
      recencyAt: 240,
      gitInfo: {
        branch: 'feature/history-rail',
        sha: 'abc1234',
        originUrl: 'https://github.com/example/history.git',
      },
    })
  })

  it('keeps the generated chat name separate from its first-message preview', () => {
    const name = 'Generated chat name that remains complete for the title tooltip even when it is long'

    expect(readThreadSummary({ ...thread, name })).toMatchObject({
      title: name,
      preview: 'Build a small history rail',
    })
  })

  it('keeps conversation messages and attaches file edits to the final reply', () => {
    expect(readThreadView(thread).messages).toEqual([
      {
        id: 'thread-1:turn-1:user-1',
        role: 'user',
        text: 'Build it',
        input: [{ type: 'text', text: 'Build it' }],
        createdAt: 150,
      },
      {
        id: 'thread-1:turn-1:agent-1',
        role: 'agent',
        text: 'Done.',
        createdAt: 150,
        durationMs: 5_650,
        tracesBefore: [{
          id: 'thread-1:turn-1:tool-1',
          kind: 'command',
          title: 'Ran a command',
          text: 'npm test',
          status: 'completed',
        }],
        fileChanges: [{
          path: '/tmp/project/src/app.ts',
          kind: 'update',
          diff: '@@ -1 +1 @@\n-old\n+new',
        }],
      },
    ])
  })

  it('derives duration from turn timestamps when app-server omits durationMs', () => {
    const view = readThreadView({
      ...thread,
      turns: [{
        startedAt: 100,
        completedAt: 112.25,
        durationMs: null,
        items: [{ id: 'agent-1', type: 'agentMessage', text: 'Done.' }],
      }],
    })

    expect(view.messages[0]?.durationMs).toBe(12_250)
  })

  it('preserves reasoning, tools, and message phases for the turn disclosure', () => {
    const view = readThreadView({
      ...thread,
      turns: [{
        startedAt: 150,
        durationMs: 2_000,
        items: [{
          id: 'user-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Inspect it' }],
        }, {
          id: 'reasoning-1',
          type: 'reasoning',
          summary: ['Checking the layout.'],
          content: [],
        }, {
          id: 'commentary-1',
          type: 'agentMessage',
          phase: 'commentary',
          text: 'I found the issue.',
        }, {
          id: 'tool-1',
          type: 'mcpToolCall',
          server: 'node_repl',
          tool: 'browser',
          status: 'completed',
        }, {
          id: 'final-1',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'Fixed.',
        }],
      }],
    })

    expect(view.messages).toEqual([{
      id: 'thread-1:150:0:user-1',
      role: 'user',
      text: 'Inspect it',
      input: [{ type: 'text', text: 'Inspect it' }],
      createdAt: 150,
    }, {
      id: 'thread-1:150:0:commentary-1',
      role: 'agent',
      phase: 'commentary',
      text: 'I found the issue.',
      createdAt: 150,
      tracesBefore: [{
        id: 'thread-1:150:0:reasoning-1',
        kind: 'reasoning',
        title: 'Thinking',
        text: 'Checking the layout.',
        status: 'completed',
      }],
    }, {
      id: 'thread-1:150:0:final-1',
      role: 'agent',
      phase: 'final_answer',
      text: 'Fixed.',
      createdAt: 150,
      durationMs: 2_000,
      tracesBefore: [{
        id: 'thread-1:150:0:tool-1',
        kind: 'tool',
        title: 'Used the browser',
        text: '',
        status: 'completed',
      }],
    }])
  })

  it('keeps traces emitted after the final reply after that reply', () => {
    const view = readThreadView({
      ...thread,
      turns: [{
        startedAt: 150,
        durationMs: 2_000,
        items: [{
          id: 'user-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Inspect it' }],
        }, {
          id: 'final-1',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'The change is ready.',
        }, {
          id: 'tool-1',
          type: 'mcpToolCall',
          server: 'node_repl',
          tool: 'browser',
          status: 'completed',
        }],
      }],
    })

    expect(view.messages.at(-1)).toMatchObject({
      role: 'agent',
      text: 'The change is ready.',
      tracesAfter: [{
        id: 'thread-1:150:0:tool-1',
        kind: 'tool',
        title: 'Used the browser',
      }],
    })
  })

  it('marks steering messages as continuations of their app-server turn', () => {
    const view = readThreadView({
      ...thread,
      turns: [{
        id: 'turn-steered',
        startedAt: 150,
        items: [{
          id: 'user-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Start' }],
        }, {
          id: 'commentary-1',
          type: 'agentMessage',
          phase: 'commentary',
          text: 'Working.',
        }, {
          id: 'user-2',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Change direction' }],
        }, {
          id: 'final-1',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'Done.',
        }],
      }],
    })

    expect(view.messages.find((message) => message.id.endsWith('user-1'))?.continuesTurn).toBeUndefined()
    expect(view.messages.find((message) => message.id.endsWith('user-2'))?.continuesTurn).toBe(true)
  })

  it('qualifies reused app-server item ids by turn', () => {
    const view = readThreadView({
      ...thread,
      turns: [{
        id: 'turn-a',
        startedAt: 100,
        items: [{
          id: 'item-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'First' }],
        }],
      }, {
        id: 'turn-b',
        startedAt: 200,
        items: [{
          id: 'item-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Second' }],
        }],
      }],
    })

    expect(view.messages.map((entry) => entry.id)).toEqual([
      'thread-1:turn-a:item-1',
      'thread-1:turn-b:item-1',
    ])
  })

  it('rejects a response without a thread id', () => {
    expect(() => readThreadView({ turns: [] })).toThrow('invalid thread')
  })

  it('keeps image-only user messages when app-server returns their data URL', () => {
    const view = readThreadView({
      ...thread,
      turns: [{
        startedAt: 150,
        items: [{
          id: 'user-image',
          type: 'userMessage',
          content: [{ type: 'image', url: 'data:image/png;base64,cG5n' }],
        }],
      }],
    })

    expect(view.messages).toEqual([{
      id: 'thread-1:150:0:user-image',
      role: 'user',
      text: '',
      images: [{
        name: 'Image',
        mediaType: 'image/png',
        url: 'data:image/png;base64,cG5n',
      }],
      input: [{ type: 'image', url: 'data:image/png;base64,cG5n' }],
      createdAt: 150,
    }])
  })

  it('preserves rich prompt inputs without flattening their semantics', () => {
    const view = readThreadView({
      ...thread,
      turns: [{
        id: 'turn-rich-input',
        startedAt: 150,
        items: [{
          id: 'user-rich-input',
          type: 'userMessage',
          content: [{
            type: 'text',
            text: 'Use $review on @report',
            text_elements: [{
              byteRange: { start: 4, end: 11 },
              placeholder: '$review',
            }],
          }, {
            type: 'skill',
            name: 'review',
            path: '/skills/review/SKILL.md',
          }, {
            type: 'mention',
            name: 'report.pdf',
            path: '/tmp/report.pdf',
          }, {
            type: 'localImage',
            path: '/tmp/screenshot.png',
            detail: 'high',
          }, {
            type: 'localAudio',
            path: '/tmp/note.wav',
          }, {
            type: 'audio',
            url: 'data:audio/wav;base64,d2F2',
          }],
        }],
      }],
    })

    expect(view.messages[0]).toMatchObject({
      text: 'Use $review on @report',
      input: [{
        type: 'text',
        text: 'Use $review on @report',
        text_elements: [{
          byteRange: { start: 4, end: 11 },
          placeholder: '$review',
        }],
      }, {
        type: 'skill',
        name: 'review',
        path: '/skills/review/SKILL.md',
      }, {
        type: 'mention',
        name: 'report.pdf',
        path: '/tmp/report.pdf',
      }, {
        type: 'localImage',
        path: '/tmp/screenshot.png',
        detail: 'high',
      }, {
        type: 'localAudio',
        path: '/tmp/note.wav',
      }, {
        type: 'audio',
        url: 'data:audio/wav;base64,d2F2',
      }],
      attachments: [{ name: 'report.pdf', path: '/tmp/report.pdf' }, {
        name: 'screenshot.png',
        path: '/tmp/screenshot.png',
        mediaType: 'image/*',
      }, {
        name: 'note.wav',
        path: '/tmp/note.wav',
        mediaType: 'audio/*',
      }, {
        name: 'Audio',
        path: 'data:audio/wav;base64,d2F2',
        mediaType: 'audio/*',
      }],
    })
  })
})
