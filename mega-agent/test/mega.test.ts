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
  createMegaAgent,
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

test("integration: sessions can share one stream and abort reaches the adapter", async () => {
  const { RecordStream } = await import("../src/kernel/record-stream.ts");
  const shared = new RecordStream();
  let release!: (value: string) => void;
  let aborted = false;
  const runtime = {
    id: "slow-test-runtime",
    supportedOptions: ["cwd"],
    canSteer: false,
    runTurn: async () => new Promise<string>((resolve) => { release = resolve; }),
    abortTurn: async () => { aborted = true; release("aborted by adapter"); },
  };
  const session = new MegaSession(runtime, { cwd: "." }, ["slow"], { stream: shared });
  const sibling = new MegaSession(new ScriptedRuntime(), { cwd: "." }, ["sibling"], { stream: shared });
  const running = session.promptAndWait("wait");
  assert.deepEqual(await session.abort(), { kind: "accepted", turn: 1 });
  assert.equal(aborted, true);
  assert.equal(await running, "aborted by adapter");
  assert.equal(session.stream, shared);
  assert.equal(sibling.stream, shared);
  assert.ok(shared.records.some((r) => JSON.stringify(r.agentPath) === JSON.stringify(["slow"])));
  assert.ok(shared.records.some((r) => JSON.stringify(r.agentPath) === JSON.stringify(["sibling"])));

  const unsupported = new MegaSession({
    id: "slow-no-abort",
    supportedOptions: ["cwd"],
    canSteer: false,
    runTurn: async () => new Promise<string>((resolve) => { release = resolve; }),
  }, { cwd: "." });
  const pending = unsupported.promptAndWait("wait");
  assert.deepEqual(await unsupported.abort(), { kind: "rejected", code: "unsupported" });
  release("done");
  assert.equal(await pending, "done");
});

test("integration: parked tool is rehydrated from durable approval store by a new system", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mega-rehydrate-"));
  const store = join(dir, "approvals.json");
  const first = createMegaAgent({ cwd: dir, adapter: new ScriptedRuntime(), approvalStoreFile: store });
  const parked = await first.executeTool("run_code", { code: "return 4 + 5;" });
  assert.equal(parked.status, "parked");
  if (parked.status !== "parked") assert.fail("expected parked tool");
  await first.dispose();

  const second = createMegaAgent({ cwd: dir, adapter: new ScriptedRuntime(), approvalStoreFile: store });
  const resolved = await second.resolveApproval(parked.approvalId, "allow", "restart-test-operator");
  assert.equal(resolved.status, "tool_completed");
  if (resolved.status === "tool_completed") {
    assert.equal((resolved.result as { value: unknown }).value, 9);
  }
  await second.dispose();
});

