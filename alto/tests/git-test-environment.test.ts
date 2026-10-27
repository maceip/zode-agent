import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('Git test environment', () => {
  it('isolates Git subprocesses from interactive machine configuration', async () => {
    const readConfig = async (key: string) => (
      await execFileAsync('git', ['config', '--get', key])
    ).stdout.trim()

    await expect(readConfig('commit.gpgsign')).resolves.toBe('false')
    await expect(readConfig('tag.gpgsign')).resolves.toBe('false')
    await expect(readConfig('core.fsmonitor')).resolves.toBe('false')
    await expect(readConfig('core.hooksPath')).resolves.toMatch(/alto-vitest-git-\d+\/hooks$/u)
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('0')
  })
})
