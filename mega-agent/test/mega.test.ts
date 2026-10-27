import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MegaSession, ScriptedRuntime, UnsupportedOptionError, deriveMessages, viewOf,
  createAgent, createHumanAgent, buildFlowAgent, buildStrategy, runSpan,
  BudgetHook, ReturnTypeHook, CacheHook, ApprovalGate, ParkedApprovalError,
  Crew, runInIsolate, ContextStore, DeferredToolRegistry, WorkspaceProgram, AttentionIndex,
} from "../src/index.ts";

test("L1 kernel: records have seq+agentPath; approval audit never model-visible", async () => {
  const s = new MegaSession(new ScriptedRuntime(p => `ok ${p}`), { cwd: "." }, ["a"]);
  await s.promptAndWait("hi");
  assert.equal(s.stream.records[0].seq, 0);
  assert.ok(s.stream.records.every(r => Array.isArray(r.agentPath)));
  const gate = new ApprovalGate(s.stream, [() => ({ decision: "allow", by: "test" })]);
  await gate.request({ tool: "bash", summary: "secret cmd", agentPath: ["a"] });
  const msgs = deriveMessages(s.stream, ["a"]);
  assert.ok(!msgs.some(m => m.content.includes("secret cmd")), "audit leaked into model history");
  assert.equal(viewOf(s.stream).turns, 1);
});

test("L2 control: unsupported options refused; deliver honest when idle", () => {
  assert.throws(() => new MegaSession(new ScriptedRuntime(), { cwd: ".", teleport: 1 }), UnsupportedOptionError);
  const s = new MegaSession(new ScriptedRuntime(), { cwd: "." });
  assert.deepEqual(s.deliver("x"), { kind: "rejected", code: "no_active_turn" });
  s.dispose();
  assert.deepEqual(s.deliver("x"), { kind: "rejected", code: "runtime_exited" });
});

test("L3 composition: human as flow step; cycle needs typed JSON verdict", async () => {
  const llm = createAgent("w", new MegaSession(new ScriptedRuntime(p => `draft:${p}`), { cwd: "." }, ["w"]));
  const human = createHumanAgent("h", async p => `human:${p}`);
  const flow = buildFlowAgent("f", { type: "sequential", steps: ["w", "h"] }, new Map([["w", llm], ["h", human]]));
  assert.equal(await flow.call("notes"), "human:draft:notes");
  const observer = createHumanAgent("obs", async () => JSON.stringify({ approved: true }));
  const cycle = buildFlowAgent("c", { type: "cycle", steps: ["w"], observer: "obs", maxCycles: 2 }, new Map([["w", llm], ["obs", observer]]));
  assert.equal(await cycle.call("x"), "draft:x");
  const strategy = buildStrategy({ name: "s", agents: { u: { type: "user" }, a: { type: "llm" } }, flow: { type: "sequential", steps: ["u", "a"] } }, async p => `U:${p}`);
  assert.match(await strategy.call("go"), /scripted answer to: U:go/);
});

test("L3b effects: budget aborts, return-type aborts, cache supplies", async () => {
  let calls = 0;
  const cache = new CacheHook();
  const body = async () => { calls++; return "value"; };
  await runSpan({ kind: "llm", name: "t", input: "q" }, body, [cache]);
  await runSpan({ kind: "llm", name: "t", input: "q" }, body, [cache]);
  assert.equal(calls, 1);
  await assert.rejects(runSpan({ kind: "llm", name: "t", input: "z" }, async () => "x".repeat(400), [new BudgetHook(10)]), /budget/);
  await assert.rejects(runSpan({ kind: "invoke", name: "t", input: 1 }, async () => "s", [new ReturnTypeHook(v => typeof v === "number", "int")]), /return type/);
});

test("L8 decision: unanswered approval parks, survives store reload, resolves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mega-"));
  const store = join(dir, "parked.json");
  const s = new MegaSession(new ScriptedRuntime(), { cwd: "." });
  const gate = new ApprovalGate(s.stream, [() => undefined], store);
  let id = "";
  await assert.rejects(gate.request({ tool: "bash", summary: "rm x", agentPath: [] }), (e: unknown) => { id = (e as ParkedApprovalError).id; return e instanceof ParkedApprovalError; });
  const reopened = new ApprovalGate(s.stream, [], store); // simulated restart
  assert.equal(reopened.parked().length, 1);
  assert.equal(reopened.resolveParked(id, "deny", "user").decision, "deny");
  assert.equal(reopened.parked().length, 0);
});

