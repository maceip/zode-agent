// Composition root: the one object that wires every layer together.
//
// Data flow for every task:
//   user -> RecordStream -> MegaSession/RuntimeAdapter -> Agent
//        -> ToolBroker -> ApprovalGate -> Crew/Context/Human/Isolate/custom tools
//        -> RecordStream -> model-visible tool_result -> next model turn
// Workspace plugins run in the isolate before the first turn and affect the
// prompt and deferred-tool selection. AttentionIndex reads the same stream.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RecordStream, deriveMessages, viewOf, type ConversationView } from "../kernel/record-stream.ts";
import { MegaSession, type RuntimeAdapter, type SessionOptions } from "../control/runtime.ts";
import {
  buildStrategy,
  createAgent,
  createHumanAgent,
  type Agent,
  type StrategyDef,
} from "../composition/agent.ts";
import {
  BudgetHook,
  CacheHook,
  ReturnTypeHook,
  runSpan,
  type Effect,
  type Hook,
  type Span,
} from "../effects/spans.ts";
import {
  ApprovalGate,
  ParkedApprovalError,
  type Answerer,
  type ApprovalRequest,
} from "../decision/approvals.ts";
import { Crew, formatReport, type CrewReport } from "../crew/crew.ts";
import { ContextStore, DeferredToolRegistry, type ToolDef } from "../economics/context.ts";
import { runInIsolate } from "../substrate/isolate.ts";
import { WorkspaceProgram, type PluginModule, type ReloadResult } from "../surface/workspace.ts";
import { AttentionIndex, type AttentionItem } from "../surface/attention.ts";

export interface MegaToolContext {
  system: MegaAgentSystem;
  stream: RecordStream;
  agentPath: readonly string[];
  taskId?: string;
  loadTools(names: readonly string[]): void;
  loadedTools(): string[];
}

export interface MegaTool extends ToolDef {
  execute(args: Record<string, unknown>, context: MegaToolContext): Promise<unknown> | unknown;
}

export interface MegaAgentSystemOptions {
  cwd?: string;
  adapter: RuntimeAdapter;
  additionalRuntimes?: Map<string, RuntimeAdapter>;
  sessionOptions?: Omit<SessionOptions, "cwd"> & { cwd?: string };
  stream?: RecordStream;
  recordFile?: string;
  taskStoreFile?: string;
  workspaceStoreFile?: string;
  strategies?: Readonly<Record<string, StrategyDef>>;
  humanAsk?: (prompt: string) => Promise<string>;
  answerers?: Answerer[];
  approvalStoreFile?: string;
  hooks?: Hook[];
  budgetTokens?: number;
  contextThresholdChars?: number;
  maxToolIterations?: number;
  maxToolResultChars?: number;
  tools?: MegaTool[];
  codeCapabilities?: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>;
  crewMaxRunning?: number;
}

export interface MegaTaskRequest {
  prompt: string;
  context?: string;
  maxToolIterations?: number;
  initialToolQuery?: string;
  strategy?: string | StrategyDef;
  strategyInput?: string;
}

export type MegaTaskResult =
  | {
      status: "completed";
      taskId: string;
      sessionId: string;
      answer: string;
      toolsUsed: string[];
      contextHandle?: string;
      contextSavedChars: number;
      view: ConversationView;
    }
  | {
      status: "waiting_approval";
      taskId: string;
      sessionId: string;
      approvalId: string;
      tool: string;
      attentionRoute?: string;
      toolsUsed: string[];
    }
  | {
      status: "tool_completed";
      approvalId: string;
      decision: "allow" | "deny";
      tool: string;
      result: unknown;
    };

interface PendingTool {
  approvalId: string;
  tool: string;
  args: Record<string, unknown>;
  agentPath: readonly string[];
  taskId?: string;
  operationId?: string;
}

type TaskStatus = "running" | "waiting_approval" | "waiting_recovery" | "failed" | "interrupted";

export type PersistedTaskOperation =
  | { kind: "model"; operationId: string }
  | {
      kind: "tool";
      operationId: string;
      tool: string;
      args: Record<string, unknown>;
      agentPath: readonly string[];
    };

interface TaskState {
  id: string;
  status: TaskStatus;
  request: MegaTaskRequest;
  loadedTools: Set<string>;
  toolsUsed: string[];
  iterations: number;
  maxIterations: number;
  contextHandle?: string;
  contextInline: string;
  contextSavedChars: number;
  pendingApprovalId?: string;
  restoredFromStore?: boolean;
  missingHostTools: string[];
  activeOperation?: PersistedTaskOperation;
  recoveryObservation?: string;
}

export interface MegaHostManifest {
  adapterId: string;
  runtimeIds: string[];
  toolNames: string[];
  strategyNames: string[];
  pluginIds: string[];
  codeCapabilityNames: string[];
  hasHumanAsk: boolean;
  answererCount: number;
}

export interface PersistedMegaTask {
  id: string;
  status: TaskStatus;
  request: Omit<MegaTaskRequest, "context">;
  contextText?: string;
  loadedTools: string[];
  toolsUsed: string[];
  iterations: number;
  maxIterations: number;
  contextHandle?: string;
  contextInline: string;
  contextSavedChars: number;
  pendingApprovalId?: string;
  activeOperation?: PersistedTaskOperation;
  hostManifest?: MegaHostManifest;
  error?: string;
}

interface PersistedTaskStore {
  version: 1;
  tasks: PersistedMegaTask[];
  strategies?: Record<string, StrategyDef>;
}

export interface MegaTaskSummary {
  id: string;
  status: TaskStatus;
  prompt: string;
  pendingApprovalId?: string;
  resumable: boolean;
  missingHostTools: string[];
  hostManifest?: MegaHostManifest;
}

