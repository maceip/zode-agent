// Layer 7b — Attention routing. Source: AgentOnWeb (normalize lifecycle attention,
// route human to exact session, presentation never decides).
import type { RecordStream, MegaRecord } from "../kernel/record-stream.ts";

export interface AttentionItem {
  sessionId: string;
  agentPath: readonly string[];
  reason: string;
  seq: number;
  approvalId?: string;
  requestId?: string;
}

export class AttentionIndex {
  #items: AttentionItem[] = [];
  readonly canApprove = false; // structural: no approve/decide method exists on the index

  watch(sessionId: string, stream: RecordStream): () => void {
    const on = (r: MegaRecord) => {
      if (r.kind === "attention") {
        const data = r.data as { approvalId?: string; requestId?: string } | undefined;
        this.#items.push({
          sessionId,
          agentPath: r.agentPath,
          reason: r.text ?? "attention",
          seq: r.seq,
          approvalId: data?.approvalId,
          requestId: data?.requestId,
        });
      }
      if (r.kind === "approval_decided") {
        this.#items = this.#items.filter((i) => i.approvalId !== (r.data as { id?: string } | undefined)?.id);
      }
      if (r.kind === "native_event") {
        const data = r.data as { kind?: string; requestId?: string } | undefined;
        if ((data?.kind === "app_answered" || data?.kind === "app_cancelled") && data.requestId) {
          this.#items = this.#items.filter((i) => i.requestId !== data.requestId);
        }
      }
    };
    stream.records.forEach(on);
    return stream.on(on);
  }

  pending(): AttentionItem[] { return [...this.#items]; }
  route(item: AttentionItem): string { return `mega://session/${item.sessionId}?path=${item.agentPath.join("/")}&seq=${item.seq}`; }
}
