#!/usr/bin/env node
// Mega-Agent CLI. Every mode goes through MegaAgentSystem; the CLI does not
// assemble kernel, tools, approvals, crew, context, or surface pieces itself.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import {
  ScriptedRuntime,
  createMegaAgent,
  detectRuntimeInventory,
  resolveRuntimeFleet,
  type MegaTaskResult,
  type StrategyDef,
} from "./index.ts";

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefix = `${flag}=`;
  const match = process.argv.find((a) => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function parseAllArgs(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === flag && i + 1 < process.argv.length) values.push(process.argv[++i]);
    else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  }
  return values;
}

const hasFlag = (flag: string) => process.argv.includes(flag);

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`Mega-Agent CLI

Usage:
  node src/cli.ts                         Run the integrated system check
  node src/cli.ts --prompt "..."          Run one task through MegaAgentSystem
  node src/cli.ts --inventory             Inspect detected runtimes

Flags:
  --runtime <id>       litert-lm | claude | codex | grok | kimi | opencode | pi | scripted
  --model <id>         LiteRT-LM or agent model
  --local, --litert    Use native LiteRT-LM
  --scripted           Deterministic offline demo runtime
  --prompt <text>      Task prompt
  --context-file <p>   Attach file contents through the context store
  --record <path>      Shared record stream JSONL (default .mega-agent/records.jsonl)
  --task-store <path>  Durable task journal (default .mega-agent/tasks.json)
  --workspace <path>   Durable workspace plugins (default .mega-agent/workspace.json)
  --plugin <path>      Install a workspace plugin JS file; may repeat
  --strategy-file <p>  JSON StrategyDef or record of StrategyDefs
  --strategy <name>    Run registered strategy before root task turn
  --attention          List actionable attention routes from persisted state
  --state-dir <path>   Directory for approvals/tasks/records/workspace (default .mega-agent)
  --defer-approvals    Park approval-gated tools and exit; resolve in a later process
  --resolve-approval <id> --decision allow|deny [--by <name>]
                       Resolve a parked approval; a persisted task resumes to its final answer
  --resume-task <id>   Resume a task waiting for idempotent tool recovery
`);
  process.exit(0);
}

const inventory = await detectRuntimeInventory();

if (hasFlag("--inventory")) {
  console.log("=== Mega-Agent Runtime Inventory ===");
  console.log("Native On-Device Engine (LiteRT-LM):");
  console.log("  Installed:", inventory.localLiteRt.installed ? `yes (${inventory.localLiteRt.binary})` : "no");
  console.log("  Discovered Models:", inventory.localLiteRt.models.length ? inventory.localLiteRt.models.join(", ") : "none found in ~/.litert-lm/models");
  console.log("\nUser Installed Agent CLIs (via @botiverse/oar):");
  if (inventory.installedAgents.length === 0) console.log("  No external agent CLIs detected.");
  for (const a of inventory.installedAgents) {
    console.log(`  • ${a.id}: ${a.version ?? a.via ?? "available"}${a.command ? ` (${a.command})` : ""}`);
  }
  process.exit(0);
}

const preferred = parseArg("--runtime") ?? (hasFlag("--local") || hasFlag("--litert") ? "litert-lm" : undefined);
const model = parseArg("--model");
const scripted = hasFlag("--scripted");
const {
  adapter: resolvedAdapter,
  source,
  additionalRuntimes,
} = await resolveRuntimeFleet({ preferred, model, scripted });

function createScriptedDemoAdapter(): ScriptedRuntime {
  return new ScriptedRuntime((prompt) => {
    if (prompt === "integrated-crew-check") return "crew verification passed";
    if (prompt.includes("[tool_result ask_human]")) return "Integrated system check passed: context, crew, code result 42, and simulated operator input all reached the final answer.";
    if (prompt.includes("[tool_result run_code]")) return JSON.stringify({ tool: "ask_human", args: { prompt: "Confirm the integrated system result" } });
    if (prompt.includes("[tool_result delegate]")) return JSON.stringify({ tool: "run_code", args: { code: "return 40 + 2;" } });
    if (prompt.includes("[tool_result search_tools]")) return JSON.stringify({ tool: "delegate", args: { runtime: "scripted", task: "integrated-crew-check", label: "crew" } });
    if (prompt.includes("[tool_result expand_context]")) return JSON.stringify({ tool: "search_tools", args: { query: "delegate code human" } });
    const handle = prompt.match(/ccr:\d+/)?.[0];
    if (handle && prompt.includes("Run an integrated system check")) {
      return JSON.stringify({ tool: "expand_context", args: { handle } });
    }
    const task = prompt.split("\nTask:\n").at(-1)?.trim() || prompt;
    return `scripted answer to: ${task}`;
  });
}

