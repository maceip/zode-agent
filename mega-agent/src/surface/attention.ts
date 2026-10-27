// Layer 7b — Attention routing. Source: AgentOnWeb (normalize lifecycle attention,
// route human to exact session, presentation never decides).
import type { RecordStream, MegaRecord } from "../kernel/record-stream.ts";

export interface AttentionItem { sessionId: string; agentPath: readonly string[]; reason: string; seq: number; approvalId?: string; }

export class AttentionIndex {
  #items: AttentionItem[] = [];
  readonly canApprove = false; // structural: no approve/decide method exists on the index

  watch(sessionId: string, stream: RecordStream): () => void {
    const on = (r: MegaRecord) => {
      if (r.kind === "attention") this.#items.push({ sessionId, agentPath: r.agentPath, reason: r.text ?? "attention", seq: r.seq, approvalId: (r.data as { approvalId?: string } | undefined)?.approvalId });
      if (r.kind === "turn_ended") this.#items.push({ sessionId, agentPath: r.agentPath, reason: `turn ended (${r.outcome ?? "?"})`, seq: r.seq });
      if (r.kind === "approval_decided") this.#items = this.#items.filter((i) => i.approvalId !== (r.data as { id?: string } | undefined)?.id);
    };
    stream.records.forEach(on);
    return stream.on(on);
  }

  pending(): AttentionItem[] { return [...this.#items]; }
  route(item: AttentionItem): string { return `mega://session/${item.sessionId}?path=${item.agentPath.join("/")}&seq=${item.seq}`; }
}
