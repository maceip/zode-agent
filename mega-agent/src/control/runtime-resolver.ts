// Layer 2 — Runtime Discovery & Unified Resolver.
// Auto-detects local on-device engines (LiteRT-LM) and user-installed agent CLIs
// (codex, claude, grok, kimi, opencode, pi) and provisions live LLM adapters by default.
import { OarRuntimeAdapter } from "./oar-runtime.ts";
import { LiteRtLmRuntimeAdapter, findLiteRtBinary, getLocalLiteRtModels } from "./litert-runtime.ts";
import { ScriptedRuntime, type RuntimeAdapter } from "./runtime.ts";

export interface InstalledAgentInfo {
  id: string;
  command?: string;
  version?: string;
  via?: string;
}

export interface RuntimeInventory {
  localLiteRt: {
    installed: boolean;
    binary: string | null;
    models: string[];
  };
  installedAgents: InstalledAgentInfo[];
}

export async function detectRuntimeInventory(): Promise<RuntimeInventory> {
  const binary = findLiteRtBinary();
  const models = getLocalLiteRtModels();
  const installedAgents = await OarRuntimeAdapter.detectAvailable();

  return {
    localLiteRt: {
      installed: binary !== null,
      binary,
      models,
    },
    installedAgents,
  };
}

export interface RuntimeResolutionOptions {
  preferred?: string; // "claude" | "codex" | "litert-lm" | "scripted" | etc.
  model?: string;
  scripted?: boolean;
  timeoutMs?: number;
}

export async function resolveDefaultRuntime(
  options: RuntimeResolutionOptions = {}
): Promise<{ adapter: RuntimeAdapter; source: "litert-lm" | "installed-agent" | "scripted" }> {
  // Explicit scripted fallback
  if (options.scripted || options.preferred === "scripted") {
    return { adapter: new ScriptedRuntime(), source: "scripted" };
  }

  // Explicit LiteRT-LM request
  if (options.preferred === "litert-lm" || options.preferred === "local" || options.preferred === "lightrt-lm") {
    const adapter = await LiteRtLmRuntimeAdapter.create({
      model: options.model,
      timeoutMs: options.timeoutMs,
    });
    return { adapter, source: "litert-lm" };
  }

  // Explicit agent CLI request (e.g. --runtime claude or --runtime codex)
  if (options.preferred) {
    const adapter = await OarRuntimeAdapter.create(options.preferred, options.timeoutMs);
    return { adapter, source: "installed-agent" };
  }

  // Auto-detection hierarchy: check user's installed tools first
  const inventory = await detectRuntimeInventory();

  // 1. Prefer user's active installed CLIs (codex / claude / etc.)
  const preferredAgents = ["codex", "claude", "grok", "kimi", "opencode", "pi"];
  for (const candidate of preferredAgents) {
    if (inventory.installedAgents.some((a) => a.id === candidate)) {
      try {
        const adapter = await OarRuntimeAdapter.create(candidate, options.timeoutMs);
        return { adapter, source: "installed-agent" };
      } catch {}
    }
  }

  // 2. If no external CLI succeeded, check native on-device LiteRT-LM engine
  if (inventory.localLiteRt.installed) {
    try {
      const adapter = await LiteRtLmRuntimeAdapter.create({
        model: options.model,
        timeoutMs: options.timeoutMs,
      });
      return { adapter, source: "litert-lm" };
    } catch {}
  }

  // 3. Fallback to scripted test mock if no live engines exist
  return { adapter: new ScriptedRuntime(), source: "scripted" };
}