const adapter = scripted ? createScriptedDemoAdapter() : resolvedAdapter;
console.log(`[mega-agent] Active engine: ${adapter.id} (source: ${source})`);
if (inventory.localLiteRt.installed) {
  console.log(`[mega-agent] LiteRT-LM native engine ready: ${inventory.localLiteRt.models.length} local model(s) available`);
}
if (inventory.installedAgents.length > 0) {
  console.log(`[mega-agent] Installed agents available: ${inventory.installedAgents.map((a) => a.id).join(", ")}`);
}
if (additionalRuntimes.size > 0) {
  console.log(`[mega-agent] Crew runtimes provisioned: default, ${[...additionalRuntimes.keys()].join(", ")}`);
}

function loadStrategies(): Record<string, StrategyDef> {
  const file = parseArg("--strategy-file");
  if (!file) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`strategy file must contain a StrategyDef or a record of StrategyDefs: ${file}`);
  }
  const record = parsed as Record<string, unknown>;
  const entries = "agents" in record && "flow" in record
    ? [[String(record.name ?? "strategy"), record] as const]
    : Object.entries(record);
  const strategies: Record<string, StrategyDef> = {};
  for (const [name, value] of entries) {
    const def = value as Partial<StrategyDef>;
    if (!def || typeof def !== "object" || !def.agents || !def.flow) {
      throw new Error(`invalid StrategyDef for '${name}' in ${file}`);
    }
    strategies[name] = { ...def, name: def.name ?? name } as StrategyDef;
  }
  return strategies;
}

let readline: Interface | undefined;
function getReadline(): Interface {
  readline ??= createInterface({ input: process.stdin, output: process.stdout });
  return readline;
}

const humanAsk = scripted
  ? async (prompt: string) => `simulated operator response to: ${prompt}`
  : process.stdin.isTTY
    ? async (prompt: string) => getReadline().question(`\nHuman input requested: ${prompt}\n> `)
    : undefined;

const stateDir = parseArg("--state-dir") ?? join(process.cwd(), ".mega-agent");
const mega = createMegaAgent({
  cwd: process.cwd(),
  adapter,
  additionalRuntimes,
  sessionOptions: model ? { model } : {},
  humanAsk,
  strategies: loadStrategies(),
  approvalStoreFile: join(stateDir, "approvals.json"),
  recordFile: parseArg("--record") ?? join(stateDir, "records.jsonl"),
  taskStoreFile: parseArg("--task-store") ?? join(stateDir, "tasks.json"),
  workspaceStoreFile: parseArg("--workspace") ?? join(stateDir, "workspace.json"),
});

async function settle(result: MegaTaskResult): Promise<MegaTaskResult> {
  let current = result;
  while (current.status === "waiting_approval") {
    console.log(`\nApproval needed before tool "${current.tool}" can run.`);
    if (current.attentionRoute) console.log(`Attention route: ${current.attentionRoute}`);

    if (hasFlag("--defer-approvals")) {
      console.log("Approval deferred. The durable task can be resumed by a later process; the tool has not run.");
      return current;
    }

    if (scripted) {
      console.log("Scripted demo operator: allowing the tool for this offline demonstration.");
      current = await mega.resolveApproval(current.approvalId, "allow", "scripted-demo-operator");
      continue;
    }

    if (!process.stdin.isTTY) {
      console.log("No interactive terminal is available, so the task remains parked. The tool has not run.");
      return current;
    }

    const answer = (await getReadline().question("Allow? [y/N] ")).trim().toLowerCase();
    current = await mega.resolveApproval(
      current.approvalId,
      answer === "y" || answer === "yes" ? "allow" : "deny",
      "cli-operator",
    );
  }
  return current;
}

