// Layer 1 — Session kernel. Source: oar (record stream, agentPath, raw preserved)
// + deepseek-harness rule: model-visible <=> logged, projections are pure folds.
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AgentPath = readonly string[];

export type RecordKind =
  | "session_opened" | "user_message" | "steer_spliced" | "text_delta"
  | "tool_call" | "tool_result" | "turn_ended" | "usage"
  | "approval_asked" | "approval_decided" // audit-only, never model-visible (dsh)
  | "attention" | "crew_report" | "control_rejected" | "raw" | "native_event"
  | "span" | "context_stored" | "plugin_applied" | "plugin_output"
  | "task_started" | "task_waiting" | "task_completed" | "task_resumed" | "task_failed";

export interface MegaRecord {
  seq: number;
  ts: number;
  agentPath: AgentPath;
  kind: RecordKind;
  text?: string;
  tool?: string;
  outcome?: string;
  tokens?: number;
  modelVisible: boolean;
  data?: unknown; // native payload, preserved verbatim (oar rawEvents)
}

const AUDIT_ONLY: ReadonlySet<RecordKind> = new Set(["approval_asked", "approval_decided"]);

export class RecordStream {
  readonly records: MegaRecord[] = [];
  #listeners = new Set<(r: MegaRecord) => void>();
  #file?: string;

  constructor(file?: string) {
    this.#file = file;
    if (file) mkdirSync(dirname(file), { recursive: true });
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim()) this.records.push(JSON.parse(line) as MegaRecord);
      }
    }
  }

  append(kind: RecordKind, agentPath: AgentPath, fields: Partial<MegaRecord> = {}): MegaRecord {
    const record: MegaRecord = {
      seq: this.records.length, ts: Date.now(), agentPath, kind,
      modelVisible: fields.modelVisible ?? !AUDIT_ONLY.has(kind),
      ...fields,
    };
    this.records.push(record);
    if (this.#file) appendFileSync(this.#file, JSON.stringify(record) + "\n");
    for (const fn of this.#listeners) fn(record);
    return record;
  }

  on(fn: (r: MegaRecord) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}

// dsh deriveMessages(): model history comes from the log and nothing else.
export function deriveMessages(stream: RecordStream, agentPath: AgentPath = []): { role: string; content: string }[] {
  const msgs: { role: string; content: string }[] = [];
  let buf = "";
  const flush = () => { if (buf) { msgs.push({ role: "assistant", content: buf }); buf = ""; } };
  for (const r of stream.records) {
    if (!r.modelVisible || JSON.stringify(r.agentPath) !== JSON.stringify(agentPath)) continue;
    if (r.kind === "user_message" || r.kind === "steer_spliced" || r.kind === "crew_report" || r.kind === "tool_result") { flush(); msgs.push({ role: "user", content: r.text ?? "" }); }
    else if (r.kind === "text_delta") buf += r.text ?? "";
    else if (r.kind === "turn_ended") flush();
  }
  flush();
  return msgs;
}

// oar observe: pure fold -> UI state. Runs anywhere, no I/O.
export interface ConversationView { turns: number; status: "idle" | "running" | "waiting" | "ended"; lastText: string; totalTokens: number; }
export function viewOf(stream: RecordStream): ConversationView {
  let turns = 0, totalTokens = 0, lastText = "", status: ConversationView["status"] = "idle";
  for (const r of stream.records) {
    if (r.kind === "user_message") status = "running";
    if (r.kind === "text_delta") lastText += r.text ?? "";
    if (r.kind === "approval_asked") status = "waiting";
    if (r.kind === "approval_decided") status = "running";
    if (r.kind === "usage") totalTokens += r.tokens ?? 0;
    if (r.kind === "turn_ended") { turns++; status = r.outcome === "ended" ? "ended" : "idle"; }
  }
  return { turns, status, lastText, totalTokens };
}
