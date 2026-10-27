#!/usr/bin/env node
// End-to-end demo wiring all eight layers. Run: npm run demo (Node >= 24)
import {
  MegaSession, ScriptedRuntime, deriveMessages, viewOf, createAgent, createHumanAgent,
  buildFlowAgent, ApprovalGate, ParkedApprovalError, Crew, wakeParentOnReport,
  runInIsolate, ContextStore, DeferredToolRegistry, WorkspaceProgram, AttentionIndex,
  BudgetHook, CacheHook,
} from "./index.ts";

if (process.argv.includes("--help")) { console.log("mega-agent demo — layers: kernel, control, composition, effects, decision, crew, substrate, economics, surface"); process.exit(0); }

// Kernel + control (oar-shaped scripted runtime; real runtimes plug in at RuntimeAdapter)
const parent = new MegaSession(new ScriptedRuntime((p) => `done: ${p}`), { cwd: process.cwd(), model: "scripted-1" });
const attention = new AttentionIndex();
attention.watch(parent.id, parent.stream);
console.log("L1/L2 kernel+control:", await parent.promptAndWait("find the flaky test"));
console.log("  deliver with no active turn:", JSON.stringify(parent.deliver("late steer")));
try { new MegaSession(new ScriptedRuntime(), { cwd: ".", teleport: true }); } catch (e) { console.log("  refused option:", (e as Error).message); }

// Economics: big context by handle, tools deferred (openhuman)
const ctx = new ContextStore(100);
const big = ctx.put("x".repeat(5000));
const tools = new DeferredToolRegistry();
tools.register({ name: "read_file", description: "read a file", schemaChars: 900 });
tools.register({ name: "web_search", description: "search the web", schemaChars: 1200 });
console.log(`L6 economics: context saved ${big.savedChars} chars (${big.inline}); tool index "${tools.indexForPrompt()}" vs ${tools.charsIfAllEager()} eager schema chars; search('file') ->`, tools.search("file").map(t => t.name).join(","));

// Substrate: agent-written code in a disposable isolate (moejs properties)
const iso = await runInIsolate("console.log('from isolate'); return await cap('add', 6, 7);", { capabilities: { add: (a, b) => Number(a) + Number(b) }, hooks: [new BudgetHook(500)] });
console.log(`L5 substrate: isolate value = ${iso.value} logs = ${iso.logs.join(";")} jail = ${iso.jail}`);
try { await runInIsolate("while (true) {}", { timeoutMs: 300 }); } catch { console.log("  infinite loop: child process killed by external budget"); }

// Composition + effects: human as a flow step, cache hook dedupes (CommaAgents + jaz)
const echoSession = new MegaSession(new ScriptedRuntime((p) => `llm:${p}`), { cwd: process.cwd() }, ["writer"]);
const writer = createAgent("writer", echoSession);
const human = createHumanAgent("reviewer", async (p) => `human approved draft (${p.slice(0, 20)}...)`);
const flow = buildFlowAgent("pipeline", { type: "sequential", steps: ["writer", "reviewer"] }, new Map([["writer", writer], ["reviewer", human]]));
const cache = new CacheHook();
console.log("L3 composition:", await writer.call("draft release notes", [cache]));
console.log("  flow (LLM -> human step):", await flow.call("draft release notes"));

// Decision: approval with no answerer parks durably, human resolves later (dsh + openhuman)
const gate = new ApprovalGate(parent.stream, []);
try { await gate.request({ tool: "bash", summary: "rm -rf build/", agentPath: [] }); } catch (e) {
  if (e instanceof ParkedApprovalError) {
    console.log(`L8 decision: no answerer -> parked ${e.id}; attention:`, attention.pending().map(i => `${i.reason} @ ${attention.route(i)}`).join(" | "));
    console.log("  resolved by human:", JSON.stringify(gate.resolveParked(e.id, "deny", "user")));
  } else throw e;
}
console.log("  approval events model-visible?", deriveMessages(parent.stream).some(m => m.content.includes("rm -rf")), "(must be false)");

// Crew: cross-runtime subagent report wakes parent (oar)
const crew = new Crew(new Map([["scripted", new ScriptedRuntime((p) => `review: no races found in ${p}`)]]), 2);
wakeParentOnReport(crew, parent);
console.log("L4 crew:", (await crew.spawn("scripted", "diff on branch X", "reviewer-1")).answer);

// Surface: transactional workspace reprogram, bad plugin rolls back (alto)
const ws = new WorkspaceProgram();
console.log("L7 surface:", JSON.stringify(ws.reprogram([{ id: "greeting", source: "globalThis.greeting = 'hello v1';" }])));
console.log("  broken plugin:", JSON.stringify(ws.reprogram([{ id: "greeting", source: "throw new Error('boom')" }])), "| active still:", ws.get("greeting")?.source);

console.log("viewOf(parent):", JSON.stringify(viewOf(parent.stream)));
console.log("deriveMessages(parent):", deriveMessages(parent.stream).length, "messages from", parent.stream.records.length, "records");
