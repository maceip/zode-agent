// Real brain: drives an installed agent runtime (claude, codex, grok, kimi,
// opencode, pi, ...) through @botiverse/oar from ../../oar.
// Dynamic import on purpose: the scripted demo and tests need zero dependencies;
// live mode fails with a plain message when oar is not built/installed.
import type { MegaSession, RuntimeAdapter } from "./runtime.ts";

// Minimal structural shapes of the oar API (oar/packages/oar/src/observe/turns.ts,
// oar/packages/oar/src/registry.ts). Runtime values are checked at import time.
interface OarEvent { kind: string; agentPath?: readonly string[]; text?: string; tool?: string; [k: string]: unknown; }
interface OarSession {
  events(cb: (e: OarEvent) => void): void;
  deliver(text: string): Promise<unknown>;
  dispose(): Promise<void>;
}
interface OarRuntime {
  installation?: () => Promise<{ kind: string } | undefined>;
  session(installation: unknown, options: Record<string, unknown>): Promise<OarSession>;
}
type PromptRun = { kind: string; text?: string; reason?: string; code?: string };

export class OarRuntimeAdapter implements RuntimeAdapter {
  readonly supportedOptions = ["cwd", "model", "effort", "resume"] as const;
  readonly canSteer = true; // oar deliver() steers or queues per runtime; MegaSession.deliver stays honest about local turns
  readonly id: string;
  #oarSession?: OarSession;
  #promptAndWait?: (s: OarSession, input: string, opts: { timeoutMs?: number }) => Promise<PromptRun>;
  #runtime: OarRuntime;
  #installation: unknown;
  #timeoutMs: number;

  private constructor(runtimeId: string, runtime: OarRuntime, installation: unknown, promptAndWait: NonNullable<OarRuntimeAdapter["#promptAndWait"]>, timeoutMs: number) {
    this.id = `oar:${runtimeId}`;
    this.#runtime = runtime;
    this.#installation = installation;
    this.#promptAndWait = promptAndWait;
    this.#timeoutMs = timeoutMs;
  }

  static async create(runtimeId = "claude", timeoutMs = 600_000): Promise<OarRuntimeAdapter> {
    let root: Record<string, unknown>, observe: Record<string, unknown>;
    try {
      root = (await import("@botiverse/oar")) as Record<string, unknown>;
      observe = (await import("@botiverse/oar/observe").catch(() => root)) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`@botiverse/oar is not importable. Build oar first: cd ../oar && pnpm install && pnpm --filter @botiverse/oar build, then in mega-agent: npm install. Cause: ${(e as Error).message}`);
    }
    const promptAndWait = (observe.promptAndWait ?? root.promptAndWait) as OarRuntimeAdapter["#promptAndWait"];
    const registry = root.defaultRuntimes as { require(id: string): OarRuntime } | undefined;
    if (!registry || typeof promptAndWait !== "function") throw new Error("@botiverse/oar loaded but defaultRuntimes/promptAndWait are missing — oar version mismatch.");
    const runtime = registry.require(runtimeId);
    const installation: unknown = await runtime.installation?.();
    if (!installation || (installation as { kind?: string }).kind !== "available") {
      throw new Error(`runtime "${runtimeId}" is not installed or not available on this machine (oar installation check).`);
    }
    return new OarRuntimeAdapter(runtimeId, runtime, installation, promptAndWait, timeoutMs);
  }

  static async detectAvailable(): Promise<Array<{ id: string; command?: string; version?: string; via?: string }>> {
    let root: Record<string, unknown>;
    try {
      root = (await import("@botiverse/oar")) as Record<string, unknown>;
    } catch {
      return [];
    }
    const registry = root.defaultRuntimes as { require(id: string): OarRuntime } | undefined;
    if (!registry) return [];

    const candidates = ["codex", "claude", "grok", "kimi", "opencode", "pi", "antigravity", "cursor", "qoder", "qwen"];
    const found: Array<{ id: string; command?: string; version?: string; via?: string }> = [];

    for (const id of candidates) {
      try {
        const rt = registry.require(id);
        const inst = (await rt.installation?.()) as { kind?: string; command?: string; version?: string; via?: string } | undefined;
        if (inst && inst.kind === "available") {
          found.push({ id, command: inst.command, version: inst.version, via: inst.via });
        }
      } catch {}
    }
    return found;
  }

  async #open(mega: MegaSession): Promise<OarSession> {
    if (this.#oarSession) return this.#oarSession;
    const session = await this.#runtime.session(this.#installation, {
      cwd: mega.options.cwd,
      ...(mega.options.model ? { model: mega.options.model } : {}),
      ...(mega.options.effort ? { effort: mega.options.effort } : {}),
      ...(mega.options.resume ? { resume: mega.options.resume } : {}),
    });
    // Mirror native events into the mega record stream as raw records (oar: raw preserved).
    session.events((e) => {
      mega.stream.append("raw", [...mega.agentPath, ...((e.agentPath as string[] | undefined) ?? [])], {
        text: e.kind === "text_delta" ? e.text : undefined, tool: e.tool, data: e, modelVisible: false,
      });
    });
    this.#oarSession = session;
    return session;
  }

  async runTurn(mega: MegaSession, prompt: string): Promise<string> {
    const session = await this.#open(mega);
    const run = await this.#promptAndWait!(session, prompt, { timeoutMs: this.#timeoutMs });
    if (run.kind === "rejected") throw new Error(`oar prompt rejected (${run.code ?? "?"}): ${run.reason ?? ""}`);
    return run.text ?? "";
  }

  async dispose(): Promise<void> { await this.#oarSession?.dispose(); this.#oarSession = undefined; }
}
