#!/usr/bin/env node
// Mega-Agent CLI — Live LLM runtime by default with native LiteRT-LM local engine
// and auto-detection for user-installed agents (codex, claude, grok, kimi, opencode, pi).
import {
  MegaSession, ScriptedRuntime, deriveMessages, viewOf, createAgent, createHumanAgent,
  buildFlowAgent, ApprovalGate, ParkedApprovalError, Crew, wakeParentOnReport,
  runInIsolate, ContextStore, DeferredToolRegistry, WorkspaceProgram, AttentionIndex,
  BudgetHook, CacheHook,
  detectRuntimeInventory, resolveDefaultRuntime,
} from "./index.ts";

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefix = `${flag}=`;
  const match = process.argv.find((a) => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const hasFlag = (flag: string) => process.argv.includes(flag);

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`Mega-Agent CLI

Usage:
  npm run demo                     Run full 8-layer stack using live LLM runtime by default
  node src/cli.ts                  Run full 8-layer stack using live LLM runtime by default
  node src/cli.ts --prompt "..."   Run prompt through active live runtime
  node src/cli.ts --inventory      Inspect detected local LiteRT-LM and installed agent CLIs

Flags:
  --runtime <id>     Select engine: litert-lm | claude | codex | grok | kimi | opencode | pi | scripted
  --model <id>       Select LiteRT-LM or agent model (e.g. vibethinker-3b-litertlm, gemma-4-E2B-it)
  --local, --litert  Use native LiteRT-LM local on-device engine
  --scripted         Run in deterministic offline mode (no network/agent CLI)
  --prompt <text>    Send single prompt to session
`);
  process.exit(0);
}

// 1. Discover active inventory
const inventory = await detectRuntimeInventory();

if (hasFlag("--inventory")) {
  console.log("=== Mega-Agent Runtime Inventory ===");
  console.log("Native On-Device Engine (LiteRT-LM):");
  console.log("  Installed:", inventory.localLiteRt.installed ? `yes (${inventory.localLiteRt.binary})` : "no");
  console.log("  Discovered Models:", inventory.localLiteRt.models.length ? inventory.localLiteRt.models.join(", ") : "none found in ~/.litert-lm/models");
  console.log("\nUser Installed Agent CLIs (via @botiverse/oar):");
  if (inventory.installedAgents.length === 0) {
    console.log("  No external agent CLIs detected.");
  } else {
    for (const a of inventory.installedAgents) {
      console.log(`  • ${a.id}: ${a.version ?? a.via ?? "available"}${a.command ? ` (${a.command})` : ""}`);
    }
  }
  process.exit(0);
}

// 2. Resolve default runtime
const preferred = parseArg("--runtime") ?? (hasFlag("--local") || hasFlag("--litert") ? "litert-lm" : undefined);
const model = parseArg("--model");
const scripted = hasFlag("--scripted");

const { adapter, source } = await resolveDefaultRuntime({
  preferred,
  model,
  scripted,
});

console.log(`[mega-agent] Active engine: ${adapter.id} (source: ${source})`);
if (inventory.localLiteRt.installed) {
  console.log(`[mega-agent] LiteRT-LM native engine ready: ${inventory.localLiteRt.models.length} local model(s) available`);
}
if (inventory.installedAgents.length > 0) {
  console.log(`[mega-agent] Installed agents available: ${inventory.installedAgents.map((a) => a.id).join(", ")}`);
}

// 3. Single prompt mode
const promptArg = parseArg("--prompt");
if (promptArg) {
  const session = new MegaSession(adapter, { cwd: process.cwd(), model });
  console.log(`\n> ${promptArg}`);
  const reply = await session.promptAndWait(promptArg);
  console.log(`\n${reply}\n`);
  console.log(`Records logged: ${session.stream.records.length} | Model messages: ${deriveMessages(session.stream).length}`);
  session.dispose();
  if ("dispose" in adapter && typeof (adapter as { dispose?: () => unknown }).dispose === "function") {
    await (adapter as { dispose: () => unknown }).dispose();
  }
  process.exit(0);
}

// 4. End-to-end multi-layer execution (Live LLM by default)
console.log("\n--- Layer 1 & 2: Session Kernel + Honest Control ---");
const parent = new MegaSession(adapter, { cwd: process.cwd(), model: model ?? "default" });
const attention = new AttentionIndex();
attention.watch(parent.id, parent.stream);