test("integration: full task resumes after restart and continues to final answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mega-full-resume-"));
  const files = {
    approvalStoreFile: join(dir, "approvals.json"),
    taskStoreFile: join(dir, "tasks.json"),
    recordFile: join(dir, "records.jsonl"),
  };
  const marker = "RESUME_CONTEXT_MARKER";
  const script = (prompt: string, history: { content: string }[]) => {
    if (prompt.includes("[tool_result expand_context]")) {
      assert.match(prompt, new RegExp(marker));
      return "Resumed final answer: code 42 and restored context";
    }
    if (prompt.includes("[tool_result run_code]")) {
      const handle = [...history.map((m) => m.content), prompt].join("\n").match(/ccr:\d+/)?.[0];
      assert.ok(handle, "restored model history must retain the context handle");
      return JSON.stringify({ tool: "expand_context", args: { handle } });
    }
    if (prompt.includes("[tool_result search_tools]")) {
      return JSON.stringify({ tool: "run_code", args: { code: "return 40 + 2;" } });
    }
    return JSON.stringify({ tool: "search_tools", args: { query: "code" } });
  };
  const options = () => ({
    cwd: dir,
    adapter: new ScriptedRuntime(script),
    contextThresholdChars: 40,
    ...files,
  });

  const first = createMegaAgent(options());
  const waiting = await first.runTask({
    prompt: "Resume this computed task after restart.",
    context: `${marker}: ${"durable context ".repeat(12)}`,
    maxToolIterations: 8,
  });
  assert.equal(waiting.status, "waiting_approval");
  if (waiting.status !== "waiting_approval") assert.fail("expected task to park at run_code approval");
  assert.deepEqual(waiting.toolsUsed, ["search_tools"]);
  await first.dispose();

  const second = createMegaAgent(options());
  const resumed = await second.resolveApproval(waiting.approvalId, "allow", "restart-test-operator");
  assert.equal(resumed.status, "completed", "a restarted system must resume the task loop, not only execute the parked tool");
  if (resumed.status !== "completed") assert.fail("expected completed resumed task");
  assert.equal(resumed.taskId, waiting.taskId);
  assert.equal(resumed.answer, "Resumed final answer: code 42 and restored context");
  assert.deepEqual(resumed.toolsUsed, ["search_tools", "run_code", "expand_context"]);
  assert.ok(resumed.contextSavedChars > 50);
  await second.dispose();

  const third = createMegaAgent(options());
  assert.equal(third.snapshot().parkedApprovals.length, 0);
  assert.ok(third.stream.records.some((r) => r.kind === "task_completed" && (r.data as { taskId?: string }).taskId === waiting.taskId));
  await third.dispose();
});

test("integration: denied approval after restart resumes task without running parked tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mega-deny-resume-"));
  const files = {
    approvalStoreFile: join(dir, "approvals.json"),
    taskStoreFile: join(dir, "tasks.json"),
    recordFile: join(dir, "records.jsonl"),
  };
  const script = (prompt: string) => {
    if (prompt.includes("[tool_result run_code]") && prompt.includes("denied")) return "Denied-path final answer";
    if (prompt.includes("[tool_result search_tools]")) return JSON.stringify({ tool: "run_code", args: { code: "return 'must not run';" } });
    return JSON.stringify({ tool: "search_tools", args: { query: "code" } });
  };
  const make = () => createMegaAgent({ cwd: dir, adapter: new ScriptedRuntime(script), ...files });

  const first = make();
  const waiting = await first.runTask({ prompt: "Try the gated computation.", initialToolQuery: "code" });
  assert.equal(waiting.status, "waiting_approval");
  if (waiting.status !== "waiting_approval") assert.fail("expected parked approval");
  await first.dispose();

  const second = make();
  const resumed = await second.resolveApproval(waiting.approvalId, "deny", "restart-test-operator");
  assert.equal(resumed.status, "completed");
  if (resumed.status !== "completed") assert.fail("expected resumed denied task to complete");
  assert.equal(resumed.answer, "Denied-path final answer");
  assert.deepEqual(resumed.toolsUsed, ["search_tools", "run_code"]);
  assert.ok(!second.stream.records.some((r) => r.kind === "tool_result" && (r.text ?? "").includes("must not run")));
  await second.dispose();
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

