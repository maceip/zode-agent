// Real brain: drives an installed agent runtime (claude, codex, grok, kimi,
// opencode, pi, ...) through @botiverse/oar from ../../oar.
// Dynamic import on purpose: the scripted demo and tests need zero dependencies;
// live mode fails with a plain message when oar is not built/installed.
import type {
  MegaSession,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeHostToolBinding,
} from "./runtime.ts";

// Minimal structural shapes of the oar API (oar/packages/oar/src/observe/turns.ts,
// oar/packages/oar/src/registry.ts). Runtime values are checked at import time.
interface OarEvent {
  kind: string;
  agentPath?: readonly string[];
  text?: string;
  tool?: string;
  callId?: string;
  input?: string;
  delta?: string;
  content?: readonly { type?: string; text?: string }[];
  result?: string;
  exitCode?: number | null;
  requestId?: string;
  type?: string;
  usage?: {
    tokens?: { input?: number; output?: number };
    total?: { input?: number; output?: number };
    context?: unknown;
  };
  [k: string]: unknown;
}
interface OarSession {
  events(cb: (e: OarEvent) => void): void;
  deliver(text: string): Promise<unknown>;
  abort(): Promise<unknown>;
  dispose(): Promise<void>;
}
interface OarRuntime {
  refusedSessionOptions?: Readonly<Partial<Record<string, string>>>;
  installation?: () => Promise<{ kind: string } | undefined>;
  session(installation: unknown, options: Record<string, unknown>): Promise<OarSession>;
}

interface ServedMcpTools {
  readonly server: unknown;
  setTools(tools: readonly unknown[]): void;
  close(): Promise<void>;
}

interface OarHostTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly handler: (
    input: Readonly<Record<string, unknown>>,
    context: { readonly signal: AbortSignal },
  ) => Promise<string> | string;
}

type ServeMcpToolsFn = (options: {
  name: string;
  instructions?: string;
  tools: readonly OarHostTool[];
}) => Promise<ServedMcpTools>;
type PromptRun = { kind: string; text?: string; reason?: string; code?: string };
type PromptAndWaitFn = (s: OarSession, input: string, opts: { timeoutMs?: number }) => Promise<PromptRun>;

export class OarRuntimeAdapter implements RuntimeAdapter {
  readonly supportedOptions = [
    "cwd", "model", "effort", "resume", "additionalDirectories", "serviceTier",
    "outputSchema", "name", "env", "userConfiguration", "systemPrompt",
    "appendSystemPrompt", "mcpServers", "disallowedTools", "launchArgs",
  ] as const;
  readonly canSteer = true; // oar deliver() steers or queues per runtime; MegaSession.deliver stays honest about local turns
  readonly capabilities: RuntimeCapabilities = {
    executionMode: "autonomous-agent",
    nativeTools: true,
    // OAR records native app requests, but the Session API has no host answer
    // hook; adapters generally answer or pre-authorize them internally.
    nativeApprovals: "adapter-managed",
    reportsUsage: true,
    supportsHostTools: true,
  };
  readonly id: string;
  // One external agent session per MegaSession. A single cached session would
  // wrongly merge the root conversation, crew children, and strategy agents.
  #oarSessions = new WeakMap<MegaSession, Promise<OarSession>>();
  #openedSessions = new Set<OarSession>();
  #promptAndWait?: PromptAndWaitFn;
  #runtime: OarRuntime;
  #installation: unknown;
  #timeoutMs: number;
  readonly #serveMcpTools?: ServeMcpToolsFn;
  #hostBinding?: RuntimeHostToolBinding;
  #servedTools?: ServedMcpTools;
  #servedToolsReady?: Promise<boolean>;
  #hostToolsAttached = false;
  readonly #lastUsageTotal = new WeakMap<MegaSession, number>();
  readonly #nativeToolByCall = new WeakMap<MegaSession, Map<string, string>>();