test("L4 crew: spawn respects runtime, report wakes parent stream", async () => {
  const crew = new Crew(new Map([["scripted", new ScriptedRuntime(p => `did ${p}`)]]), 1);
  const reports: string[] = [];
  crew.onReport(r => reports.push(r.answer));
  const r = await crew.spawn("scripted", "task-1", "w1");
  assert.equal(r.answer, "did task-1");
  assert.deepEqual(r.agentPath, ["w1"]);
  assert.equal(reports.length, 1);
  await assert.rejects(crew.spawn("nope", "x"), /unknown runtime/);
});

test("L5 substrate: jailed child process, cap RPC only, timeout kills process", async () => {
  assert.equal((await runInIsolate("return 2 + 3;")).value, 5);
  assert.equal((await runInIsolate("return typeof process;")).value, "undefined");
  assert.equal((await runInIsolate("return await cap('add', 2, 2);", { capabilities: { add: (a, b) => Number(a) + Number(b) } })).value, 4);
  await assert.rejects(runInIsolate("return await cap('readSecrets');"), /capability not granted/);
  // Realm escape attempts: code generation is disabled and host functions are not reachable.
  await assert.rejects(runInIsolate("return this.constructor.constructor('return process')();"));
  await assert.rejects(runInIsolate("return ({}).constructor.constructor('return process')();"));
  await assert.rejects(runInIsolate("return cap.constructor('return process')();"));
  // Even a leaked process object in the child cannot read files (node --permission).
  assert.equal((await runInIsolate("return typeof globalThis.process;")).value, "undefined");
  await assert.rejects(runInIsolate("while (true) {}", { timeoutMs: 400 }), /timed out|isolate error/);
  const jail = (await runInIsolate("return 1;")).jail;
  assert.match(jail, /node-permission/);
});

test("L6 economics: CCR handle replaces big payload; deferred tools search", () => {
  const ctx = new ContextStore(10);
  const big = ctx.put("y".repeat(1000));
  assert.ok(big.handle && big.savedChars > 900);
  assert.equal(ctx.expand(big.handle!).length, 1000);
  assert.equal(ctx.put("tiny").inline, "tiny");
  const reg = new DeferredToolRegistry();
  reg.register({ name: "read_file", description: "read files", schemaChars: 500 });
  reg.register({ name: "bash", description: "run shell", schemaChars: 700 });
  assert.equal(reg.search("file")[0].name, "read_file");
  assert.equal(reg.charsIfAllEager(), 1200);
  assert.ok(reg.indexForPrompt().length < 20);
});

test("L7 surface: reprogram commits, broken plugin rolls back, proposal needs accept", () => {
  const ws = new WorkspaceProgram();
  assert.equal(ws.reprogram([{ id: "p", source: "globalThis.v = 1;" }]).ok, true);
  const bad = ws.reprogram([{ id: "p", source: "throw new Error('boom')" }]);
  assert.equal(bad.ok, false); assert.equal(bad.rolledBack, true);
  assert.match(ws.get("p")!.source, /v = 1/);
  ws.propose("prop1", [{ id: "q", source: "globalThis.q = 2;" }]);
  assert.equal(ws.get("q"), undefined);
  assert.equal(ws.acceptProposal("prop1").ok, true);
  assert.ok(ws.get("q"));
});

test("L7 attention: routes to exact session, cannot approve", async () => {
  const s = new MegaSession(new ScriptedRuntime(), { cwd: "." });
  const idx = new AttentionIndex();
  idx.watch(s.id, s.stream);
  const gate = new ApprovalGate(s.stream, []);
  await assert.rejects(gate.request({ tool: "bash", summary: "x", agentPath: [] }), ParkedApprovalError);
  const item = idx.pending().find(i => i.approvalId);
  assert.ok(item && idx.route(item).includes(s.id));
  assert.equal(idx.canApprove, false);
  assert.equal(typeof (idx as unknown as { approve?: unknown }).approve, "undefined");
});