test("L2 oar adapter: module loads without oar installed; create() fails plainly or succeeds", async () => {
  const { OarRuntimeAdapter } = await import("../src/control/oar-runtime.ts");
  assert.equal(typeof OarRuntimeAdapter.create, "function");
  try {
    const a = await OarRuntimeAdapter.create("definitely-not-a-runtime-xyz");
    await a.dispose();
    assert.fail("unknown runtime must not create");
  } catch (e) {
    assert.match((e as Error).message, /oar|runtime/);
  }
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

test("L2 litert-lm: native engine adapter and model discovery", async () => {
  const { LiteRtLmRuntimeAdapter, getLocalLiteRtModels, findLiteRtBinary } = await import("../src/control/litert-runtime.ts");
  assert.equal(typeof LiteRtLmRuntimeAdapter.isInstalled, "function");
  assert.equal(typeof LiteRtLmRuntimeAdapter.listModels, "function");
  const models = await LiteRtLmRuntimeAdapter.listModels();
  assert.ok(Array.isArray(models));
  if (findLiteRtBinary()) {
    assert.equal(LiteRtLmRuntimeAdapter.isInstalled(), true);
  }
});

test("integration: one task traverses kernel, runtime, plugins, context, tools, crew, approvals, isolate, human, and attention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mega-integrated-"));
  const prompts: string[] = [];
  const marker = "MEGA_SECRET_EVIDENCE";
  const adapter = new ScriptedRuntime((prompt) => {
    prompts.push(prompt);
    if (prompt === "crew-check") return "crew evidence";
    if (prompt === "human strategy evidence") return "strategy llm saw human strategy evidence";
    if (prompt.includes("[tool_result ask_human]")) return "Integrated answer: context + crew + code 42 + human confirmed";
    if (prompt.includes("[tool_result run_code]")) {
      return JSON.stringify({ tool: "ask_human", args: { prompt: "Confirm integrated result" } });
    }
    if (prompt.includes("[tool_result delegate]")) {
      return JSON.stringify({ tool: "run_code", args: { code: "return 40 + 2;" } });
    }
    if (prompt.includes("[tool_result search_tools]")) {
      return JSON.stringify({ tool: "delegate", args: { runtime: "scripted", task: "crew-check", label: "crew" } });
    }
    if (prompt.includes("[tool_result expand_context]")) {
      assert.match(prompt, new RegExp(marker));
      return JSON.stringify({ tool: "search_tools", args: { query: "delegate code human" } });
    }
    const handle = prompt.match(/ccr:\d+/)?.[0];
    assert.ok(handle, "first model prompt must carry a context handle");
    assert.ok(!prompt.includes(marker), "large context must not be inline in first prompt");
    assert.match(prompt, /PLUGIN_RULE/);
    return JSON.stringify({ tool: "expand_context", args: { handle } });
  });

  let hookCompletions = 0;
  const mega = createMegaAgent({
    cwd: dir,
    adapter,
    contextThresholdChars: 50,
    approvalStoreFile: join(dir, "approvals.json"),
    humanAsk: async (prompt) => prompt === "strategy-input" ? "human strategy evidence" : `human confirmed: ${prompt}`,
    hooks: [{ complete: () => { hookCompletions++; return undefined; } }],
  });

  const strategyAnswer = await mega.runStrategy({
    name: "connected-strategy",
    agents: { person: { type: "user" }, model: { type: "llm" } },
    flow: { type: "sequential", steps: ["person", "model"] },
  }, "strategy-input");
  assert.equal(strategyAnswer, "strategy llm saw human strategy evidence");

  const install = await mega.installPlugin({
    id: "planner",
    source: `globalThis.__plugin = async () => {
      const found = await cap("search_tools", "context");
      return { instructions: ["PLUGIN_RULE use stored material; plugin found " + found.join(",")], toolQuery: "context" };
    };`,
  });
  assert.ok(install.ok, install.error ?? "plugin install failed");

  const waiting = await mega.runTask({
    prompt: "Produce the integrated verdict from stored material with independent verification and a computed check.",
    context: `${marker}: ${"evidence ".repeat(30)}`,
    maxToolIterations: 10,
  });
  assert.equal(waiting.status, "waiting_approval");
  if (waiting.status !== "waiting_approval") assert.fail("expected parked run_code approval");
  assert.equal(waiting.tool, "run_code");
  assert.match(waiting.attentionRoute ?? "", /mega:\/\/session\//);
  assert.deepEqual(waiting.toolsUsed, ["expand_context", "search_tools", "delegate"]);
  assert.ok(!mega.stream.records.some((r) => r.kind === "tool_result" && r.tool === "run_code"), "approved code must not run before approval");

  const final = await mega.resolveApproval(waiting.approvalId, "allow", "integration-test-operator");
  assert.equal(final.status, "completed");
  if (final.status !== "completed") assert.fail("expected task completion after approval");
  assert.match(final.answer, /Integrated answer/);
  assert.deepEqual(final.toolsUsed, ["expand_context", "search_tools", "delegate", "run_code", "ask_human"]);
  assert.ok(final.contextSavedChars > 100);
  assert.ok(hookCompletions > 5, "system hooks must observe integrated spans");

  const kinds = new Set(mega.stream.records.map((r) => r.kind));
  for (const kind of ["context_stored", "plugin_applied", "plugin_output", "span", "tool_call", "tool_result", "approval_asked", "approval_decided", "task_started", "task_waiting", "task_completed"]) {
    assert.ok(kinds.has(kind as never), `shared record stream missing ${kind}`);
  }
  assert.ok(mega.stream.records.some((r) => JSON.stringify(r.agentPath) === JSON.stringify(["crew"])), "crew records must share root stream");
  assert.ok(mega.stream.records.some((r) => JSON.stringify(r.agentPath) === JSON.stringify(["strategy", "model"])), "strategy records must share root stream");
  assert.ok(prompts[0].includes("human strategy evidence") || prompts.some((p) => p.includes("PLUGIN_RULE")));
  assert.ok(mega.snapshot().messages.some((m) => m.content.includes("[tool_result run_code]")));

  await mega.dispose();
});

