import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { desktopExecutablePath } from '../src/desktop/process-environment.js'

describe('desktop process environment', () => {
  it('adds user and package-manager bins to the minimal Dock PATH', () => {
    const entries = desktopExecutablePath(
      ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
      '/Users/tester',
    ).split(delimiter)

    expect(entries).toEqual([
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/Users/tester/.local/bin',
      '/Users/tester/.npm-global/bin',
      '/Users/tester/.volta/bin',
      '/Users/tester/.bun/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
    ])
  })

  it('does not duplicate an executable directory already in PATH', () => {
    const entries = desktopExecutablePath(
      ['/opt/homebrew/bin', '/usr/bin', '/opt/homebrew/bin'].join(delimiter),
      '/Users/tester',
    ).split(delimiter)

    expect(entries.filter((entry) => entry === '/opt/homebrew/bin')).toHaveLength(1)
    expect(entries.slice(0, 2)).toEqual(['/opt/homebrew/bin', '/usr/bin'])
  })
})
