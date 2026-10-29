# mega-agent

Full-stack skeleton consolidated from the eight apps in `../`: AgentOnWeb, alto,
CommaAgents, deepseek-harness, jaz, moejs, oar, openhuman.
Design rationale, overlap winners, and anti-patterns: [`../MEGA_AGENT_THESIS.md`](../MEGA_AGENT_THESIS.md).

## Run

Requires Node ≥ 24. The TypeScript is erasable, so Node runs the source with no
build step. Live external runtimes use the local `@botiverse/oar` dependency.

```bash
# 1. Inspect detected runtimes (LiteRT-LM models and installed agent CLIs)
node src/cli.ts --inventory

# 2. Run full 8-layer stack using live LLM runtime by default (auto-detects codex, claude, etc.)
npm run demo

# 3. Direct prompt using active live engine
node src/cli.ts --prompt "Analyze our repo health"

# 4. Use native local on-device LiteRT-LM engine
node src/cli.ts --local --model vibethinker-3b-litertlm

# 5. Use specific installed agent CLI
node src/cli.ts --runtime claude
node src/cli.ts --runtime codex

# 6. Run tests, including forced end-to-end integration tests
npm test

# 7. Run in deterministic offline test mode
node src/cli.ts --scripted
```

### Supported Runtime Engines

1. **Native On-Device LiteRT-LM Engine** (`litert-lm`):
   - Local CPU (XNNPACK) and Apple Silicon GPU (WebGPU/Metal) acceleration.
   - Built-in model discovery (`~/.litert-lm/models`).
   - Supports `.litertlm` models (Gemma, Llama, Qwen, etc.) via native CLI or local OpenAI-compatible API server (`litert-lm serve`).
2. **User-Installed Agent CLIs** (driven via `@botiverse/oar`):
   - `codex` (Codex CLI via native app-server)
   - `claude` (Claude Code)
   - `grok`
   - `kimi`
   - `opencode`
   - `pi` (bundled)
3. **Scripted Test Engine** (`scripted`):
   - Deterministic offline mock for CI and unit tests.

## Integrated execution path

`createMegaAgent()` in `src/app/mega-agent.ts` is the composition root. It creates
one shared `RecordStream`, one root `MegaSession`, the approval gate, attention
index, context store, deferred tool registry, crew, workspace, shared hooks, and
human agent. The CLI sends both `--prompt` tasks and the demo through
`MegaAgentSystem.runTask()`; the CLI does not assemble layers itself.

For each task:

1. Large context is stored by handle rather than copied into the first prompt.
2. Installed workspace plugins run in the isolate and can add instructions and
   select deferred tools. An optional configured strategy then runs through the
   `run_strategy` tool before the root turn.
3. The root runtime answers with plain text or one exact JSON tool call.
   Autonomous runtimes may instead use native tools and mega-agent tools attached
   over MCP; native tool calls, usage, and app requests enter the shared stream.
4. `search_tools` loads schemas on demand. Other mega tools cannot run until
   loaded, and arguments are validated against the loaded schema.
5. Tool execution passes through the shared hooks and record stream. Approval-gated
   tools either receive an answer, are denied, or park without executing.
6. Crew children use separate runtime sessions but the same record stream and
   attributed `agentPath`. The CLI provisions every detected runtime that can
   instantiate an adapter into the crew registry.
7. Tool results become model-visible records and the next model turn continues.
   Root operations are serialized, so concurrent task calls do not interleave
   turns in the shared root session.
8. Resolving a parked approval executes or denies the tool and resumes the
   original task loop. With `taskStoreFile`, `approvalStoreFile`, and
   `recordFile` configured, a new process reconstructs the waiting task state,
   loaded tools, tools used, iteration count, context handle/content, and
   model-visible history, then continues to the final model answer.

Strategies are available both as `MegaAgentSystem.runStrategy()` and as the
model-callable `run_strategy` tool. `MegaTaskRequest.strategy` runs a registered
strategy before the root turn. Strategy agents use the active runtime, the same
record stream, the configured human callback, propagated hooks, and disposed
per-agent sessions. Standalone crew spawns also share the stream when created
through the system.

### Durable resume boundary

The CLI stores `approvals.json`, `tasks.json`, `records.jsonl`, and
`workspace.json` together under `.mega-agent/` by default. A two-process approval flow is:

```bash
node src/cli.ts --scripted --defer-approvals --state-dir /tmp/mega-state
node src/cli.ts --scripted --state-dir /tmp/mega-state \
  --resolve-approval <approval-id> --decision allow
```