test("integration: concurrent root tasks are serialized instead of interleaving one session", async () => {
  const runtime = {
    id: "serial-probe",
    supportedOptions: ["cwd"],
    canSteer: false,
    runTurn: async (_session: unknown, prompt: string) => {
      await new Promise((resolve) => setTimeout(resolve, prompt.includes("TASK_A") ? 40 : 1));
      return prompt.includes("TASK_A") ? "answer A" : "answer B";
    },
  };
  const mega = createMegaAgent({ cwd: ".", adapter: runtime });
  const results = await Promise.all([
    mega.runTask({ prompt: "TASK_A" }),
    mega.runTask({ prompt: "TASK_B" }),
  ]);
  assert.deepEqual(results.map((r) => r.status === "completed" ? r.answer : r.status), ["answer A", "answer B"]);
  const events = mega.stream.records
    .filter((r) => r.kind === "text_delta")
    .map((r) => r.text);
  assert.deepEqual(events, ["answer A", "answer B"]);
  const firstAnswer = mega.stream.records.findIndex((r) => r.kind === "text_delta" && r.text === "answer A");
  const secondPrompt = mega.stream.records.findIndex((r, i) => i > firstAnswer && r.kind === "user_message");
  assert.ok(secondPrompt > firstAnswer);
  await mega.dispose();
});

test("integration: malformed tool protocol and invalid tool arguments return recoverable observations", async () => {
  let handlerCalls = 0;
  let modelCalls = 0;
  const mega = createMegaAgent({
    cwd: ".",
    adapter: new ScriptedRuntime((prompt) => {
      modelCalls++;
      if (prompt.includes("[tool_result tool_protocol]")) return "Recovered from malformed tool call";
      return "{\"tool\":\"search_tools\",";
    }),
    tools: [{
      name: "typed_echo",
      description: "echo a typed value",
      schemaChars: 180,
      schema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 1 } },
        required: ["count"],
        additionalProperties: false,
      },
      execute: () => { handlerCalls++; return "must not run"; },
    }],
  });

  const invalid = await mega.executeTool("typed_echo", { count: "two", extra: true });
  assert.equal(invalid.status, "completed");
  if (invalid.status !== "completed") assert.fail("expected validation to return a completed tool error");
  assert.equal(handlerCalls, 0);
  assert.match(invalid.text, /invalid tool arguments/);
  assert.match(invalid.text, /args\.count must be integer/);
  assert.match(invalid.text, /args\.extra is not allowed/);

  const result = await mega.runTask({ prompt: "protocol recovery check" });
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.answer, "Recovered from malformed tool call");
  assert.equal(modelCalls, 2);
  await mega.dispose();
});