interface PluginOutput {
  instructions: string[];
  toolQuery?: string;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} chars omitted]`;
}

export class MegaAgentSystem {
  readonly stream: RecordStream;
  readonly session: MegaSession;
  readonly rootAgent: Agent;
  readonly approvalGate: ApprovalGate;
  readonly attention: AttentionIndex;
  readonly contextStore: ContextStore;
  readonly toolRegistry: DeferredToolRegistry;
  readonly crew: Crew;
  readonly workspace: WorkspaceProgram;

  readonly #options: MegaAgentSystemOptions;
  readonly #cwd: string;
  readonly #tools = new Map<string, MegaTool>();
  readonly #strategies = new Map<string, StrategyDef>();
  #operationTail: Promise<void> = Promise.resolve();
  #activeTaskId?: string;
  #hostToolsBound = false;
  readonly #budgetHook: BudgetHook;
  readonly #cacheHook = new CacheHook();
  readonly #pendingByApproval = new Map<string, PendingTool>();
  readonly #tasks = new Map<string, TaskState>();
  readonly #persistedTasks = new Map<string, PersistedMegaTask>();
  readonly #humanAgent?: Agent;
  #taskSequence = 0;
  #suppressCrewWake = false;

  constructor(options: MegaAgentSystemOptions) {
    this.#options = options;
    this.#cwd = options.cwd ?? options.sessionOptions?.cwd ?? process.cwd();
    this.stream = options.stream ?? new RecordStream(options.recordFile);

    this.session = new MegaSession(
      options.adapter,
      { cwd: this.#cwd, ...options.sessionOptions },
      [],
      { stream: this.stream },
    );
    this.rootAgent = createAgent("root", this.session);
    this.approvalGate = new ApprovalGate(this.stream, options.answerers ?? [], options.approvalStoreFile);
    this.attention = new AttentionIndex();
    this.attention.watch(this.session.id, this.stream);
    this.contextStore = new ContextStore(options.contextThresholdChars ?? 2_000);
    this.toolRegistry = new DeferredToolRegistry();
    this.workspace = new WorkspaceProgram();
    this.#loadWorkspace();
    this.#budgetHook = new BudgetHook(options.budgetTokens ?? 200_000);
    this.#humanAgent = options.humanAsk ? createHumanAgent("human", options.humanAsk) : undefined;
    for (const [name, strategy] of Object.entries(options.strategies ?? {})) {
      this.#strategies.set(name, strategy);
    }

    const runtimes = new Map<string, RuntimeAdapter>();
    runtimes.set("default", options.adapter);
    runtimes.set(options.adapter.id, options.adapter);
    for (const [id, runtime] of options.additionalRuntimes ?? []) runtimes.set(id, runtime);
    this.crew = new Crew(runtimes, options.crewMaxRunning ?? 4, {
      cwd: this.#cwd,
      stream: this.stream,
      parentPath: [],
      sessionOptions: options.sessionOptions,
    });
    this.crew.onReport((report) => this.#onCrewReport(report));

    this.#registerBuiltInTools();
    for (const tool of options.tools ?? []) this.registerTool(tool);
    this.#bindRuntimeHostTools();
    this.#loadPersistedTasks();
    for (const parked of this.approvalGate.parked()) this.#rehydrateParkedTool(parked);
  }

  registerTool(tool: MegaTool): void {
    this.#tools.set(tool.name, tool);
    this.toolRegistry.register(tool);
    if (this.#hostToolsBound) this.#bindRuntimeHostTools();
  }

  registerStrategy(definition: StrategyDef, name = definition.name): void {
    this.#strategies.set(name, definition);
    this.#writeTaskStore();
  }

  strategyNames(): string[] { return [...this.#strategies.keys()]; }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#operationTail.then(operation, operation);
    this.#operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  #allAdapters(): Set<RuntimeAdapter> {
    return new Set<RuntimeAdapter>([
      this.#options.adapter,
      ...(this.#options.additionalRuntimes?.values() ?? []),
    ]);
  }

  #bindRuntimeHostTools(): void {
    this.#hostToolsBound = true;
    for (const adapter of this.#allAdapters()) {
      if (!adapter.bindHostTools) continue;
      try {
        const bindingResult = adapter.bindHostTools({
          name: "mega-agent",
          instructions: "Mega-agent host tools. Approval-gated tools may return an approval-parked error.",
          listTools: () => [...this.#tools.values()]
            .filter((tool) => tool.name !== "search_tools")
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.schema ?? { type: "object", properties: {} },
            })),
          call: async (tool, args) => {
            const execution = await this.#executeToolUnlocked(tool, args, {
              agentPath: [],
              taskId: this.#activeTaskId,
            });
            if (execution.status === "parked") {
              throw new Error(`approval parked: ${execution.approvalId}`);
            }
            return execution.result;
          },
        });
        void Promise.resolve(bindingResult).catch((error: unknown) => {
          this.stream.append("raw", [], {
            modelVisible: false,
            data: {
              kind: "host_tools_bind_failed",
              adapter: adapter.id,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        });
      } catch (error) {
        this.stream.append("raw", [], {
          modelVisible: false,
          data: {
            kind: "host_tools_bind_failed",
            adapter: adapter.id,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  #registerBuiltInTools(): void {
    this.registerTool({
      name: "search_tools",
      idempotent: true,
      description: "search deferred tool registry and load matching tool schemas",
      schemaChars: 180,
      schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: (args, ctx) => {
        const matches = this.toolRegistry.search(String(args.query ?? ""));
        ctx.loadTools(matches.map((tool) => tool.name));
        return { loaded: matches.map((tool) => tool.name), schemas: matches.map((tool) => JSON.parse(this.toolRegistry.schemaForPrompt(tool))) };
      },
    });

    this.registerTool({
      name: "expand_context",
      idempotent: true,
      description: "expand stored context handle or large report context on demand",
      schemaChars: 180,
      schema: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"] },
      execute: (args) => this.contextStore.expand(String(args.handle ?? "")),
    });

    const crewRuntimeIds = [...this.crew.runtimes.keys()];
    this.registerTool({
      name: "delegate",
      description: `delegate subtask to crew runtime agent and return report; available runtimes: ${crewRuntimeIds.join(", ")}`,
      schemaChars: 260,
      schema: {
        type: "object",
        properties: {
          task: { type: "string" },
          runtime: { type: "string", enum: crewRuntimeIds },
          label: { type: "string" },
        },
        required: ["task"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const runtime = String(args.runtime ?? "default");
        const label = String(args.label ?? runtime.replace(/[^a-z0-9_-]+/gi, "-"));
        this.#suppressCrewWake = true;
        try {
          return formatReport(await this.crew.spawn(runtime, String(args.task ?? ""), label));
        } finally {
          this.#suppressCrewWake = false;
        }
      },
    });

    this.registerTool({
      name: "run_code",
      description: "execute JavaScript code in isolated jailed child process",
      schemaChars: 240,
      requiresApproval: true,
      schema: { type: "object", properties: { code: { type: "string" }, timeoutMs: { type: "number" } }, required: ["code"] },
      execute: async (args) => {
        const result = await runInIsolate(String(args.code ?? ""), {
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
          capabilities: {
            expand_context: (handle: unknown) => this.contextStore.expand(String(handle)),
            ...(this.#options.codeCapabilities ?? {}),
          },
        });
        return { value: result.value, logs: result.logs, jail: result.jail };
      },
    });

    if (this.#humanAgent) {
      const human = this.#humanAgent;
      this.registerTool({
        name: "ask_human",
        description: "ask human reviewer for input or judgment",
        schemaChars: 180,
        schema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
        execute: (args) => human.call(String(args.prompt ?? ""), this.#hooks([])),
      });
    }

    this.registerTool({
      name: "run_strategy",
      description: "run a registered declarative multi-agent strategy by name",
      schemaChars: 220,
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          input: { type: "string" },
        },
        required: ["name", "input"],
        additionalProperties: false,
      },
      execute: (args) => {
        const name = String(args.name ?? "");
        const definition = this.#strategies.get(name);
        if (!definition) {
          throw new Error(`unknown strategy: ${name || "(empty)"}; registered: ${this.strategyNames().join(", ") || "none"}`);
        }
        return this.#runStrategyUnlocked(definition, String(args.input ?? ""));
      },
    });
  }

  #onCrewReport(report: CrewReport): void {
    if (this.#suppressCrewWake) return;
    const result = this.session.deliver(formatReport(report));
    if (result.kind === "rejected" && result.code === "no_active_turn") {
      this.stream.append("crew_report", this.session.agentPath, { text: formatReport(report) });
    }
  }

  #loadWorkspace(): void {
    const file = this.#options.workspaceStoreFile;
    if (!file || !existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { revision: number; modules: PluginModule[] };
      this.workspace.restore(parsed);
    } catch (error) {
      throw new Error(`cannot load mega-agent workspace store ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #persistWorkspace(): void {
    const file = this.#options.workspaceStoreFile;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(this.workspace.snapshot(), null, 2) + "\n");
    renameSync(temp, file);
  }

  #rehydrateParkedTool(request: ApprovalRequest): void {
    const data = request.data as { args?: Record<string, unknown>; taskId?: string; operationId?: string } | undefined;
    if (!data?.args || typeof data.args !== "object") return;
    this.#pendingByApproval.set(request.id, {
      approvalId: request.id,
      tool: request.tool,
      args: data.args,
      agentPath: request.agentPath,
      taskId: data.taskId,
      operationId: data.operationId,
    });
  }

  #serializeTask(state: TaskState, error?: string): PersistedMegaTask {
    const { context: _context, ...request } = state.request;
    return {
      id: state.id,
      status: state.status,
      request,
      contextText: state.request.context,
      loadedTools: [...state.loadedTools],
      toolsUsed: [...state.toolsUsed],
      iterations: state.iterations,
      maxIterations: state.maxIterations,
      contextHandle: state.contextHandle,
      contextInline: state.contextInline,
      contextSavedChars: state.contextSavedChars,
      pendingApprovalId: state.pendingApprovalId,
      activeOperation: state.activeOperation,
      hostManifest: this.#hostManifest(),
      error,
    };
  }

  #hostManifest(): MegaHostManifest {
    return {
      adapterId: this.#options.adapter.id,
      runtimeIds: [...this.crew.runtimes.keys()],
      toolNames: [...this.#tools.keys()],
      strategyNames: this.strategyNames(),
      pluginIds: this.workspace.ids(),
      codeCapabilityNames: Object.keys(this.#options.codeCapabilities ?? {}),
      hasHumanAsk: this.#options.humanAsk !== undefined,
      answererCount: this.#options.answerers?.length ?? 0,
    };
  }

  #persistTask(state: TaskState, error?: string): void {
    this.#persistedTasks.set(state.id, this.#serializeTask(state, error));
    this.#writeTaskStore();
  }

  #removePersistedTask(taskId: string): void {
    if (!this.#persistedTasks.delete(taskId)) return;
    this.#writeTaskStore();
  }

  #writeTaskStore(): void {
    const file = this.#options.taskStoreFile;
    if (!file) return;
    const store: PersistedTaskStore = {
      version: 1,
      tasks: [...this.#persistedTasks.values()],
      strategies: Object.fromEntries(this.#strategies),
    };
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(store, null, 2) + "\n");
    renameSync(temp, file);
  }

  #loadPersistedTasks(): void {
    // New task IDs must not collide with IDs already present in a reused record file.
    for (const record of this.stream.records) {
      const taskId = (record.data as { taskId?: unknown } | undefined)?.taskId;
      if (typeof taskId === "string") this.#observeTaskId(taskId);
    }

    const file = this.#options.taskStoreFile;
    if (!file || !existsSync(file)) return;

    let parsed: PersistedTaskStore;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as PersistedTaskStore;
    } catch (error) {
      throw new Error(`cannot load mega-agent task store ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
      throw new Error(`unsupported mega-agent task store format in ${file}`);
    }

    for (const [name, definition] of Object.entries(parsed.strategies ?? {})) {
      if (!this.#strategies.has(name)) this.#strategies.set(name, definition);
    }

    const parkedApprovalIds = new Set(this.approvalGate.parked().map((request) => request.id));
    let changed = false;

    for (const persisted of parsed.tasks) {
      this.#observeTaskId(persisted.id);
      let stored = persisted;

      if (persisted.status === "running" || persisted.status === "waiting_recovery") {
        const operation = persisted.activeOperation;
        const completedToolRecord = operation?.kind === "tool"
          ? [...this.stream.records].reverse().find((record) =>
              record.kind === "tool_result"
              && (record.data as { operationId?: unknown } | undefined)?.operationId === operation.operationId)
          : undefined;
        const tool = operation?.kind === "tool" ? this.#tools.get(operation.tool) : undefined;

        if (operation?.kind === "tool" && (completedToolRecord || tool?.idempotent)) {
          stored = { ...persisted, status: "waiting_recovery", pendingApprovalId: undefined };
          if (stored.contextHandle && stored.contextText !== undefined) {
            this.contextStore.restoreEntry(stored.contextHandle, stored.contextText);
          }
          this.#tasks.set(stored.id, {
            id: stored.id,
            status: "waiting_recovery",
            request: { ...stored.request, context: stored.contextText },
            loadedTools: new Set(stored.loadedTools),
            toolsUsed: [...stored.toolsUsed],
            iterations: stored.iterations,
            maxIterations: stored.maxIterations,
            contextHandle: stored.contextHandle,
            contextInline: stored.contextInline,
            contextSavedChars: stored.contextSavedChars,
            restoredFromStore: true,
            missingHostTools: stored.loadedTools.filter((name) => !this.#tools.has(name)),
            activeOperation: operation,
            recoveryObservation: completedToolRecord?.text,
          });
        } else {
          // A model call or non-idempotent tool may already have caused side
          // effects. Mark the task interrupted rather than replaying the call.
          stored = {
            ...persisted,
            status: "interrupted",
            pendingApprovalId: undefined,
            error: operation?.kind === "tool"
              ? `interrupted during non-idempotent tool ${operation.tool}; not replayed`
              : "interrupted during an active model/tool call; not replayed",
          };
        }
        changed = true;
      }

      if (stored.status === "waiting_approval") {
        if (!stored.pendingApprovalId || !parkedApprovalIds.has(stored.pendingApprovalId)) {
          stored = {
            ...stored,
            status: "interrupted",
            error: "parked approval no longer exists; task cannot be resumed safely",
          };
          changed = true;
        } else {
          if (stored.contextHandle && stored.contextText !== undefined) {
            this.contextStore.restoreEntry(stored.contextHandle, stored.contextText);
          }
          const state: TaskState = {
            id: stored.id,
            status: "waiting_approval",
            request: { ...stored.request, context: stored.contextText },
            loadedTools: new Set(stored.loadedTools),
            toolsUsed: [...stored.toolsUsed],
            iterations: stored.iterations,
            maxIterations: stored.maxIterations,
            contextHandle: stored.contextHandle,
            contextInline: stored.contextInline,
            contextSavedChars: stored.contextSavedChars,
            pendingApprovalId: stored.pendingApprovalId,
            restoredFromStore: true,
            missingHostTools: stored.loadedTools.filter((tool) => !this.#tools.has(tool)),
            activeOperation: stored.activeOperation,
          };
          this.#tasks.set(state.id, state);
        }
      }

      this.#persistedTasks.set(stored.id, stored);
    }

    if (changed) this.#writeTaskStore();
  }

  #observeTaskId(taskId: string): void {
    const suffix = /^task-(\d+)$/.exec(taskId)?.[1];
    if (suffix) this.#taskSequence = Math.max(this.#taskSequence, Number(suffix));
  }

  persistedTasks(): PersistedMegaTask[] {
    // Refresh entries for active tasks before reporting journal state.
    for (const state of this.#tasks.values()) {
      this.#persistedTasks.set(state.id, this.#serializeTask(state));
    }
    return [...this.#persistedTasks.values()].map((task) => ({ ...task, loadedTools: [...task.loadedTools], toolsUsed: [...task.toolsUsed] }));
  }

  #recordHook(agentPath: readonly string[]): Hook {
    return {
      enter: (span: Span): Effect => {
        this.stream.append("span", agentPath, {
          modelVisible: false,
          data: { phase: "enter", kind: span.kind, name: span.name },
        });
        return undefined;
      },
      complete: (span: Span): Effect => {
        this.stream.append("span", agentPath, {
          modelVisible: false,
          data: { phase: "complete", kind: span.kind, name: span.name },
        });
        return undefined;
      },
      exit: (span: Span, error?: unknown) => {
        this.stream.append("span", agentPath, {
          modelVisible: false,
          data: { phase: "exit", kind: span.kind, name: span.name, error: error instanceof Error ? error.message : undefined },
        });
      },
    };
  }

  #hooks(agentPath: readonly string[], enableCache = false): Hook[] {
    // Cache is deliberately off for model turns: supplying a cached answer there
    // would skip MegaSession and break the shared model-visible record stream.
    // Tool/plugin spans are safe to cache because the broker/plugin runner still
    // records the resulting tool/plugin output in the same stream.
    return [
      this.#recordHook(agentPath),
      this.#budgetHook,
      ...(enableCache ? [this.#cacheHook] : []),
      ...(this.#options.hooks ?? []),
    ];
  }

  #modelHooks(agentPath: readonly string[]): Hook[] {
    return [...this.#hooks(agentPath), new ReturnTypeHook((value) => typeof value === "string", "string")];
  }

  executeTool(
    name: string,
    args: Record<string, unknown> = {},
    options: { agentPath?: readonly string[]; taskId?: string; loadedTools?: ReadonlySet<string> } = {},
  ): Promise<
    | { status: "completed"; tool: string; result: unknown; text: string }
    | { status: "parked"; tool: string; approvalId: string }
  > {
    return this.#serialized(() => this.#executeToolUnlocked(name, args, options));
  }

  async #executeToolUnlocked(
    name: string,
    args: Record<string, unknown> = {},
    options: { agentPath?: readonly string[]; taskId?: string; loadedTools?: ReadonlySet<string> } = {},
  ): Promise<
    | { status: "completed"; tool: string; result: unknown; text: string }
    | { status: "parked"; tool: string; approvalId: string }
  > {
    const agentPath = options.agentPath ?? [];
    const taskState = options.taskId ? this.#tasks.get(options.taskId) : undefined;
    const operationId = taskState
      ? `${taskState.id}:tool:${taskState.iterations}:${taskState.toolsUsed.length}:${name}`
      : undefined;
    const tool = this.#tools.get(name);
    if (!tool) {
      return this.#toolError(name, agentPath, new Error(`unknown tool: ${name}`));
    }
    if (name !== "search_tools" && options.loadedTools && !options.loadedTools.has(name)) {
      return this.#toolError(name, agentPath, new Error(`tool is not loaded; call search_tools first: ${name}`));
    }

    this.stream.append("tool_call", agentPath, {
      tool: name,
      modelVisible: false,
      data: { taskId: options.taskId, args, operationId },
    });

    const validationErrors = validateToolArgs(tool, args);
    if (validationErrors.length) {
      return this.#toolError(
        name,
        agentPath,
        new Error(`invalid tool arguments: ${validationErrors.join("; ")}`),
        options.taskId,
        operationId,
      );
    }

    if (tool.requiresApproval) {
      try {
        const answer = await this.approvalGate.request({
          tool: name,
          summary: truncate(`${name} ${JSON.stringify(args)}`, 500),
          agentPath,
          data: { taskId: options.taskId, args, operationId },
        });
        if (answer.decision === "deny") {
          const text = `[tool_result ${name}]\nTool execution denied by ${answer.by}.`;
          this.stream.append("tool_result", agentPath, { tool: name, text, data: { taskId: options.taskId, operationId } });
          return { status: "completed", tool: name, result: { denied: true, by: answer.by }, text };
        }
      } catch (error) {
        if (error instanceof ParkedApprovalError) {
          this.#pendingByApproval.set(error.id, {
            approvalId: error.id,
            tool: name,
            args,
            agentPath,
            taskId: options.taskId,
            operationId,
          });
          const state = options.taskId ? this.#tasks.get(options.taskId) : undefined;
          if (state) {
            state.status = "waiting_approval";
            state.pendingApprovalId = error.id;
            this.#persistTask(state);
          }
          return { status: "parked", tool: name, approvalId: error.id };
        }
        throw error;
      }
    }

    return this.#invokeTool(tool, args, agentPath, options.taskId, operationId);
  }

  async #invokeTool(
    tool: MegaTool,
    args: Record<string, unknown>,
    agentPath: readonly string[],
    taskId?: string,
    operationId?: string,
  ): Promise<{ status: "completed"; tool: string; result: unknown; text: string }> {
    const state = taskId ? this.#tasks.get(taskId) : undefined;
    const effectiveOperationId = operationId ?? (state ? `${state.id}:tool:${state.iterations}:${state.toolsUsed.length}:${tool.name}` : undefined);
    if (state && effectiveOperationId) {
      state.activeOperation = {
        kind: "tool",
        operationId: effectiveOperationId,
        tool: tool.name,
        args,
        agentPath,
      };
      this.#persistTask(state);
    }
    try {
      const result = await runSpan<unknown>(
        { kind: tool.name === "run_code" ? "exec" : "invoke", name: `tool:${tool.name}`, input: args },
        async (input) => tool.execute(input as Record<string, unknown>, {
          system: this,
          stream: this.stream,
          agentPath,
          taskId,
          loadTools: (names) => {
            const state = taskId ? this.#tasks.get(taskId) : undefined;
            if (state) {
              for (const name of names) state.loadedTools.add(name);
              this.#persistTask(state);
            }
          },
          loadedTools: () => [...(taskId ? this.#tasks.get(taskId)?.loadedTools ?? [] : [])],
        }),
        this.#hooks(agentPath, true),
      );
      const text = `[tool_result ${tool.name}]\n${truncate(asText(result), this.#options.maxToolResultChars ?? 20_000)}`;
      this.stream.append("tool_result", agentPath, { tool: tool.name, text, data: { taskId, operationId: effectiveOperationId } });
      if (state && state.activeOperation?.operationId === effectiveOperationId) {
        state.activeOperation = undefined;
        this.#persistTask(state);
      }
      return { status: "completed", tool: tool.name, result, text };
    } catch (error) {
      const failure = this.#toolError(tool.name, agentPath, error, taskId, effectiveOperationId);
      if (state && state.activeOperation?.operationId === effectiveOperationId) {
        state.activeOperation = undefined;
        this.#persistTask(state);
      }
      return failure;
    }
  }

  #toolError(
    name: string,
    agentPath: readonly string[],
    error: unknown,
    taskId?: string,
    operationId?: string,
  ): { status: "completed"; tool: string; result: unknown; text: string } {
    const message = error instanceof Error ? error.message : String(error);
    const text = `[tool_result ${name}]\nError: ${message}`;
    this.stream.append("tool_result", agentPath, { tool: name, text, data: { taskId, operationId, error: message } });
    return { status: "completed", tool: name, result: { error: message }, text };
  }

  installPlugin(module: { id: string; source: string }): Promise<ReloadResult> {
    return this.#serialized(() => this.#installPluginUnlocked(module));
  }

  async #installPluginUnlocked(module: { id: string; source: string }): Promise<ReloadResult> {
    const proposalId = `install:${module.id}`;
    const proposal = this.workspace.propose(proposalId, [module]);
    if (!proposal.ok) {
      return { ok: false, revision: this.workspace.revision, changed: [], error: proposal.error, rolledBack: true };
    }

    try {
      // Activation is a real isolated invocation, not just storing source.
      await this.#runPlugin(module, "plugin activation check", undefined);
    } catch (error) {
      return {
        ok: false,
        revision: this.workspace.revision,
        changed: [],
        error: error instanceof Error ? error.message : String(error),
        rolledBack: true,
      };
    }

    const result = this.workspace.acceptProposal(proposalId, { skipActivation: true });
    if (result.ok) {
      this.#persistWorkspace();
      this.stream.append("plugin_applied", [], {
        modelVisible: false,
        data: { id: module.id, revision: result.revision, hash: this.workspace.get(module.id)?.hash },
      });
    }
    return result;
  }

  async #runPlugin(
    module: { id: string; source: string },
    task: string,
    contextHandle: string | undefined,
  ): Promise<PluginOutput> {
    const code = `${module.source}\nreturn await globalThis.__plugin({ task: ${JSON.stringify(task)}, contextHandle: ${JSON.stringify(contextHandle ?? null)} });`;
    const result = await runInIsolate(code, {
      capabilities: {
        search_tools: (query: unknown) => this.toolRegistry.search(String(query)).map((tool) => tool.name),
        list_tools: () => this.toolRegistry.list().map((tool) => tool.name),
      },
      hooks: this.#hooks([], true),
    });
    const raw = (result.value ?? {}) as { instructions?: unknown; instruction?: unknown; toolQuery?: unknown };
    const instructions = [
      ...(Array.isArray(raw.instructions) ? raw.instructions.filter((v): v is string => typeof v === "string") : []),
      ...(typeof raw.instructions === "string" ? [raw.instructions] : []),
      ...(typeof raw.instruction === "string" ? [raw.instruction] : []),
    ];
    const output: PluginOutput = {
      instructions,
      toolQuery: typeof raw.toolQuery === "string" ? raw.toolQuery : undefined,
    };
    this.stream.append("plugin_output", [], { modelVisible: false, data: { id: module.id, output } });
    return output;
  }

  runStrategy(def: StrategyDef, input: string): Promise<string> {
    return this.#serialized(() => this.#runStrategyUnlocked(def, input));
  }

  async #runStrategyUnlocked(def: StrategyDef, input: string): Promise<string> {
    if (Object.values(def.agents).some((a) => a.type === "user") && !this.#options.humanAsk) {
      throw new Error(`strategy ${def.name} needs humanAsk in MegaAgentSystemOptions`);
    }
    const sessions: MegaSession[] = [];
    const strategy = buildStrategy(
      def,
      this.#options.humanAsk ?? (async () => { throw new Error("humanAsk is not configured"); }),
      {
        runtime: this.#options.adapter,
        stream: this.stream,
        cwd: this.#cwd,
        sessionOptions: this.#options.sessionOptions,
        parentPath: ["strategy"],
        sessionFor: (agentName, runtime) => {
          const session = new MegaSession(
            runtime,
            { cwd: this.#cwd, ...this.#options.sessionOptions },
            ["strategy", agentName],
            { stream: this.stream },
          );
          sessions.push(session);
          return session;
        },
      },
    );
    try {
      return await strategy.call(input, this.#hooks([]));
    } finally {
      for (const session of sessions) session.dispose();
    }
  }

  runTask(request: MegaTaskRequest): Promise<MegaTaskResult> {
    return this.#serialized(() => this.#runTaskUnlocked(request));
  }

  async #runTaskUnlocked(request: MegaTaskRequest): Promise<MegaTaskResult> {
    const taskId = `task-${++this.#taskSequence}`;
    const context = request.context ? this.contextStore.put(request.context) : undefined;
    const state: TaskState = {
      id: taskId,
      status: "running",
      request,
      loadedTools: new Set(["search_tools", ...(context?.handle ? ["expand_context"] : [])]),
      toolsUsed: [],
      iterations: 0,
      maxIterations: request.maxToolIterations ?? this.#options.maxToolIterations ?? 8,
      contextHandle: context?.handle,
      contextInline: context?.inline ?? "",
      contextSavedChars: context?.savedChars ?? 0,
      missingHostTools: [],
    };
    this.#tasks.set(taskId, state);
    this.#persistTask(state);

    this.stream.append("task_started", [], {
      modelVisible: false,
      data: { taskId, prompt: request.prompt },
    });
    if (context) {
      this.stream.append("context_stored", [], {
        modelVisible: false,
        data: { taskId, handle: context.handle, savedChars: context.savedChars, inline: context.inline },
      });
    }

    try {
    const pluginOutputs: PluginOutput[] = [];
    for (const id of this.workspace.ids()) {
      const module = this.workspace.get(id);
      if (module) pluginOutputs.push(await this.#runPlugin(module, request.prompt, state.contextHandle));
    }

    const initialQueries = [request.prompt, request.initialToolQuery, ...pluginOutputs.map((p) => p.toolQuery)]
      .filter((q): q is string => typeof q === "string" && q.length > 0);
    for (const query of initialQueries) {
      for (const tool of this.toolRegistry.search(query)) state.loadedTools.add(tool.name);
    }
    this.#persistTask(state);

    let strategyOutput: string | undefined;
    if (request.strategy !== undefined) {
      const definition = typeof request.strategy === "string"
        ? this.#strategies.get(request.strategy)
        : request.strategy;
      if (!definition) throw new Error(`unknown strategy: ${String(request.strategy)}`);
      if (typeof request.strategy !== "string") this.registerStrategy(definition);
      state.loadedTools.add("run_strategy");
      const execution = await this.#executeToolUnlocked("run_strategy", {
        name: definition.name,
        input: request.strategyInput ?? request.prompt,
      }, { agentPath: [], taskId: state.id, loadedTools: state.loadedTools });
      if (execution.status !== "completed") throw new Error("strategy execution unexpectedly parked");
      state.toolsUsed.push("run_strategy");
      strategyOutput = execution.text;
      this.#persistTask(state);
    }

    const firstPrompt = this.#buildPrompt(
      state,
      pluginOutputs.flatMap((p) => p.instructions),
      strategyOutput,
    );
    return await this.#continueTask(state, firstPrompt);
    } catch (error) {
      if (this.#tasks.has(state.id)) {
        state.status = "failed";
        state.activeOperation = undefined;
        this.#persistTask(state, error instanceof Error ? error.message : String(error));
        this.#tasks.delete(state.id);
        this.stream.append("task_failed", [], {
          modelVisible: false,
          data: { taskId: state.id, error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
  }

  resolveApproval(
    approvalId: string,
    decision: "allow" | "deny",
    by: string,
  ): Promise<MegaTaskResult> {
    return this.#serialized(() => this.#resolveApprovalUnlocked(approvalId, decision, by));
  }

  async #resolveApprovalUnlocked(
    approvalId: string,
    decision: "allow" | "deny",
    by: string,
  ): Promise<MegaTaskResult> {
    const pending = this.#pendingByApproval.get(approvalId);
    const decided = this.approvalGate.resolveParked(approvalId, decision, by);
    if (!pending) {
      return { status: "tool_completed", approvalId, decision, tool: "unknown", result: decided };
    }
    this.#pendingByApproval.delete(approvalId);

    const resumedState = pending.taskId ? this.#tasks.get(pending.taskId) : undefined;
    if (resumedState) {
      const wasRestored = resumedState.restoredFromStore === true;
      resumedState.status = "running";
      resumedState.pendingApprovalId = undefined;
      this.#persistTask(resumedState);
      if (wasRestored) {
        this.stream.append("task_resumed", pending.agentPath, {
          modelVisible: false,
          data: { taskId: resumedState.id, approvalId, decision, by },
        });
      }
    }

    const tool = this.#tools.get(pending.tool);
    let execution: { status: "completed"; tool: string; result: unknown; text: string };
    if (decision === "deny") {
      const text = `[tool_result ${pending.tool}]\nTool execution denied by ${by}.`;
      this.stream.append("tool_result", pending.agentPath, { tool: pending.tool, text, data: { taskId: pending.taskId } });
      execution = { status: "completed", tool: pending.tool, result: { denied: true, by }, text };
    } else if (!tool) {
      execution = this.#toolError(pending.tool, pending.agentPath, new Error(`unknown tool: ${pending.tool}`), pending.taskId);
    } else {
      execution = await this.#invokeTool(tool, pending.args, pending.agentPath, pending.taskId, pending.operationId);
    }

    const state = pending.taskId ? this.#tasks.get(pending.taskId) : undefined;
    if (!state) {
      return { status: "tool_completed", approvalId, decision, tool: pending.tool, result: execution.result };
    }
    state.toolsUsed.push(pending.tool);
    this.#persistTask(state);
    return this.#continueTask(state, this.#continuationPrompt(state, execution.text));
  }

  resumeInterruptedTask(taskId: string): Promise<MegaTaskResult> {
    return this.#serialized(() => this.#resumeInterruptedTaskUnlocked(taskId));
  }

  async #resumeInterruptedTaskUnlocked(taskId: string): Promise<MegaTaskResult> {
    const state = this.#tasks.get(taskId);
    if (!state || state.status !== "waiting_recovery") {
      throw new Error(`task is not waiting for recovery: ${taskId}`);
    }
    const operation = state.activeOperation;
    if (!operation || operation.kind !== "tool") {
      throw new Error(`task has no recoverable tool operation: ${taskId}`);
    }

    let execution: { status: "completed"; tool: string; result: unknown; text: string };
    if (state.recoveryObservation !== undefined) {
      execution = {
        status: "completed",
        tool: operation.tool,
        result: state.recoveryObservation,
        text: state.recoveryObservation,
      };
      state.activeOperation = undefined;
      state.recoveryObservation = undefined;
    } else {
      const tool = this.#tools.get(operation.tool);
      execution = tool
        ? await this.#invokeTool(tool, operation.args, operation.agentPath, state.id, operation.operationId)
        : this.#toolError(operation.tool, operation.agentPath, new Error(`unknown tool: ${operation.tool}`), state.id, operation.operationId);
    }

    state.status = "running";
    state.toolsUsed.push(operation.tool);
    this.#persistTask(state);
    this.stream.append("task_resumed", operation.agentPath, {
      modelVisible: false,
      data: { taskId: state.id, operationId: operation.operationId, recovered: true },
    });
    return this.#continueTask(state, this.#continuationPrompt(state, execution.text));
  }

  async #continueTask(state: TaskState, prompt: string): Promise<MegaTaskResult> {
    this.#activeTaskId = state.id;
    let nextPrompt = prompt;

    try {
    while (state.iterations < state.maxIterations) {
      state.iterations++;
      state.activeOperation = { kind: "model", operationId: `${state.id}:model:${state.iterations}` };
      this.#persistTask(state);
      const answer = await this.rootAgent.call(nextPrompt, this.#modelHooks([]));
      state.activeOperation = undefined;
      this.#persistTask(state);
      const parsed = parseModelReply(answer);
      if (parsed.kind === "invalid") {
        const protocolError = this.#toolError(
          "tool_protocol",
          [],
          new Error(parsed.error),
          state.id,
        );
        nextPrompt = this.#continuationPrompt(state, protocolError.text);
        continue;
      }
      const toolCall = parsed.kind === "tool" ? parsed : undefined;
      if (!toolCall) {
        this.stream.append("task_completed", [], {
          modelVisible: false,
          data: { taskId: state.id, toolsUsed: [...state.toolsUsed] },
        });
        const result: MegaTaskResult = {
          status: "completed",
          taskId: state.id,
          sessionId: this.session.id,
          answer,
          toolsUsed: [...state.toolsUsed],
          contextHandle: state.contextHandle,
          contextSavedChars: state.contextSavedChars,
          view: viewOf(this.stream),
        };
        this.#tasks.delete(state.id);
        this.#removePersistedTask(state.id);
        if (this.#activeTaskId === state.id) this.#activeTaskId = undefined;
        return result;
      }

      const execution = await this.#executeToolUnlocked(toolCall.tool, toolCall.args, {
        agentPath: [],
        taskId: state.id,
        loadedTools: state.loadedTools,
      });

      if (execution.status === "parked") {
        this.stream.append("task_waiting", [], {
          modelVisible: false,
          data: { taskId: state.id, approvalId: execution.approvalId, tool: execution.tool },
        });
        const item = this.attention.pending().find((candidate) => candidate.approvalId === execution.approvalId);
        if (this.#activeTaskId === state.id) this.#activeTaskId = undefined;
        return {
          status: "waiting_approval",
          taskId: state.id,
          sessionId: this.session.id,
          approvalId: execution.approvalId,
          tool: execution.tool,
          attentionRoute: item ? this.attention.route(item) : undefined,
          toolsUsed: [...state.toolsUsed],
        };
      }

      state.toolsUsed.push(execution.tool);
      this.#persistTask(state);
      nextPrompt = this.#continuationPrompt(state, execution.text);
    }
    } catch (error) {
      if (this.#activeTaskId === state.id) this.#activeTaskId = undefined;
      state.status = "failed";
      state.pendingApprovalId = undefined;
      this.#persistTask(state, error instanceof Error ? error.message : String(error));
      this.#tasks.delete(state.id);
      this.stream.append("task_failed", [], {
        modelVisible: false,
        data: { taskId: state.id, error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }

    const error = new Error(`task ${state.id} exceeded ${state.maxIterations} model/tool iterations`);
    if (this.#activeTaskId === state.id) this.#activeTaskId = undefined;
    state.status = "failed";
    this.#persistTask(state, error.message);
    this.#tasks.delete(state.id);
    this.stream.append("task_failed", [], {
      modelVisible: false,
      data: { taskId: state.id, error: error.message },
    });
    throw error;
  }

  #loadedSchemas(state: TaskState): string {
    const loaded = [...state.loadedTools]
      .map((name) => this.toolRegistry.get(name))
      .filter((tool): tool is ToolDef => tool !== undefined);
    return loaded.length
      ? loaded.map((tool) => this.toolRegistry.schemaForPrompt(tool)).join("\n")
      : "(none loaded)";
  }

  #buildPrompt(state: TaskState, pluginInstructions: string[], strategyOutput?: string): string {
    const contextLine = state.request.context
      ? state.contextHandle
        ? `Stored context handle: ${state.contextHandle}. The stored context content is not inline in this prompt. Use expand_context with that handle when the content is needed.`
        : `Context:\n${state.contextInline}`
      : "Stored context: none.";

    const autonomous = this.#options.adapter.capabilities?.executionMode === "autonomous-agent";
    return [
      "You are the root agent in one integrated system. Use tools only when they materially advance the task.",
      autonomous
        ? "Runtime mode: autonomous agent. You may use native runtime tools and attached mega-agent MCP tools. Native tool calls, usage, and app requests are recorded by the host. Use the exact JSON tool protocol only for a mega-agent tool that is not attached through MCP. Otherwise reply with the final answer as plain text."
        : "Tool protocol: to call a tool, reply with exactly one JSON object and no markdown: {\"tool\":\"tool_name\",\"args\":{}}. Otherwise reply with the final answer as plain text.",
      `Available tool names (schemas are deferred until loaded): ${this.toolRegistry.indexForPrompt()}`,
      `Loaded tool schemas:\n${this.#loadedSchemas(state)}`,
      pluginInstructions.length ? `Workspace plugin instructions:\n${pluginInstructions.join("\n")}` : "Workspace plugin instructions: none.",
      ...(strategyOutput ? [`Configured strategy output:\n${strategyOutput}`] : []),
      contextLine,
      `Task:\n${state.request.prompt}`,
    ].join("\n\n");
  }

  #continuationPrompt(state: TaskState, observation: string): string {
    const restoredHistory = state.restoredFromStore
      ? deriveMessages(this.stream, [])
          .map((message) => `${message.role}: ${message.content}`)
          .join("\n")
      : "";
    if (state.restoredFromStore) state.restoredFromStore = false;

    return [
      observation,
      ...(restoredHistory
        ? [`This task resumed in a new process. Prior model-visible history from the persisted record stream:\n${restoredHistory}`]
        : []),
      `Continue the original task: ${state.request.prompt}`,
      `Loaded tool schemas now available:\n${this.#loadedSchemas(state)}`,
      "Use the exact JSON tool protocol if another tool is needed; otherwise return the final plain-text answer.",
    ].join("\n\n");
  }

  snapshot(): {
    sessionId: string;
    view: ConversationView;
    messages: { role: string; content: string }[];
    attention: AttentionItem[];
    parkedApprovals: ApprovalRequest[];
    persistedTasks: MegaTaskSummary[];
    workspaceRevision: number;
    pluginIds: string[];
    budgetSpent: number;
    recordCount: number;
  } {
    return {
      sessionId: this.session.id,
      view: viewOf(this.stream),
      messages: deriveMessages(this.stream, this.session.agentPath),
      attention: this.attention.pending(),
      parkedApprovals: this.approvalGate.parked(),
      persistedTasks: this.persistedTasks().map((task) => ({
        id: task.id,
        status: task.status,
        prompt: task.request.prompt,
        pendingApprovalId: task.pendingApprovalId,
        resumable: (task.status === "waiting_approval" || task.status === "waiting_recovery") && this.#tasks.has(task.id),
        missingHostTools: this.#tasks.get(task.id)?.missingHostTools
          ?? task.loadedTools.filter((tool) => !this.#tools.has(tool)),
        hostManifest: task.hostManifest,
      })),
      workspaceRevision: this.workspace.revision,
      pluginIds: this.workspace.ids(),
      budgetSpent: this.#budgetHook.spent,
      recordCount: this.stream.records.length,
    };
  }

  dispose(): Promise<void> {
    return this.#serialized(() => this.#disposeUnlocked());
  }

  async #disposeUnlocked(): Promise<void> {
    this.session.dispose();
    const adapters = new Set<RuntimeAdapter>([
      this.#options.adapter,
      ...(this.#options.additionalRuntimes?.values() ?? []),
    ]);
    for (const adapter of adapters) await adapter.dispose?.();
  }
}

type ParsedModelReply =
  | { kind: "final" }
  | { kind: "tool"; tool: string; args: Record<string, unknown> }
  | { kind: "invalid"; error: string };

function parseModelReply(text: string): ParsedModelReply {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!trimmed.startsWith("{")) return { kind: "final" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      kind: "invalid",
      error: `reply looked like a tool call but was not one exact JSON object: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "final" };
  const record = parsed as Record<string, unknown>;
  if (!("tool" in record)) return { kind: "final" };
  if (typeof record.tool !== "string" || record.tool.length === 0) {
    return { kind: "invalid", error: "tool call field 'tool' must be a non-empty string" };
  }
  const extraKeys = Object.keys(record).filter((key) => key !== "tool" && key !== "args");
  if (extraKeys.length) {
    return { kind: "invalid", error: `tool call contains unsupported fields: ${extraKeys.join(", ")}` };
  }
  if (record.args !== undefined && (!record.args || typeof record.args !== "object" || Array.isArray(record.args))) {
    return { kind: "invalid", error: "tool call field 'args' must be an object" };
  }
  return {
    kind: "tool",
    tool: record.tool,
    args: (record.args ?? {}) as Record<string, unknown>,
  };
}

function validateToolArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  if (!tool.schema) return [];
  const errors: string[] = [];
  validateSchemaValue(tool.schema, args, "args", errors);
  return errors;
}

function schemaTypeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

function validateSchemaValue(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    errors.push(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
    return;
  }

  const declaredTypes = Array.isArray(schema.type)
    ? schema.type.filter((t): t is string => typeof t === "string")
    : typeof schema.type === "string" ? [schema.type] : [];
  if (declaredTypes.length && !declaredTypes.some((type) => schemaTypeMatches(type, value))) {
    errors.push(`${path} must be ${declaredTypes.join(" or ")}`);
    return;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path} is shorter than minLength ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path} exceeds maxLength ${schema.maxLength}`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} is below minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} exceeds maximum ${schema.maximum}`);
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    value.forEach((item, index) => validateSchemaValue(schema.items as Record<string, unknown>, item, `${path}[${index}]`, errors));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === "string") : [];
    for (const key of required) {
      if (!(key in record)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in record && propertySchema && typeof propertySchema === "object" && !Array.isArray(propertySchema)) {
        validateSchemaValue(propertySchema as Record<string, unknown>, record[key], `${path}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
      }
    }
  }
}

export function createMegaAgent(options: MegaAgentSystemOptions): MegaAgentSystem {
  return new MegaAgentSystem(options);
}
