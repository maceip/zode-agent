// Layer 3 — Composition. Source: CommaAgents (Flow IS Agent, Human IS Agent,
// declarative Strategy) with string break-signals replaced by a typed verdict.
import { MegaSession, ScriptedRuntime } from "../control/runtime.ts";
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
          for (const s of def.steps) cur = await get(s).call(cur);
          return cur;
        }
        if (def.type === "broadcast") {
          const parts = await Promise.all(def.steps.map((s) => get(s).call(input)));
          return parts.map((p, i) => `[${def.steps[i]}] ${p}`).join("\n---\n");
        }
        // cycle: observer must return a JSON verdict — no substring break-signals.
        let cur = input;
        for (let i = 0; i < def.maxCycles; i++) {
          for (const s of def.steps) cur = await get(s).call(cur);
          const verdictRaw = await get(def.observer).call(cur);
          let verdict: { approved?: boolean };
          try { verdict = JSON.parse(verdictRaw); } catch { throw new Error(`observer ${def.observer} returned non-JSON verdict`); }
          if (verdict.approved === true) return cur;
        }
        throw new Error(`cycle ${name} not approved after ${def.maxCycles} cycles`);
      }, hooks);
    },
  };
}

export function buildStrategy(def: StrategyDef, humanAsk: (p: string) => Promise<string>): Agent {
  const agents = new Map<string, Agent>();
  for (const [name, a] of Object.entries(def.agents)) {
    if (a.type === "user") agents.set(name, createHumanAgent(name, humanAsk));
    else if (a.type === "flow" && a.flow) agents.set(name, buildFlowAgent(name, a.flow, agents));
    else agents.set(name, createAgent(name, new MegaSession(new ScriptedRuntime(), { cwd: process.cwd() }, [name])));
  }
  return buildFlowAgent(def.name, def.flow, agents);
}