test("integration: configured strategy runs inside runTask and strategy output reaches root prompt", async () => {
  const mega = createMegaAgent({
    cwd: ".",
    adapter: new ScriptedRuntime((prompt) => {
      if (prompt === "strategy-check") return "strategy evidence";
      if (prompt.includes("Configured strategy output") && prompt.includes("strategy evidence")) {
        return "root used strategy evidence";
      }
      return "strategy output missing";
    }),
    strategies: {
      check: {
        name: "check",
        agents: { model: { type: "llm" } },
        flow: { type: "sequential", steps: ["model"] },
      },
    },
  });

  const result = await mega.runTask({
    prompt: "root-check",
    strategy: "check",
    strategyInput: "strategy-check",
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") assert.fail("expected strategy task completion");
  assert.equal(result.answer, "root used strategy evidence");
  assert.deepEqual(result.toolsUsed, ["run_strategy"]);
  assert.ok(mega.stream.records.some((r) => JSON.stringify(r.agentPath) === JSON.stringify(["strategy", "model"])));
  await mega.dispose();
});

test("integration: additional crew runtimes are discoverable in delegate schema and callable", async () => {
  const other = new ScriptedRuntime((prompt) => `other runtime handled: ${prompt}`);
  const mega = createMegaAgent({
    cwd: ".",
    adapter: new ScriptedRuntime((prompt) => {
      if (prompt.includes("[tool_result delegate]")) return "root received other runtime report";
      if (prompt.includes("[tool_result search_tools]")) {
        return JSON.stringify({ tool: "delegate", args: { runtime: "other", task: "fleet-check", label: "fleet" } });
      }
      return JSON.stringify({ tool: "search_tools", args: { query: "delegate" } });
    }),
    additionalRuntimes: new Map([["other", other]]),
  });

  const delegate = mega.toolRegistry.get("delegate");
  assert.deepEqual(
    (delegate?.schema?.properties as { runtime?: { enum?: string[] } }).runtime?.enum,
    ["default", "scripted", "other"],
  );
  const result = await mega.runTask({ prompt: "fleet delegation check" });
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.answer, "root received other runtime report");
  assert.ok(mega.stream.records.some((r) => JSON.stringify(r.agentPath) === JSON.stringify(["fleet"])));
  await mega.dispose();
});

test("integration: autonomous runtime receives mega tools through host binding", async () => {
  let binding: {
    listTools(): { name: string }[];
    call(tool: string, args: Record<string, unknown>, context: { signal: AbortSignal }): Promise<unknown>;
  } | undefined;
  const runtime = {
    id: "fake-autonomous",
    supportedOptions: ["cwd"],
    canSteer: false,
    capabilities: {
      executionMode: "autonomous-agent" as const,
      nativeTools: true,
      nativeApprovals: "adapter-managed" as const,
      reportsUsage: true,
      supportsHostTools: true,
    },
    bindHostTools(next: typeof binding) { binding = next; },
    hostToolsAttached: () => binding !== undefined,
    runTurn: async () => "autonomous final",
  };
  const mega = createMegaAgent({
    cwd: ".",
    adapter: runtime,
    tools: [{
      name: "host_echo",
      description: "echo through host binding",
      schemaChars: 160,
      schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      execute: (args) => ({ echoed: args.value }),
    }],
  });

  assert.ok(binding, "system must bind host tools to autonomous runtime");
  assert.ok(binding!.listTools().some((tool) => tool.name === "host_echo"));
  assert.ok(!binding!.listTools().some((tool) => tool.name === "search_tools"));
  assert.deepEqual(await binding!.call("host_echo", { value: "through-binding" }, { signal: new AbortController().signal }), { echoed: "through-binding" });
  assert.ok(mega.stream.records.some((r) => r.kind === "tool_result" && r.tool === "host_echo"));
  await mega.dispose();
});

test("integration: workspace plugins persist and affect a later system without reinstalling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mega-workspace-persist-"));
  const workspaceStoreFile = join(dir, "workspace.json");
  const first = createMegaAgent({ cwd: dir, adapter: new ScriptedRuntime(), workspaceStoreFile });
  const install = await first.installPlugin({
    id: "persisted-planner",
    source: `globalThis.__plugin = async () => ({ instructions: ["PERSISTED_PLUGIN_RULE"], toolQuery: "context" });`,
  });
  assert.ok(install.ok, install.error ?? "plugin install failed");
  await first.dispose();

  const second = createMegaAgent({
    cwd: dir,
    workspaceStoreFile,
    adapter: new ScriptedRuntime((prompt) => prompt.includes("PERSISTED_PLUGIN_RULE")
      ? "persisted plugin reached prompt"
      : "persisted plugin missing"),
  });
  assert.deepEqual(second.workspace.ids(), ["persisted-planner"]);
  const result = await second.runTask({ prompt: "workspace persistence check" });
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.answer, "persisted plugin reached prompt");
  await second.dispose();
});

