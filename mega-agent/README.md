# mega-agent

Full-stack skeleton consolidated from the eight apps in `../`: AgentOnWeb, alto,
CommaAgents, deepseek-harness, jaz, moejs, oar, openhuman.
Design rationale, overlap winners, and anti-patterns: [`../MEGA_AGENT_THESIS.md`](../MEGA_AGENT_THESIS.md).

## Run

Requires Node ≥ 24 (erasable TypeScript runs with no build step and no dependencies).

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

# 6. Run unit tests (13 tests across all 8 layers)
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

## Stack (bottom to top)

| Layer | Directory | Source app | Mechanism |
|---|---|---|---|
| 1 Session kernel | `src/kernel/` | oar + deepseek-harness | Append-only record stream, `seq` + `agentPath` on every record, raw payloads preserved, JSONL persistence. `deriveMessages()` builds model history from the log only. `viewOf()` is a pure fold. Approval audit records are never model-visible. |
| 2 Honest control | `src/control/` | oar + alto | `deliver()` answers `steered` / `queued` / typed `rejected`. Unsupported session options throw `UnsupportedOptionError` before opening. Stale-turn steering rejects. `ScriptedRuntime` is the test adapter; real runtimes implement `RuntimeAdapter` (the seam where `@botiverse/oar` plugs in). |
| 3 Composition | `src/composition/`, `src/effects/` | CommaAgents + jaz | One `call()` contract for LLM agent, human agent, flow, and Strategy. Cycle observers return a typed JSON verdict — no substring break-signals. Span hooks (Enter/Send/Complete/Exit with Supply/Modify/Abort) implement budget, return-typing, and caching. |
| 4 Delegation | `src/crew/` | oar crews | Cross-runtime subagents with a concurrency cap. Every report wakes the parent session as an attributed delivery. |
| 5 Substrate | `src/substrate/` | moejs (properties) | Each job runs in a separate child process under Node `--permission` (file reads denied) and, on macOS, `sandbox-exec` (network and spawning denied). Inside the child process, a vm realm provides `cap(name, ...)` — named JSON calls to parent-granted capabilities — plus `console` and data globals. No `process`, no `require`, no dynamic `import`, code generation from strings disabled. The parent kills the child process on timeout or output overrun. Plain residual risk: without `sandbox-exec`, code that escapes the vm realm could still reach the network; other platforms need an OS jail, moejs, or WASM for that last hole. |
| 6 Economics | `src/economics/` | openhuman | Context by handle (`ccr:N`, expand on demand) instead of inline mega-prompts. Deferred tool registry: names in prompt, schemas loaded by search. |
| 7 Human surface | `src/surface/` | alto + AgentOnWeb | Transactional workspace reprogramming (`propose`/`acceptProposal`/`reprogram`): validate all, activate all, roll back all on failure. `AttentionIndex` routes the human to the exact session; the index has no approve method by construction. |
| 8 Decision plane | `src/decision/` | deepseek-harness + openhuman | Fail-closed approval waterfall. Unanswered requests park durably (file-backed, survive restart) and resolve later. Decisions are audit-only events. |

## Status and honest limits

- Skeleton, not production: in-memory sessions except parked approvals and optional
  JSONL record files.
- `abort()` reports honestly but does not yet cancel an in-flight adapter call.
- Async runaway isolate code is stopped by the parent process kill, not by the
  in-vm timeout (which covers synchronous loops).
- Next slices, in thesis order: durable record-stream resume, per-agent scoped
  plugin presets (deepseek-harness), fleet accounting.
