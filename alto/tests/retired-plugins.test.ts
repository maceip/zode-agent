import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { entriesOf, parseProgramProfile } from '../src/server/program-profile.js'

const retiredPlugins = [
  'current-time',
  'canvas-clock',
  'canvas-note',
  'composer-focus-diagnostics',
]

it.each(retiredPlugins)('does not load retired plugin %s from the built-in program', (id) => {
  const profile = parseProgramProfile(readFileSync(
    new URL('../program/cordis.json', import.meta.url), 'utf8',
  ))
  for (const { entry } of entriesOf(profile)) {
    expect(entry.id).not.toBe(id)
    expect(entry.module ?? '').not.toContain(`plugins/${id}.`)
    expect(entry.client ?? '').not.toContain(`plugins/${id}.`)
  }
})

it.each(retiredPlugins)('leaves no executable code or styles for retired plugin %s', (id) => {
  // The live editor can clear files but cannot unlink them. Allow those empty
  // placeholders, as well as files removed by a future deletion-capable editor.
  for (const suffix of ['.ts', '.client.ts', '.client.tsx', '.css']) {
    const file = new URL(`../program/plugins/${id}${suffix}`, import.meta.url)
    if (existsSync(file)) expect(readFileSync(file, 'utf8').trim()).toBe('')
  }
})
