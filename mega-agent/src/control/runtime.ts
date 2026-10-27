// Layer 2 — Honest control plane. Source: oar (refused options, typed deliver
// answers) + alto (expectedTurnId stale-steer rejection).
import { RecordStream } from "../kernel/record-stream.ts";

export interface SessionOptions { cwd: string; model?: string; effort?: string; resume?: string; [k: string]: unknown; }

export type DeliverResult =
  | { kind: "steered"; turn: number }
  | { kind: "queued"; position: number }
  | { kind: "rejected"; code: "busy" | "no_active_turn" | "runtime_exited" | "stale_turn" };

export interface RuntimeAdapter {
  readonly id: string;
  readonly supportedOptions: readonly string[];
  readonly canSteer: boolean;
  // Produces assistant text for a prompt. Real adapters wrap @botiverse/oar runtimes.
  runTurn(session: MegaSession, prompt: string): Promise<string>;
}

export class UnsupportedOptionError extends Error {
  readonly refused: string[];
  constructor(runtime: string, refused: string[]) {
    super(`${runtime} refuses options: ${refused.join(", ")}`);
    this.refused = refused;
  }
}

// Scripted runtime with real Session semantics (oar ./testing): no binary, no login.
export class ScriptedRuntime implements RuntimeAdapter {
  readonly id = "scripted";
  readonly supportedOptions = ["cwd", "model", "effort", "resume"] as const;
  readonly canSteer = true;
  #script: (prompt: string, history: { role: string; content: string }[]) => string;
  constructor(script = (p: string) => `scripted answer to: ${p}`) { this.#script = script; }
  async runTurn(session: MegaSession, prompt: string): Promise<string> {
    return this.#script(prompt, session.messages());
  }
}

let nextId = 0;
export class MegaSession {
  readonly id = `s${++nextId}`;
  readonly stream = new RecordStream();
  #queue: string[] = [];
  #turn = 0;
  #running = false;
  #exited = false;

  readonly runtime: RuntimeAdapter;
  readonly options: SessionOptions;
  readonly agentPath: readonly string[];
  constructor(runtime: RuntimeAdapter, options: SessionOptions, agentPath: readonly string[] = []) {
    this.runtime = runtime; this.options = options; this.agentPath = agentPath;
    const refused = Object.keys(options).filter((k) => !runtime.supportedOptions.includes(k));
    if (refused.length) throw new UnsupportedOptionError(runtime.id, refused); // refuse before opening (oar)
    this.stream.append("session_opened", this.agentPath, { data: { runtime: runtime.id, options } });
  }

  messages() { return this.stream.records.filter(r => r.modelVisible).map(r => ({ role: r.kind === "text_delta" ? "assistant" : "user", content: r.text ?? "" })); }
  get activeTurn() { return this.#running ? this.#turn : null; }

  // oar deliver(): steers where possible, queues where not, rejects honestly.
  deliver(text: string, expectedTurn?: number): DeliverResult {
    if (this.#exited) return this.#reject("runtime_exited");
    if (this.#running && expectedTurn !== undefined && expectedTurn !== this.#turn) return this.#reject("stale_turn"); // alto
    if (this.#running && this.runtime.canSteer) {
      this.stream.append("steer_spliced", this.agentPath, { text }); // dsh: steering is logged
      return { kind: "steered", turn: this.#turn };
    }
    if (this.#running) { this.#queue.push(text); return { kind: "queued", position: this.#queue.length }; }
    return this.#reject("no_active_turn");
  }

  #reject(code: Extract<DeliverResult, { kind: "rejected" }>["code"]): DeliverResult {
    this.stream.append("control_rejected", this.agentPath, { data: { code }, modelVisible: false });
    return { kind: "rejected", code };
  }

  async promptAndWait(text: string): Promise<string> {
    if (this.#exited) throw new Error("runtime_exited");
    this.#turn++; this.#running = true;
    this.stream.append("user_message", this.agentPath, { text });
    try {
      const answer = await this.runtime.runTurn(this, text);
      this.stream.append("text_delta", this.agentPath, { text: answer });
      this.stream.append("usage", this.agentPath, { tokens: Math.ceil((text.length + answer.length) / 4), modelVisible: false });
      this.stream.append("turn_ended", this.agentPath, { outcome: "completed" });
      return answer;
    } finally {
      this.#running = false;
      const queued = this.#queue.splice(0);
      for (const q of queued) await this.promptAndWait(q);
    }
  }

  abort(): DeliverResult { // skeleton: abort is honest about needing a live turn
    return this.#running ? { kind: "queued", position: 0 } : this.#reject("no_active_turn");
  }
  dispose() { this.#exited = true; this.stream.append("turn_ended", this.agentPath, { outcome: "ended" }); }
}
