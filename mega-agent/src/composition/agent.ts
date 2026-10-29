// Layer 3 — Composition. Source: CommaAgents (Flow IS Agent, Human IS Agent,
// declarative Strategy) with string break-signals replaced by a typed verdict.
import { MegaSession, ScriptedRuntime, type RuntimeAdapter, type SessionOptions } from "../control/runtime.ts";
import type { RecordStream } from "../kernel/record-stream.ts";
import { runSpan, type Hook } from "../effects/spans.ts";

export interface Agent {
  readonly name: string;
  call(input: string, hooks?: Hook[]): Promise<string>;
  reset(): void;
}

export function createAgent(name: string, session: MegaSession): Agent {
  return {
    name, reset() {},
    call: (input, hooks = []) => runSpan({ kind: "llm", name, input }, async (i) => session.promptAndWait(String(i)), hooks),
  };
}

// Human IS Agent: same contract, execute step collects input instead of calling an LLM.
export function createHumanAgent(name: string, ask: (prompt: string) => Promise<string>): Agent {
  return { name, reset() {}, call: (input, hooks = []) => runSpan({ kind: "invoke", name, input }, async (i) => ask(String(i)), hooks) };
}

export type FlowDef =
  | { type: "sequential"; steps: string[] }
  | { type: "broadcast"; steps: string[] }
  | { type: "cycle"; steps: string[]; observer: string; maxCycles: number };

export interface StrategyDef {
  name: string;
  agents: Record<string, { type: "llm" | "user" | "flow"; flow?: FlowDef }>;
  flow: FlowDef;
}

export function buildFlowAgent(name: string, def: FlowDef, agents: Map<string, Agent>): Agent {
  const get = (n: string) => { const a = agents.get(n); if (!a) throw new Error(`unknown agent ${n}`); return a; };
  return {
    name, reset() { for (const a of agents.values()) a.reset(); },
    async call(input, hooks = []) {
      return runSpan({ kind: "invoke", name, input }, async () => {
        if (def.type === "sequential") {
          let cur = input;
          for (const s of def.steps) cur = await get(s).call(cur, hooks);
          return cur;
        }
        if (def.type === "broadcast") {
          const parts = await Promise.all(def.steps.map((s) => get(s).call(input, hooks)));
          return parts.map((p, i) => `[${def.steps[i]}] ${p}`).join("\n---\n");
        }
        // cycle: observer must return a JSON verdict — no substring break-signals.
        let cur = input;
        for (let i = 0; i < def.maxCycles; i++) {
          for (const s of def.steps) cur = await get(s).call(cur, hooks);
          const verdictRaw = await get(def.observer).call(cur, hooks);
          let verdict: { approved?: boolean };
          try { verdict = JSON.parse(verdictRaw); } catch { throw new Error(`observer ${def.observer} returned non-JSON verdict`); }
          if (verdict.approved === true) return cur;
        }
        throw new Error(`cycle ${name} not approved after ${def.maxCycles} cycles`);
      }, hooks);
    },
  };
}

export interface BuildStrategyOptions {
  runtime?: RuntimeAdapter;
  runtimeFor?: (agentName: string) => RuntimeAdapter;
  sessionFor?: (agentName: string, runtime: RuntimeAdapter) => MegaSession;
  stream?: RecordStream;
  cwd?: string;
  sessionOptions?: Omit<SessionOptions, "cwd"> & { cwd?: string };
  parentPath?: readonly string[];
}

export function buildStrategy(
  def: StrategyDef,
  humanAsk: (p: string) => Promise<string>,
  options: BuildStrategyOptions = {},
): Agent {
  const agents = new Map<string, Agent>();
  for (const [name, a] of Object.entries(def.agents)) {
    if (a.type === "user") {
      agents.set(name, createHumanAgent(name, humanAsk));
    } else if (a.type === "flow" && a.flow) {
      agents.set(name, buildFlowAgent(name, a.flow, agents));
    } else {
      const runtime = options.runtimeFor?.(name) ?? options.runtime ?? new ScriptedRuntime();
      const session = options.sessionFor?.(name, runtime) ?? new MegaSession(
        runtime,
        { cwd: options.cwd ?? process.cwd(), ...options.sessionOptions },
        [...(options.parentPath ?? []), name],
        { stream: options.stream },
      );
      agents.set(name, createAgent(name, session));
    }
  }
  return buildFlowAgent(def.name, def.flow, agents);
}
