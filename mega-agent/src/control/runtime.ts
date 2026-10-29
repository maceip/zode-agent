// Layer 2 — Honest control plane. Source: oar (refused options, typed deliver
// answers) + alto (expectedTurnId stale-steer rejection).
import { RecordStream, deriveMessages } from "../kernel/record-stream.ts";

export interface SessionOptions { cwd: string; model?: string; effort?: string; resume?: string; [k: string]: unknown; }

export type DeliverResult =
  | { kind: "steered"; turn: number }
  | { kind: "queued"; position: number }
  | { kind: "rejected"; code: "busy" | "no_active_turn" | "runtime_exited" | "stale_turn" };

export type AbortResult =
  | { kind: "accepted"; turn: number }
  | { kind: "rejected"; code: "no_active_turn" | "runtime_exited" | "unsupported" };

export type RuntimeExecutionMode = "llm" | "autonomous-agent";

export interface RuntimeCapabilities {
  readonly executionMode: RuntimeExecutionMode;
  readonly nativeTools: boolean;
  readonly nativeApprovals: "none" | "adapter-managed" | "host-gated";
  readonly reportsUsage: boolean;
  readonly supportsHostTools: boolean;
}

export interface RuntimeHostToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface RuntimeHostToolBinding {
  readonly name: string;
  readonly instructions?: string;
  listTools(): RuntimeHostToolDefinition[];
  call(tool: string, args: Record<string, unknown>, context: { readonly signal: AbortSignal }): Promise<unknown>;
}

export interface RuntimeAdapter {
  readonly id: string;
  readonly supportedOptions: readonly string[];
  readonly canSteer: boolean;
  readonly capabilities?: RuntimeCapabilities;
  // Produces assistant text for a prompt. Real adapters wrap @botiverse/oar runtimes.
  runTurn(session: MegaSession, prompt: string): Promise<string>;
  // Optional host-tool attachment for autonomous runtimes (OAR serves these over MCP).
  bindHostTools?(binding: RuntimeHostToolBinding): Promise<void> | void;
  hostToolsAttached?(): boolean;
  // Optional live steering into the adapter's own running session.
  deliverToRuntime?(session: MegaSession, text: string): Promise<void>;
  // Optional cancellation of the adapter's own running turn.
  abortTurn?(session: MegaSession): Promise<void>;
  disposeSession?(session: MegaSession): Promise<void> | void;
  dispose?(session?: MegaSession): Promise<void> | void;
}

export const LLM_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  executionMode: "llm",
  nativeTools: false,
  nativeApprovals: "none",
  reportsUsage: false,
  supportsHostTools: false,
};

export interface MegaSessionDeps {
  stream?: RecordStream;
  recordFile?: string;
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
  readonly capabilities = LLM_RUNTIME_CAPABILITIES;
  #script: (prompt: string, history: { role: string; content: string }[]) => string;
  constructor(
    script: (prompt: string, history: { role: string; content: string }[]) => string = (p: string) => `scripted answer to: ${p}`,
  ) { this.#script = script; }
  async runTurn(session: MegaSession, prompt: string): Promise<string> {
    return this.#script(prompt, session.messages());
  }
}

let nextId = 0;
export class MegaSession {
  readonly id = `s${++nextId}`;
  readonly stream: RecordStream;
  #queue: string[] = [];
  #turn = 0;
  #running = false;
  #exited = false;

  readonly runtime: RuntimeAdapter;
  readonly options: SessionOptions;
  readonly agentPath: readonly string[];
  constructor(runtime: RuntimeAdapter, options: SessionOptions, agentPath: readonly string[] = [], deps: MegaSessionDeps = {}) {
    this.runtime = runtime; this.options = options; this.agentPath = agentPath;
    this.stream = deps.stream ?? new RecordStream(deps.recordFile);
    const refused = Object.keys(options).filter((k) => !runtime.supportedOptions.includes(k));
    if (refused.length) throw new UnsupportedOptionError(runtime.id, refused); // refuse before opening (oar)
    this.stream.append("session_opened", this.agentPath, { data: { runtime: runtime.id, options, sessionId: this.id } });
  }

  // One history derivation for every adapter and UI projection.
  messages() { return deriveMessages(this.stream, this.agentPath); }
  get activeTurn() { return this.#running ? this.#turn : null; }

  // oar deliver(): steers where possible, queues where not, rejects honestly.
  deliver(text: string, expectedTurn?: number): DeliverResult {
    if (this.#exited) return this.#reject("runtime_exited");
    if (this.#running && expectedTurn !== undefined && expectedTurn !== this.#turn) return this.#reject("stale_turn"); // alto
    if (this.#running && this.runtime.canSteer) {
      this.stream.append("steer_spliced", this.agentPath, { text }); // dsh: steering is logged
      if (this.runtime.deliverToRuntime) {
        void this.runtime.deliverToRuntime(this, text).catch((error: unknown) => {
          this.stream.append("raw", this.agentPath, { modelVisible: false, data: { kind: "runtime_deliver_failed", error: error instanceof Error ? error.message : String(error) } });
        });
      }
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
      if (!this.runtime.capabilities?.reportsUsage) {
        this.stream.append("usage", this.agentPath, {
          tokens: Math.ceil((text.length + answer.length) / 4),
          modelVisible: false,
          data: { estimated: true },
        });
      }
      this.stream.append("turn_ended", this.agentPath, { outcome: "completed" });
      return answer;
    } finally {
      this.#running = false;
      const queued = this.#queue.splice(0);
      for (const q of queued) await this.promptAndWait(q);
    }
  }

  async abort(): Promise<AbortResult> {
    if (this.#exited) return { kind: "rejected", code: "runtime_exited" };
    if (!this.#running) return { kind: "rejected", code: "no_active_turn" };
    if (!this.runtime.abortTurn) {
      this.stream.append("control_rejected", this.agentPath, {
        data: { action: "abort", code: "unsupported" },
        modelVisible: false,
      });
      return { kind: "rejected", code: "unsupported" };
    }
    await this.runtime.abortTurn(this);
    return { kind: "accepted", turn: this.#turn };
  }
  dispose() {
    if (this.#exited) return;
    this.#exited = true;
    this.stream.append("turn_ended", this.agentPath, { outcome: "ended" });
    void this.runtime.disposeSession?.(this);
  }
}
