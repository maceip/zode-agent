// Layer 6 — Fleet economics. Source: openhuman (TinyJuice CCR handles: context by
// reference, expand on demand; Jev deferred-tool search: schemas per need).

export class ContextStore {
  #store = new Map<string, string>();
  #n = 0;
  readonly inlineThresholdChars: number;
  constructor(inlineThresholdChars = 2000) { this.inlineThresholdChars = inlineThresholdChars; }

  // Large payloads enter model history as a short handle, payload expands on demand.
  put(text: string): { handle?: string; inline: string; savedChars: number } {
    if (text.length <= this.inlineThresholdChars) return { inline: text, savedChars: 0 };
    const handle = `ccr:${++this.#n}`;
    this.#store.set(handle, text);
    const inline = `[context ${handle} · ${text.length} chars · expand with expand_context]`;
    return { handle, inline, savedChars: text.length - inline.length };
  }
  expand(handle: string): string {
    const v = this.#store.get(handle);
    if (!v) throw new Error(`unknown context handle ${handle}`);
    return v;
  }
  peek(handle: string): string | undefined { return this.#store.get(handle); }
  restoreEntry(handle: string, text: string): void {
    this.#store.set(handle, text);
    const suffix = /^ccr:(\d+)$/.exec(handle)?.[1];
    if (suffix) this.#n = Math.max(this.#n, Number(suffix));
  }
  get size() { return this.#store.size; }
}

export interface ToolDef {
  name: string;
  description: string;
  schemaChars: number;
  schema?: Record<string, unknown>;
  requiresApproval?: boolean;
  idempotent?: boolean;
}

export class DeferredToolRegistry {
  #tools = new Map<string, ToolDef>();
  register(tool: ToolDef) { this.#tools.set(tool.name, tool); }
  get count() { return this.#tools.size; }
  get(name: string): ToolDef | undefined { return this.#tools.get(name); }
  list(): ToolDef[] { return [...this.#tools.values()]; }
  // Turn payload contains names only; full schemas load for searched tools only.
  indexForPrompt(): string { return [...this.#tools.keys()].join(", "); }
  search(query: string): ToolDef[] {
    const terms = query.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
    if (!terms.length) return [];
    return [...this.#tools.values()].filter((t) => {
      const haystack = `${t.name} ${t.description}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
  }
  schemaForPrompt(tool: ToolDef): string {
    return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.schema ?? {}, requiresApproval: !!tool.requiresApproval });
  }
  charsIfAllEager(): number { return [...this.#tools.values()].reduce((a, t) => a + t.schemaChars, 0); }
}
