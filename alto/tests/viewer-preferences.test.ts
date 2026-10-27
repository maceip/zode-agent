import { describe, expect, it } from 'vitest'
import {
  readLineWrapPreference,
  writeLineWrapPreference,
} from '../program/plugins/viewer-preferences.js'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('viewer preferences', () => {
  it('keeps line wrapping independent for each viewer', () => {
    const storage = memoryStorage()

    expect(readLineWrapPreference('diff', false, storage)).toBe(false)
    expect(readLineWrapPreference('markdown', true, storage)).toBe(true)

    writeLineWrapPreference('diff', true, storage)
    writeLineWrapPreference('markdown', false, storage)

    expect(readLineWrapPreference('diff', false, storage)).toBe(true)
    expect(readLineWrapPreference('markdown', true, storage)).toBe(false)
    expect(readLineWrapPreference('source', false, storage)).toBe(false)
  })
})
