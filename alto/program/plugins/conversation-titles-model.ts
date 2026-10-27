import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isRecord } from '../../src/shared/protocol.js'
import type { ConversationTitleSnapshot } from './conversation-titles-api.js'

export function defaultConversationTitle(title: string): boolean {
  return !title.trim() || /^(?:Untitled conversation|New(?: .+)? chat)$/i.test(title)
}

/** Serializes generated and explicit names so a manual rename always wins. */
export class ConversationTitles {
  private entries: ConversationTitleSnapshot = {}
  private pending: Promise<unknown> = Promise.resolve()
  private active = true

  constructor(
    private readonly file: string,
    private readonly read: (id: string) => Promise<{ title: string; initialTitle?: string }>,
    private readonly write: (id: string, title: string) => Promise<void>,
    private readonly changed: (titles: ConversationTitleSnapshot) => void,
  ) {}

  async load(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (!isRecord(data) || data.version !== 1 || !isRecord(data.titles)) throw new Error('Invalid conversation titles file')
      for (const [id, value] of Object.entries(data.titles)) {
        if (isRecord(value) && typeof value.title === 'string' && typeof value.manual === 'boolean') {
          this.entries[id] = { title: value.title, manual: value.manual }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (this.active) this.changed(this.snapshot())
  }

  snapshot(): ConversationTitleSnapshot { return structuredClone(this.entries) }

  generate(id: string, value: string): Promise<{ updated: boolean; title: string }> {
    const title = value.replace(/\s+/g, ' ').trim()
    if (!title || title.length > 80) return Promise.reject(new Error('Use a title between 1 and 80 characters'))
    return this.enqueue(async () => {
      const current = await this.read(id)
      this.assertActive()
      const previous = this.entries[id]
      const automatic = previous
        ? !previous.manual && previous.title === current.title
        : defaultConversationTitle(current.title) || current.title === current.initialTitle
      if (!automatic) return { updated: false, title: current.title }
      if (current.title !== title) await this.write(id, title)
      await this.save(id, title, false)
      return { updated: true, title }
    })
  }

  manual(id: string, title: string, write = () => this.write(id, title)): Promise<void> {
    return this.enqueue(async () => {
      await write()
      await this.save(id, title, true)
    })
  }

  async dispose(): Promise<void> {
    this.active = false
    await this.pending.catch(() => {})
  }

  private assertActive(): void {
    if (!this.active) throw new Error('Conversation naming is unavailable')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => {}).then(() => { this.assertActive(); return operation() })
    this.pending = result
    return result
  }

  private async save(id: string, title: string, manual: boolean): Promise<void> {
    this.entries[id] = { title, manual }
    await mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, titles: this.entries }), 'utf8')
    await rename(temporary, this.file)
    if (this.active) this.changed(this.snapshot())
  }
}
