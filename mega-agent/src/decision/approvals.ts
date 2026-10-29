// Layer 8 — Decision plane. Sources: deepseek-harness (fail-closed one-shot
// waterfall, audit-only events) + openhuman (durable parked approvals).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RecordStream } from "../kernel/record-stream.ts";

export interface ApprovalRequest { id: string; tool: string; summary: string; agentPath: readonly string[]; createdAt: number; data?: unknown; }
export type ApprovalAnswer = { decision: "allow" | "deny"; by: string } | undefined; // undefined = pass to next answerer
export type Answerer = (req: ApprovalRequest) => Promise<ApprovalAnswer> | ApprovalAnswer;

interface Parked { req: ApprovalRequest; state: "parked" | "allow" | "deny"; by?: string; }

export class ParkedApprovalError extends Error { readonly id: string; constructor(id: string) { super(`approval parked: ${id}`); this.id = id; } }

export class ApprovalGate {
  #parked = new Map<string, Parked>();
  #n = 0;
  readonly stream: RecordStream;
  readonly answerers: Answerer[];
  readonly storeFile?: string;
  constructor(stream: RecordStream, answerers: Answerer[], storeFile?: string) {
    this.stream = stream; this.answerers = answerers; this.storeFile = storeFile;
    if (storeFile && existsSync(storeFile)) {
      for (const p of JSON.parse(readFileSync(storeFile, "utf8")) as Parked[]) this.#parked.set(p.req.id, p);
    }
  }

  #persist() {
    if (!this.storeFile) return;
    mkdirSync(dirname(this.storeFile), { recursive: true });
    writeFileSync(this.storeFile, JSON.stringify([...this.#parked.values()], null, 2));
  }

  // Fail-closed: no answerer answering => request parks (durable), caller may resume later.
  async request(req: Omit<ApprovalRequest, "id" | "createdAt">): Promise<{ decision: "allow" | "deny"; by: string; id: string }> {
    const full: ApprovalRequest = { ...req, id: `a${++this.#n}-${Date.now()}`, createdAt: Date.now() };
    this.stream.append("approval_asked", full.agentPath, { tool: full.tool, data: { id: full.id, summary: full.summary, request: full.data } });
    this.stream.append("attention", full.agentPath, { text: `approval needed: ${full.tool}`, data: { approvalId: full.id }, modelVisible: false });
    for (const a of this.answerers) {
      const ans = await a(full);
      if (ans) return this.#decide(full, ans.decision, ans.by);
    }
    this.#parked.set(full.id, { req: full, state: "parked" });
    this.#persist();
    throw new ParkedApprovalError(full.id);
  }

  parked(): ApprovalRequest[] { return [...this.#parked.values()].filter(p => p.state === "parked").map(p => p.req); }

  // Human (or authorized machine answerer) resolves a parked request after any delay, incl. restart.
  resolveParked(id: string, decision: "allow" | "deny", by: string): { decision: "allow" | "deny"; by: string; id: string } {
    const p = this.#parked.get(id);
    if (!p || p.state !== "parked") throw new Error(`no parked approval ${id}`);
    const result = this.#decide(p.req, decision, by);
    this.#parked.delete(id); this.#persist();
    return result;
  }

  #decide(req: ApprovalRequest, decision: "allow" | "deny", by: string) {
    this.stream.append("approval_decided", req.agentPath, { tool: req.tool, data: { id: req.id, decision, by } });
    return { decision, by, id: req.id };
  }
}
