import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  entriesOf,
  mountProgramExtension,
  parseProgramExtension,
  parseProgramProfile,
} from '../src/server/program-profile.js'

describe('program profile metadata', () => {
  it('mounts external plugins beneath stable program entries', () => {
    const profile = parseProgramProfile(JSON.stringify({
      version: 2,
      plugins: [{
        id: 'host',
        name: 'Host',
        description: 'Hosts extension plugins.',
      }],
    }))
    const extension = parseProgramExtension(JSON.stringify({
      version: 1,
      mounts: [{
        parent: 'host',
        plugins: [{
          id: 'external',
          name: 'External',
          description: 'Runs from an external plugin directory.',
          module: 'plugins/external.ts',
        }],
      }],
    }))

    expect(mountProgramExtension(profile, extension).plugins[0]?.children)
      .toMatchObject([{ id: 'external', module: 'plugins/external.ts' }])
    expect(() => mountProgramExtension(profile, {
      ...extension,
      mounts: [{ ...extension.mounts[0]!, parent: 'missing' }],
    })).toThrow('unknown parent "missing"')
  })

  it('requires a display name and description for every entry', () => {
    expect(() => parseProgramProfile(JSON.stringify({
      version: 2,
      plugins: [{ id: 'unnamed' }],
    }))).toThrow()

    const profile = parseProgramProfile(JSON.stringify({
      version: 2,
      plugins: [{
        id: 'search',
        name: 'Quick Search',
        description: 'Opens commands, chats, and settings through Cmd+K.',
      }],
    }))
    expect(profile.plugins[0]).toMatchObject({
      id: 'search',
      name: 'Quick Search',
      description: 'Opens commands, chats, and settings through Cmd+K.',
      protocolVersion: 1,
    })

    const versioned = parseProgramProfile(JSON.stringify({
      version: 2,
      plugins: [{
        id: 'paired',
        name: 'Paired plugin',
        description: 'Shares a protocol between its server and browser halves.',
        protocolVersion: 2,
      }],
    }))
    expect(versioned.plugins[0]?.protocolVersion).toBe(2)
  })

  it('keeps terminals and browsers as pane types instead of Canvas pages', () => {
    const profile = parseProgramProfile(readFileSync(
      new URL('../program/cordis.json', import.meta.url),
      'utf8',
    ))
    const entries = new Map(entriesOf(profile).map(({ entry }) => [entry.id, entry]))

    expect(entries.get('ghostty-workspace')?.enabled).toBe(true)
    expect(entries.get('ghostty-terminal')?.children?.map((entry) => entry.id))
      .toContain('tmux-terminals')
    expect(entries.get('tmux-terminals')?.enabled).toBe(true)
    expect(entries.has('ghostty-canvas')).toBe(false)
    expect(entries.get('browser')?.enabled).toBe(true)
    expect(entries.get('browser')?.children).toEqual([])
    expect(entries.get('canvas')?.children?.map((entry) => entry.id)).toEqual(['canvas-tabs'])
    expect(entries.get('workspace-layout')?.children?.map((entry) => entry.id))
      .toEqual(expect.arrayContaining(['pane-tabs', 'workspace-commands', 'workspace-overview', 'code-explorer']))
    expect(entries.get('workspace-overview')).toMatchObject({
      enabled: false,
      client: 'plugins/workspace-overview.client.tsx',
    })
    expect(entries.get('code-explorer')?.children?.map((entry) => entry.id))
      .toEqual(['source-viewer', 'diff-viewer', 'file-tree'])
    expect(entries.get('diff-viewer')?.children?.map((entry) => entry.id))
      .toEqual(['code-tour'])
    expect(entries.get('code-tour')).toMatchObject({
      enabled: true,
      module: 'plugins/code-tour.ts',
      client: 'plugins/code-tour.client.tsx',
    })
    expect(entries.get('code-tour')?.config).not.toHaveProperty('model')
    expect(entries.get('code-tour')?.config).not.toHaveProperty('effort')
    expect(entries.get('work-contexts')?.children?.some((entry) => entry.id === 'work-actions'))
      .toBe(true)
    expect(entries.get('work-contexts')?.children?.map((entry) => entry.id))
      .toEqual(['work-actions'])
    expect(entries.get('git-support')?.children?.map((entry) => entry.id))
      .toEqual(['git-thread-details', 'git-pane-status'])
    expect(entries.get('sidebar')?.children?.map((entry) => entry.id))
      .toEqual(['scheduled'])
    expect(entries.get('scheduled')).toMatchObject({
      enabled: true,
      module: 'plugins/scheduled.ts',
      client: 'plugins/scheduled.client.tsx',
      children: [],
    })
    expect(entries.get('ui-surfaces')?.children?.map((entry) => entry.id))
      .toEqual(['composer', 'theme', 'file-attachments'])
    expect(entries.get('theme')?.config).toEqual({
      defaultMode: 'system',
      defaultAccent: '#7c3aed',
      defaultChrome: 'alto',
      defaultCode: 'alto',
    })
  })
})