  private constructor(
    runtimeId: string,
    runtime: OarRuntime,
    installation: unknown,
    promptAndWait: PromptAndWaitFn,
    timeoutMs: number,
    serveMcpTools?: ServeMcpToolsFn,
  ) {
    this.id = `oar:${runtimeId}`;
    this.#runtime = runtime;
    this.#installation = installation;
    this.#promptAndWait = promptAndWait;
    this.#timeoutMs = timeoutMs;
    this.#serveMcpTools = serveMcpTools;
  }

  static async create(runtimeId = "claude", timeoutMs = 600_000): Promise<OarRuntimeAdapter> {
    let root: Record<string, unknown>, observe: Record<string, unknown>;
    try {
      root = (await import("@botiverse/oar")) as Record<string, unknown>;
      observe = (await import("@botiverse/oar/observe").catch(() => root)) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`@botiverse/oar is not importable. Build oar first: cd ../oar && pnpm install && pnpm --filter @botiverse/oar build, then in mega-agent: npm install. Cause: ${(e as Error).message}`);
    }
    const promptAndWait = (observe.promptAndWait ?? root.promptAndWait) as PromptAndWaitFn | undefined;
    const registry = root.defaultRuntimes as { require(id: string): OarRuntime } | undefined;
    if (!registry || typeof promptAndWait !== "function") throw new Error("@botiverse/oar loaded but defaultRuntimes/promptAndWait are missing — oar version mismatch.");
    const runtime = registry.require(runtimeId);
    const installation: unknown = await runtime.installation?.();
    if (!installation || (installation as { kind?: string }).kind !== "available") {
      throw new Error(`runtime "${runtimeId}" is not installed or not available on this machine (oar installation check).`);
    }
    const serveMcpTools = typeof root.serveMcpTools === "function"
      ? root.serveMcpTools as ServeMcpToolsFn
      : undefined;
    return new OarRuntimeAdapter(runtimeId, runtime, installation, promptAndWait, timeoutMs, serveMcpTools);
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

  bindHostTools(binding: RuntimeHostToolBinding): void {
    this.#hostBinding = binding;
    // Lazy: an unused crew adapter should not start an MCP HTTP server. If a
    // server is already live for an opened session, refresh its tool list.
    if (this.#servedTools) {
      this.#servedToolsReady = this.#ensureServedTools().catch(() => false);
    }
  }

