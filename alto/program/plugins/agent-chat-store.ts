import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isRecord, type ThreadSummary } from '../../src/shared/protocol.js'
import { isAgentChatId, type AgentChat } from './agent-chats-api.js'

export class AgentChatStore {
  private readonly summaries = new Map<string, ThreadSummary>()
  private readonly saving = new Map<string, Promise<void>>()
  private readonly dirty = new Map<string, AgentChat>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly directory: string,
    private readonly failed: (chat: AgentChat, error: unknown) => void,
  ) {}

  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(path.join(this.directory, 'index.json'), 'utf8'))
      if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.threads)) throw new Error('Invalid saved agent chat index')
      for (const thread of value.threads) {
        if (isRecord(thread) && typeof thread.id === 'string' && isAgentChatId(thread.id)) {
          this.summaries.set(thread.id, thread as unknown as ThreadSummary)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  threads(): ThreadSummary[] { return [...this.summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt) }

  has(id: string): boolean { return this.summaries.has(id) }

  updateSummary(chat: AgentChat): void { this.summaries.set(chat.summary.id, { ...chat.summary }) }

  async read(id: string): Promise<AgentChat> {
    if (!isAgentChatId(id)) throw new Error('Agent chat was not found')
    const chat = JSON.parse(await readFile(path.join(this.directory, `${id}.json`), 'utf8')) as AgentChat
    if (chat.summary?.id !== id || !chat.summary.providerId || !chat.summary.providerSessionId || !Array.isArray(chat.activities)) {
      throw new Error('Invalid saved agent chat')
    }
    return chat
  }

  schedule(chat: AgentChat): void {
    this.dirty.set(chat.summary.id, chat)
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 1000)
  }

  private write(name: string, value: unknown): Promise<void> {
    const content = JSON.stringify(value)
    const operation = (this.saving.get(name) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const target = path.join(this.directory, name)
      const temporary = `${target}.${randomUUID()}.tmp`
      await writeFile(temporary, content, { mode: 0o600 })
      await rename(temporary, target)
    })
    this.saving.set(name, operation)
    return operation
  }

  async save(chat: AgentChat): Promise<void> {
    await this.write(`${chat.summary.id}.json`, chat)
    await this.write('index.json', { version: 1, threads: this.threads() })
  }

  private async flush(): Promise<void> {
    const chats = [...this.dirty.values()]
    this.dirty.clear()
    for (const chat of chats) await this.save(chat).catch((error: unknown) => this.failed(chat, error))
  }

  async dispose(): Promise<void> {
    clearTimeout(this.timer)
    await this.flush()
    await Promise.allSettled(this.saving.values())
  }
}
