// Layer 4 — Delegation. Source: oar crews (cross-runtime subagents, report
// wakes parent) + dsh provider seam (adapter behind one interface).
import { MegaSession, type RuntimeAdapter } from "../control/runtime.ts";

export interface CrewReport { runtime: string; task: string; answer: string; agentPath: readonly string[]; }

export class Crew {
  #running = 0;
  #queue: (() => void)[] = [];
  #onReport: ((r: CrewReport) => void)[] = [];

  readonly runtimes: Map<string, RuntimeAdapter>;
  readonly maxRunning: number;
  constructor(runtimes: Map<string, RuntimeAdapter>, maxRunning = 4) { this.runtimes = runtimes; this.maxRunning = maxRunning; }

  onReport(fn: (r: CrewReport) => void) { this.#onReport.push(fn); }

  async spawn(runtimeId: string, task: string, label = runtimeId): Promise<CrewReport> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error(`unknown runtime ${runtimeId}`);
    if (this.#running >= this.maxRunning) await new Promise<void>((res) => this.#queue.push(res));
    this.#running++;
    try {
      const path = [label] as const;
      const session = new MegaSession(runtime, { cwd: process.cwd() }, path);
      const answer = await session.promptAndWait(task);
      session.dispose();
      const report: CrewReport = { runtime: runtimeId, task, answer, agentPath: path };
      for (const fn of this.#onReport) fn(report);
      return report;
    } finally {
      this.#running--;
      this.#queue.shift()?.();
    }
  }
}

export function formatReport(r: CrewReport): string {
  return `[crew report from ${r.agentPath.join(" > ")} via ${r.runtime}] task: ${r.task}\n${r.answer}`;
}

// Wire a crew so every report wakes the parent session as an attributed delivery (oar).
export function wakeParentOnReport(crew: Crew, parent: MegaSession) {
  crew.onReport((r) => {
    const result = parent.deliver(formatReport(r));
    if (result.kind === "rejected" && result.code === "no_active_turn") {
      parent.stream.append("crew_report", parent.agentPath, { text: formatReport(r) });
    }
  });
}
