import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const gitTestRoot = path.join(tmpdir(), `alto-vitest-git-${process.pid}`)
const globalConfig = path.join(gitTestRoot, 'global.gitconfig')
const emptyHooks = path.join(gitTestRoot, 'hooks')

mkdirSync(emptyHooks, { recursive: true })
writeFileSync(globalConfig, '', { flag: 'a' })

const gitConfig = [
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['core.hooksPath', emptyHooks],
  ['core.fsmonitor', 'false'],
] as const

// Git subprocesses spawned by tests—including through production code—inherit
// this environment. Keep the test suite independent of each developer's Git
// configuration without changing the environment used by Alto itself.
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = globalConfig
process.env.GIT_CONFIG_COUNT = String(gitConfig.length)
for (const [index, [key, value]] of gitConfig.entries()) {
  process.env[`GIT_CONFIG_KEY_${index}`] = key
  process.env[`GIT_CONFIG_VALUE_${index}`] = value
}

// Fail instead of opening an interactive credential or editor prompt.
process.env.GIT_TERMINAL_PROMPT = '0'
process.env.GCM_INTERACTIVE = 'Never'
process.env.GIT_EDITOR = 'true'
process.env.GIT_SEQUENCE_EDITOR = 'true'
process.env.GIT_MERGE_AUTOEDIT = 'no'
