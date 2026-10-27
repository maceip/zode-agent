// Layer 3b — Span effects. Source: jaz. One algebra for budget, cache, replay,
// validation, typed returns. Spans: invoke | llm | exec. Effects: Supply/Modify/Abort.
export type SpanKind = "invoke" | "llm" | "exec";
export interface Span { kind: SpanKind; name: string; input: unknown; }

export type Effect =
  | { kind: "supply"; value: unknown }
  | { kind: "modify"; input?: unknown; output?: unknown }
  | { kind: "abort"; reason: string }
  | undefined;

export interface Hook {
  enter?(span: Span): Effect | Promise<Effect>;
  complete?(span: Span, output: unknown): Effect | Promise<Effect>;
  exit?(span: Span, error?: unknown): void | Promise<void>;
}

export async function runSpan<T>(span: Span, body: (input: unknown) => Promise<T>, hooks: Hook[] = []): Promise<T> {
  let input = span.input;
  for (const h of hooks) {
    const e = await h.enter?.(span);
    if (e?.kind === "supply") return e.value as T;
    if (e?.kind === "abort") throw new Error(`aborted: ${e.reason}`);
    if (e?.kind === "modify" && e.input !== undefined) input = e.input;
  }
  try {
    let output: unknown = await body(input);
    for (const h of hooks) {
      const e = await h.complete?.(span, output);
      if (e?.kind === "abort") throw new Error(`aborted: ${e.reason}`);
      if (e?.kind === "supply") output = e.value;
      if (e?.kind === "modify" && e.output !== undefined) output = e.output;
    }
    return output as T;
  } catch (err) {
    for (const h of hooks) await h.exit?.(span, err);
    throw err;
  }
}

export class BudgetHook implements Hook {
  spent = 0;
  readonly limitTokens: number;
  constructor(limitTokens: number) { this.limitTokens = limitTokens; }
  complete(_s: Span, output: unknown): Effect {
    this.spent += Math.ceil(JSON.stringify(output ?? "").length / 4);
    return this.spent > this.limitTokens ? { kind: "abort", reason: `budget ${this.limitTokens} exceeded (${this.spent})` } : undefined;
  }
}

export class ReturnTypeHook implements Hook {
  readonly check: (v: unknown) => boolean;
  readonly label: string;
  constructor(check: (v: unknown) => boolean, label: string) { this.check = check; this.label = label; }
  complete(_s: Span, output: unknown): Effect {
    return this.check(output) ? undefined : { kind: "abort", reason: `return type ${this.label} not satisfied` };
  }
}

export class CacheHook implements Hook {
  #cache = new Map<string, unknown>();
  enter(span: Span): Effect {
    const key = span.kind + ":" + JSON.stringify(span.input);
    return this.#cache.has(key) ? { kind: "supply", value: this.#cache.get(key) } : undefined;
  }
  complete(span: Span, output: unknown): Effect {
    this.#cache.set(span.kind + ":" + JSON.stringify(span.input), output);
    return undefined;
  }
}