test("integration: interrupted idempotent tool operation recovers and finishes task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mega-operation-recovery-"));
  const files = {
    taskStoreFile: join(dir, "tasks.json"),
    recordFile: join(dir, "records.jsonl"),
  };
  let calls = 0;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const recoverTool = {
    name: "recover_echo",
    description: "recoverable echo operation",
    schemaChars: 160,
    idempotent: true,
    schema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      calls++;
      if (calls === 1) {
        started();
        return new Promise<never>(() => {});
      }
      return { recovered: true, calls };
    },
  };
  const script = (prompt: string) => {
    if (prompt.includes("[tool_result recover_echo]")) return "Recovered operation final answer";
    if (prompt.includes("[tool_result search_tools]")) return JSON.stringify({ tool: "recover_echo", args: {} });
    return JSON.stringify({ tool: "search_tools", args: { query: "recover" } });
  };
  const make = () => createMegaAgent({
    cwd: dir,
    adapter: new ScriptedRuntime(script),
    tools: [recoverTool],
    ...files,
  });

  const first = make();
  const abandoned = first.runTask({ prompt: "operation recovery check", maxToolIterations: 6 });
  void abandoned.catch(() => {});
  await startedPromise;

  const second = make();
  const summaries = second.snapshot().persistedTasks;
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].status, "waiting_recovery");
  assert.equal(summaries[0].resumable, true);

  const resumed = await second.resumeInterruptedTask(summaries[0].id);
  assert.equal(resumed.status, "completed");
  if (resumed.status !== "completed") assert.fail("expected recovered task completion");
  assert.equal(resumed.answer, "Recovered operation final answer");
  assert.deepEqual(resumed.toolsUsed, ["search_tools", "recover_echo"]);
  assert.equal(calls, 2);
  await second.dispose();
});

test("L2 runtime resolver: live LLM default and installed agent auto-detection", async () => {
  const { detectRuntimeInventory, resolveDefaultRuntime } = await import("../src/control/runtime-resolver.ts");
  const inv = await detectRuntimeInventory();
  assert.ok(Array.isArray(inv.installedAgents));
  assert.equal(typeof inv.localLiteRt.installed, "boolean");

  // Scripted fallback works explicitly
  const scripted = await resolveDefaultRuntime({ scripted: true });
  assert.equal(scripted.source, "scripted");
  assert.equal(scripted.adapter.id, "scripted");

  // Default resolution resolves a live runtime
  const live = await resolveDefaultRuntime();
  assert.ok(["installed-agent", "litert-lm", "scripted"].includes(live.source));
  assert.ok(typeof live.adapter.runTurn === "function");
});