function printResult(result: MegaTaskResult): void {
  if (result.status === "completed") {
    console.log(`\n${result.answer}\n`);
    console.log(`Tools used: ${result.toolsUsed.join(", ") || "none"}`);
    console.log(`Context saved by handle: ${result.contextSavedChars} chars`);
  } else if (result.status === "waiting_approval") {
    console.log(`Task ${result.taskId} is waiting for approval ${result.approvalId}.`);
    process.exitCode = 2;
  } else {
    console.log(`Tool ${result.tool} completed with decision ${result.decision}: ${JSON.stringify(result.result)}`);
  }

  const snapshot = mega.snapshot();
  console.log(`Records in shared stream: ${snapshot.recordCount}`);
  console.log(`Persisted tasks: ${snapshot.persistedTasks.map((t) => `${t.id}:${t.status}`).join(", ") || "none"}`);
  console.log(`Workspace revision: ${snapshot.workspaceRevision} | Plugins: ${snapshot.pluginIds.join(", ") || "none"}`);
  console.log(`View: ${JSON.stringify(snapshot.view)}`);
}

try {
  if (hasFlag("--attention")) {
    const snapshot = mega.snapshot();
    if (snapshot.attention.length === 0) {
      console.log("No actionable attention items.");
    }
    for (const item of snapshot.attention) {
      console.log(`${mega.attention.route(item)} | ${item.reason}${item.approvalId ? ` | approval: ${item.approvalId}` : ""}${item.requestId ? ` | request: ${item.requestId}` : ""}`);
      if (item.approvalId) {
        console.log(`Resolve with: node src/cli.ts --state-dir ${stateDir} --resolve-approval ${item.approvalId} --decision allow|deny`);
      }
    }
    console.log(`Persisted tasks: ${snapshot.persistedTasks.map((t) => `${t.id}:${t.status}${t.resumable ? ":resumable" : ""}`).join(", ") || "none"}`);
  }

  const pluginPaths = parseAllArgs("--plugin");
  for (const pluginPath of pluginPaths) {
    const id = basename(pluginPath).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-");
    const install = await mega.installPlugin({ id, source: readFileSync(pluginPath, "utf8") });
    if (!install.ok) throw new Error(`plugin ${pluginPath} failed to activate: ${install.error ?? "unknown error"}`);
    console.log(`[mega-agent] Workspace plugin installed: ${id} (revision ${install.revision})`);
  }

  const resumeTaskId = hasFlag("--attention") ? undefined : parseArg("--resume-task");
  if (resumeTaskId) {
    const result = await settle(await mega.resumeInterruptedTask(resumeTaskId));
    printResult(result);
  }

  const approvalId = hasFlag("--attention") || resumeTaskId ? undefined : parseArg("--resolve-approval");
  if (approvalId) {
    const decision = parseArg("--decision");
    if (decision !== "allow" && decision !== "deny") throw new Error("--resolve-approval requires --decision allow or --decision deny");
    const result = await settle(await mega.resolveApproval(approvalId, decision, parseArg("--by") ?? "cli-operator"));
    printResult(result);
  }

  const promptArg = approvalId || resumeTaskId || hasFlag("--attention") ? undefined : parseArg("--prompt");
  const contextFile = parseArg("--context-file");
  const attachedContext = contextFile ? readFileSync(contextFile, "utf8") : undefined;

  if (!approvalId && !resumeTaskId && !hasFlag("--attention") && promptArg) {
    const result = await settle(await mega.runTask({
      prompt: promptArg,
      context: attachedContext,
      strategy: parseArg("--strategy"),
    }));
    printResult(result);
  } else if (!approvalId && !resumeTaskId && !hasFlag("--attention")) {
    const install = pluginPaths.length === 0 && mega.workspace.ids().length === 0 ? await mega.installPlugin({
      id: "integrated-check-planner",
      source: `globalThis.__plugin = async () => {
        const found = await cap("search_tools", "context");
        return {
          instructions: ["Use stored material, independent verification, a computed check, and human review. Plugin found: " + found.join(",")],
          toolQuery: "context",
        };
      };`,
    }) : { ok: true, revision: mega.workspace.revision, changed: [] as string[], error: undefined, rolledBack: false };
    if (!install.ok) throw new Error(`integrated-check plugin failed to activate: ${install.error ?? "unknown error"}`);

    const result = await settle(await mega.runTask({
      prompt: "Run an integrated system check. Use stored material, independent verification, a computed check, and human review before the final verdict.",
      context: attachedContext ?? `DEMO_EVIDENCE: ${"connected layer evidence ".repeat(80)}`,
      maxToolIterations: 10,
    }));
    printResult(result);
  }
} finally {
  readline?.close();
  await mega.dispose();
}
