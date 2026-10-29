// Layer 7a — Transactional self-modifying workspace. Source: alto (bundle, hash,
// reconcile, roll back on failure, commit only after activation; proposals).
import { createHash } from "node:crypto";
import vm from "node:vm";

export interface PluginModule { id: string; source: string; hash: string; }
export interface ReloadResult { ok: boolean; revision: number; changed: string[]; error?: string; rolledBack: boolean; }
export interface WorkspaceSnapshot { revision: number; modules: PluginModule[]; }
export interface WorkspaceApplyOptions { skipActivation?: boolean; }

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

  acceptProposal(id: string, options: WorkspaceApplyOptions = {}): ReloadResult {
    const modules = this.#proposals.get(id);
    if (!modules) return { ok: false, revision: this.revision, changed: [], error: `no proposal ${id}`, rolledBack: false };
    this.#proposals.delete(id);
    return this.#apply(modules, options);
  }

  // alto cordis_reprogram: same transactional path, applied immediately.
  reprogram(modules: { id: string; source: string }[], options: WorkspaceApplyOptions = {}): ReloadResult {
    const p = this.propose("__direct", modules);
    if (!p.ok) return { ok: false, revision: this.revision, changed: [], error: p.error, rolledBack: true };
    return this.acceptProposal("__direct", options);
  }

  snapshot(): WorkspaceSnapshot {
    return { revision: this.revision, modules: [...this.#plugins.values()].map((m) => ({ ...m })) };
  }

  restore(snapshot: WorkspaceSnapshot): void {
    const restored = new Map<string, PluginModule>();
    for (const module of snapshot.modules) {
      new vm.Script(module.source); // syntax validation only; restored code runs later in the isolate
      if (module.hash !== hash(module.source)) throw new Error(`workspace plugin hash mismatch: ${module.id}`);
      restored.set(module.id, { ...module });
    }
    this.#plugins = restored;
    this.revision = snapshot.revision;
  }

  #apply(modules: PluginModule[], options: WorkspaceApplyOptions = {}): ReloadResult {
    const prev = new Map(this.#plugins);
    const changed = modules.filter((m) => prev.get(m.id)?.hash !== m.hash).map((m) => m.id);
    try {
      if (options.skipActivation) {
        // MegaAgentSystem has already activated the plugin in the jailed
        // child-process isolate. Do not evaluate plugin source again here.
        for (const m of modules) new vm.Script(m.source);
      } else {
        // Legacy synchronous activation for direct WorkspaceProgram users.
        // No host functions are exposed and code generation is disabled.
        for (const m of modules) {
          const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
          vm.runInContext(`Object.defineProperty(globalThis, "constructor", { value: undefined, configurable: false });`, context);
          vm.runInContext(m.source, context, { timeout: 250 });
        }
      }
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