Full resume happens at the approval boundary. The journal also records the
active model/tool operation. If a process stops during a tool call and either a
`tool_result` for that operation already exists or the tool declares
`idempotent: true`, the next process exposes the task as `waiting_recovery` for
`resumeInterruptedTask()` / `--resume-task`. Interrupted model calls and
non-idempotent tools are marked `interrupted`, not replayed.

## Stack (bottom to top)

| Layer | Directory | Source app | Mechanism |
|---|---|---|---|
| 1 Session kernel | `src/kernel/` | oar + deepseek-harness | Append-only record stream, `seq` + `agentPath` on every record, raw payloads preserved, JSONL persistence. `deriveMessages()` builds model history from the log only. `viewOf()` is a pure fold. Approval audit records are never model-visible. |
| 2 Honest control | `src/control/` | oar + alto | `deliver()` answers `steered` / `queued` / typed `rejected` and forwards live steering to adapters that implement it. `abort()` calls the adapter cancellation hook or returns `unsupported`; the oar adapter forwards to the external session's abort. Unsupported session options throw `UnsupportedOptionError` before opening. `ScriptedRuntime` is the test adapter; real runtimes implement `RuntimeAdapter`. |
| 3 Composition | `src/composition/`, `src/effects/` | CommaAgents + jaz | One `call()` contract for LLM agent, human agent, flow, and Strategy. Cycle observers return a typed JSON verdict — no substring break-signals. Span hooks (Enter/Send/Complete/Exit with Supply/Modify/Abort) implement budget, return-typing, and caching. |
| 4 Delegation | `src/crew/` | oar crews | Cross-runtime subagents with a concurrency cap. When created by `MegaAgentSystem`, children get distinct runtime sessions, share the parent record stream, and return through the `delegate` tool or wake the parent as an attributed delivery. |
| 5 Substrate | `src/substrate/` | moejs (properties) | Each job runs in a separate child process under Node `--permission` (file reads denied) and, on macOS, `sandbox-exec` (network and spawning denied). Inside the child process, a vm realm provides `cap(name, ...)` — named JSON calls to parent-granted capabilities — plus `console` and data globals. No `process`, no `require`, no dynamic `import`, code generation from strings disabled. The parent kills the child process on timeout or output overrun. Plain residual risk: without `sandbox-exec`, code that escapes the vm realm could still reach the network; other platforms need an OS jail, moejs, or WASM for that last hole. |
| 6 Economics | `src/economics/` | openhuman | Context by handle (`ccr:N`, expand on demand) instead of inline mega-prompts. Deferred tool registry: names in prompt, schemas loaded by search. |
| 7 Human surface | `src/surface/`, `src/app/` | alto + AgentOnWeb | Transactional workspace reprogramming (`propose`/`acceptProposal`/`reprogram`): validate all, activate all, roll back all on failure. `MegaAgentSystem.installPlugin()` activates plugins in the isolate, then runs installed plugins before each task so plugin output affects instructions and deferred-tool loading. `AttentionIndex` reads the shared stream and routes the human to the exact session; the index has no approve method by construction. |
| 8 Decision plane | `src/decision/` | deepseek-harness + openhuman | Fail-closed approval waterfall. Unanswered requests park durably (file-backed, survive restart) and resolve later. Decisions are audit-only events. |

## Status and honest limits

- Durable full-task resume covers approval-boundary tasks and interrupted
  idempotent/already-recorded tool operations. Interrupted model calls and
  non-idempotent tools are marked `interrupted`, not automatically replayed.
- The library only writes a task journal when `taskStoreFile` is configured.
  The CLI configures the task journal, approval store, record stream, and
  workspace store by default under `.mega-agent/`.
- Native OAR approvals remain adapter-managed because the OAR Session API does
  not expose a host answer callback. Mega-agent MCP tools still pass through
  the mega-agent approval gate.
- A restarted external runtime receives the restored model-visible transcript
  in the continuation prompt, but the external provider session itself is new
  unless the host separately uses that runtime's native `resume` support.
- `abort()` reaches adapters that implement cancellation. Adapters without a
  cancellation hook return `unsupported` instead of pretending to queue an abort.
- Async runaway isolate code is stopped by the parent process kill, not by the
  in-vm timeout (which covers synchronous loops).
- Next slices, in thesis order: crash-safe idempotency for active tool calls,
  per-agent scoped plugin presets (deepseek-harness), fleet accounting.
