// Layer 7a — Transactional self-modifying workspace. Source: alto (bundle, hash,
// reconcile, roll back on failure, commit only after activation; proposals).
import { createHash } from "node:crypto";
import vm from "node:vm";

export interface PluginModule { id: string; source: string; hash: string; }
export interface ReloadResult { ok: boolean; revision: number; changed: string[]; error?: string; rolledBack: boolean; }

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export class WorkspaceProgram {
  #plugins = new Map<string, PluginModule>();
  #proposals = new Map<string, PluginModule[]>();
  revision = 0;

  // alto cordis_propose_change: validate only, keep in memory, human accepts.
  propose(id: string, modules: { id: string; source: string }[]): { ok: boolean; error?: string } {
    const compiled: PluginModule[] = [];
    for (const m of modules) {
      try { new vm.Script(m.source); } catch (e) { return { ok: false, error: `${m.id}: ${(e as Error).message}` }; }
      compiled.push({ ...m, hash: hash(m.source) });
    }
    this.#proposals.set(id, compiled);
    return { ok: true };
  }

  acceptProposal(id: string): ReloadResult {
    const modules = this.#proposals.get(id);
    if (!modules) return { ok: false, revision: this.revision, changed: [], error: `no proposal ${id}`, rolledBack: false };
    this.#proposals.delete(id);
    return this.#apply(modules);
  }

  // alto cordis_reprogram: same transactional path, applied immediately.
  reprogram(modules: { id: string; source: string }[]): ReloadResult {
    const p = this.propose("__direct", modules);
    if (!p.ok) return { ok: false, revision: this.revision, changed: [], error: p.error, rolledBack: true };
    return this.acceptProposal("__direct");
  }

  #apply(modules: PluginModule[]): ReloadResult {
    const prev = new Map(this.#plugins);
    const changed = modules.filter((m) => prev.get(m.id)?.hash !== m.hash).map((m) => m.id);
    try {
      // Activation check: each changed module must evaluate in a scratch isolate.
      for (const m of modules) vm.runInNewContext(m.source, {}, { timeout: 250 });
      for (const m of modules) this.#plugins.set(m.id, m);
      this.revision++;
      return { ok: true, revision: this.revision, changed, rolledBack: false };
    } catch (e) {
      this.#plugins = prev; // rollback: observer sees complete old or complete new program (alto)
      return { ok: false, revision: this.revision, changed, error: (e as Error).message, rolledBack: true };
    }
  }

  get(id: string): PluginModule | undefined { return this.#plugins.get(id); }
  ids(): string[] { return [...this.#plugins.keys()]; }
}
