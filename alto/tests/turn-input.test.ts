import { describe, expect, it } from 'vitest'
import { turnInputsFor } from '../src/server/services/turn-input.js'

describe('submitted turn inputs', () => {
  it('preserves selected skills and dropped images as typed app-server inputs', () => {
    expect(turnInputsFor({
      text: '  inspect this  ',
      skills: [{
        name: 'imagegen',
        description: 'Generate images.',
        path: '/skills/imagegen/SKILL.md',
        scope: 'system',
      }],
      images: [{
        name: 'diagram.png',
        mediaType: 'image/png',
        url: 'data:image/png;base64,cG5n',
      }],
      attachments: [{
        name: 'notes.pdf',
        path: '/Users/test/.codex/attachments/alto/notes.pdf',
        mediaType: 'application/pdf',
        size: 42,
      }],
    })).toEqual([
      { type: 'text', text: 'inspect this' },
      { type: 'skill', name: 'imagegen', path: '/skills/imagegen/SKILL.md' },
      { type: 'image', url: 'data:image/png;base64,cG5n' },
      {
        type: 'mention',
        name: 'notes.pdf',
        path: '/Users/test/.codex/attachments/alto/notes.pdf',
      },
    ])
  })

  it('allows an image-only turn', () => {
    expect(turnInputsFor({
      text: '',
      images: [{ name: 'image.png', mediaType: 'image/png', url: 'data:image/png;base64,eA==' }],
    })).toEqual([{ type: 'image', url: 'data:image/png;base64,eA==' }])
  })

  it('allows a file-only turn', () => {
    expect(turnInputsFor({
      text: '',
      attachments: [{ name: 'report.csv', path: '/attachments/report.csv' }],
    })).toEqual([{
      type: 'mention',
      name: 'report.csv',
      path: '/attachments/report.csv',
    }])
  })
})