// In demo/test turn, execute turn through the active adapter
try {
  const initialAnswer = await parent.promptAndWait("Identify repo health and summarize agent capabilities.");
  console.log("L1/L2 response:", initialAnswer.slice(0, 160) + (initialAnswer.length > 160 ? "..." : ""));
} catch (e) {
  console.log("L1/L2 live turn note:", (e as Error).message);
}

console.log("  deliver with no active turn:", JSON.stringify(parent.deliver("late steer")));
try {
  new MegaSession(adapter, { cwd: ".", teleport: true });
} catch (e) {
  console.log("  refused option:", (e as Error).message);
}

console.log("\n--- Layer 6: Economics (CCR context handles + deferred tools) ---");
const ctx = new ContextStore(100);
const big = ctx.put("x".repeat(5000));
const tools = new DeferredToolRegistry();
tools.register({ name: "read_file", description: "read a file", schemaChars: 900 });
tools.register({ name: "web_search", description: "search the web", schemaChars: 1200 });
console.log(`L6 economics: context saved ${big.savedChars} chars (${big.inline}); tool index "${tools.indexForPrompt()}" vs ${tools.charsIfAllEager()} eager schema chars; search('file') ->`, tools.search("file").map(t => t.name).join(","));

console.log("\n--- Layer 5: Substrate (Sandboxed Isolate) ---");
const iso = await runInIsolate("console.log('from isolate'); return await cap('add', 6, 7);", {
  capabilities: { add: (a, b) => Number(a) + Number(b) },
  hooks: [new BudgetHook(500)],
});
console.log(`L5 substrate: isolate value = ${iso.value} logs = ${iso.logs.join(";")} jail = ${iso.jail}`);
try {
  await runInIsolate("while (true) {}", { timeoutMs: 300 });
} catch {
  console.log("  infinite loop: child process killed by external budget");
}

console.log("\n--- Layer 3: Composition & Effects (Unified Agent/Human/Flow) ---");
const echoSession = new MegaSession(adapter, { cwd: process.cwd() }, ["writer"]);
const writer = createAgent("writer", echoSession);
const human = createHumanAgent("reviewer", async (p) => `human approved draft (${p.slice(0, 20)}...)`);
const flow = buildFlowAgent("pipeline", { type: "sequential", steps: ["writer", "reviewer"] }, new Map([["writer", writer], ["reviewer", human]]));
const cache = new CacheHook();
try {
  console.log("L3 composition flow:", await flow.call("draft release notes"));
} catch (e) {
  console.log("L3 composition note:", (e as Error).message);
}

console.log("\n--- Layer 8: Decision Plane (Fail-Closed Parked Approvals) ---");
const gate = new ApprovalGate(parent.stream, []);
try {
  await gate.request({ tool: "bash", summary: "rm -rf build/", agentPath: [] });
} catch (e) {
  if (e instanceof ParkedApprovalError) {
    console.log(`L8 decision: no answerer -> parked ${e.id}; attention:`, attention.pending().map(i => `${i.reason} @ ${attention.route(i)}`).join(" | "));
    console.log("  resolved by human:", JSON.stringify(gate.resolveParked(e.id, "deny", "user")));
  } else throw e;
}
console.log("  approval events model-visible?", deriveMessages(parent.stream).some(m => m.content.includes("rm -rf")), "(must be false)");

console.log("\n--- Layer 4: Crew Delegation ---");
const crew = new Crew(new Map([["worker", adapter]]), 2);
wakeParentOnReport(crew, parent);
try {
  const r = await crew.spawn("worker", "diff on branch main", "reviewer-1");
  console.log("L4 crew result:", r.answer.slice(0, 100));
} catch (e) {
  console.log("L4 crew note:", (e as Error).message);
}

console.log("\n--- Layer 7: Transactional Workspace Surface ---");
const ws = new WorkspaceProgram();
console.log("L7 surface:", JSON.stringify(ws.reprogram([{ id: "greeting", source: "globalThis.greeting = 'hello v1';" }])));
console.log("  broken plugin:", JSON.stringify(ws.reprogram([{ id: "greeting", source: "throw new Error('boom')" }])), "| active still:", ws.get("greeting")?.source);

console.log("\n--- View & Session Log Summary ---");
console.log("viewOf(parent):", JSON.stringify(viewOf(parent.stream)));
console.log("deriveMessages(parent):", deriveMessages(parent.stream).length, "messages from", parent.stream.records.length, "records");

parent.dispose();
if ("dispose" in adapter && typeof (adapter as { dispose?: () => unknown }).dispose === "function") {
  await (adapter as { dispose: () => unknown }).dispose();
}