  hostToolsAttached(): boolean { return this.#hostToolsAttached; }

  async #ensureServedTools(): Promise<boolean> {
    if (!this.#hostBinding || !this.#serveMcpTools) return false;
    const refused = this.#runtime.refusedSessionOptions ?? {};
    if (refused.mcpServers !== undefined || refused.mcpServerCredentials !== undefined) {
      this.#hostToolsAttached = false;
      return false;
    }

    const binding = this.#hostBinding;
    const tools: OarHostTool[] = binding.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: async (input, context) => {
        const result = await binding.call(tool.name, { ...input }, context);
        return typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? String(result);
      },
    }));

    if (this.#servedTools) {
      this.#servedTools.setTools(tools);
      this.#hostToolsAttached = true;
      return true;
    }

    this.#servedTools = await this.#serveMcpTools({
      name: binding.name,
      instructions: binding.instructions,
      tools,
    });
    this.#hostToolsAttached = true;
    return true;
  }

  #recordNativeEvent(mega: MegaSession, event: OarEvent): void {
    const path = [...mega.agentPath, ...(event.agentPath ?? [])];
    const native = { ...event, source: "native" as const };

    if (event.kind === "tool_call_started") {
      if (event.callId && event.tool) {
        const calls = this.#nativeToolByCall.get(mega) ?? new Map<string, string>();
        calls.set(event.callId, event.tool);
        this.#nativeToolByCall.set(mega, calls);
      }
      mega.stream.append("tool_call", path, { tool: event.tool, modelVisible: false, data: native });
      return;
    }

    if (event.kind === "tool_call_ended") {
      const text = event.content?.filter((part) => typeof part.text === "string").map((part) => part.text).join("\n") ?? "";
      mega.stream.append("tool_result", path, {
        tool: event.callId ? this.#nativeToolByCall.get(mega)?.get(event.callId) : undefined,
        text: text || undefined,
        outcome: event.result,
        modelVisible: false,
        data: native,
      });
      return;
    }

    if (event.kind === "usage") {
      const totals = event.usage?.total ?? event.usage?.tokens;
      const current = totals ? (totals.input ?? 0) + (totals.output ?? 0) : 0;
      const previous = this.#lastUsageTotal.get(mega) ?? 0;
      if (current > 0) this.#lastUsageTotal.set(mega, Math.max(previous, current));
      mega.stream.append("usage", path, {
        tokens: current > previous ? current - previous : 0,
        modelVisible: false,
        data: native,
      });
      return;
    }

    if (event.kind === "app_request") {
      mega.stream.append("attention", path, {
        text: `native runtime request: ${event.type ?? "app_request"}`,
        modelVisible: false,
        data: { ...native, requestId: event.requestId, nativeApprovals: this.capabilities.nativeApprovals },
      });
      return;
    }

    mega.stream.append("native_event", path, {
      text: event.kind === "text_delta" ? event.text : undefined,
      tool: event.tool,
      modelVisible: false,
      data: native,
    });
  }

  async #open(mega: MegaSession): Promise<OarSession> {
    const existing = this.#oarSessions.get(mega);
    if (existing) return existing;

    const opening = (async () => {
      if (this.#hostBinding && !this.#servedToolsReady) {
        this.#servedToolsReady = this.#ensureServedTools();
      }
      const attached = this.#servedToolsReady
        ? await this.#servedToolsReady.catch(() => false)
        : false;
      const configuredServers = Array.isArray(mega.options.mcpServers)
        ? mega.options.mcpServers as unknown[]
        : [];
      const mcpServers = [
        ...configuredServers,
        ...(attached && this.#servedTools ? [this.#servedTools.server] : []),
      ];
      const options: Record<string, unknown> = { ...mega.options };
      if (mcpServers.length) options.mcpServers = mcpServers;
      else delete options.mcpServers;

      const session = await this.#runtime.session(this.#installation, options);
      this.#openedSessions.add(session);
      session.events((event) => this.#recordNativeEvent(mega, event));
      return session;
    })();

    this.#oarSessions.set(mega, opening);
    return opening;
  }

  async runTurn(mega: MegaSession, prompt: string): Promise<string> {
    const session = await this.#open(mega);
    const run = await this.#promptAndWait!(session, prompt, { timeoutMs: this.#timeoutMs });
    if (run.kind === "rejected") throw new Error(`oar prompt rejected (${run.code ?? "?"}): ${run.reason ?? ""}`);
    return run.text ?? "";
  }

  async deliverToRuntime(mega: MegaSession, text: string): Promise<void> {
    const session = await this.#open(mega);
    await session.deliver(text);
  }

  async abortTurn(mega: MegaSession): Promise<void> {
    const session = await this.#open(mega);
    await session.abort();
  }

  async disposeSession(mega: MegaSession): Promise<void> {
    const opening = this.#oarSessions.get(mega);
    if (!opening) return;
    this.#oarSessions.delete(mega);
    const session = await opening;
    this.#openedSessions.delete(session);
    await session.dispose();
  }

  async dispose(mega?: MegaSession): Promise<void> {
    if (mega) return this.disposeSession(mega);
    const sessions = [...this.#openedSessions];
    this.#openedSessions.clear();
    await Promise.all(sessions.map((session) => session.dispose()));
    if (this.#servedTools) {
      await this.#servedTools.close();
      this.#servedTools = undefined;
      this.#hostToolsAttached = false;
      this.#servedToolsReady = undefined;
    }
  }
}
