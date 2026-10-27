# mega-agent

Full-stack skeleton consolidated from the eight apps in `../`: AgentOnWeb, alto,
CommaAgents, deepseek-harness, jaz, moejs, oar, openhuman.
Design rationale, overlap winners, and anti-patterns: [`../MEGA_AGENT_THESIS.md`](../MEGA_AGENT_THESIS.md).

## Run

Requires Node ≥ 24 (erasable TypeScript runs with no build step and no dependencies).

```bash
npm run demo   # end-to-end run through all eight layers
npm test       # 10 tests, one or more per layer
```

## Stack (bottom to top)

| Layer | Directory | Source app | Mechanism |
|---|---|---|---|
| 1 Session kernel | `src/kernel/` | oar + deepseek-harness | Append-only record stream, `seq` + `agentPath` on every record, raw payloads preserved, JSONL persistence. `deriveMessages()` builds model history from the log only. `viewOf()` is a pure fold. Approval audit records are never model-visible. |
| 2 Honest control | `src/control/` | oar + alto | `deliver()` answers `steered` / `queued` / typed `rejected`. Unsupported session options throw `UnsupportedOptionError` before opening. Stale-turn steering rejects. `ScriptedRuntime` is the test adapter; real runtimes implement `RuntimeAdapter` (the seam where `@botiverse/oar` plugs in). |
| 3 Composition | `src/composition/`, `src/effects/` | CommaAgents + jaz | One `call()` contract for LLM agent, human agent, flow, and Strategy. Cycle observers return a typed JSON verdict — no substring break-signals. Span hooks (Enter/Send/Complete/Exit with Supply/Modify/Abort) implement budget, return-typing, and caching. |
| 4 Delegation | `src/crew/` | oar crews | Cross-runtime subagents with a concurrency cap. Every report wakes the parent session as an attributed delivery. |
| 5 Substrate | `src/substrate/` | moejs (properties) | Disposable isolate per task: host-granted capabilities only, no `process`/`require`, external timeout interrupt, output budget. Honest limit: `node:vm` is not a security boundary — production swaps in moejs, QuickJS/WASM, or a process per isolate. |
| 6 Economics | `src/economics/` | openhuman | Context by handle (`ccr:N`, expand on demand) instead of inline mega-prompts. Deferred tool registry: names in prompt, schemas loaded by search. |
| 7 Human surface | `src/surface/` | alto + AgentOnWeb | Transactional workspace reprogramming (`propose`/`acceptProposal`/`reprogram`): validate all, activate all, roll back all on failure. `AttentionIndex` routes the human to the exact session; the index has no approve method by construction. |
| 8 Decision plane | `src/decision/` | deepseek-harness + openhuman | Fail-closed approval waterfall. Unanswered requests park durably (file-backed, survive restart) and resolve later. Decisions are audit-only events. |

## Status and honest limits

- Skeleton, not production: one scripted runtime adapter, in-memory sessions except
  parked approvals and optional JSONL record files. No real LLM or `@botiverse/oar`
  wiring yet — `RuntimeAdapter` in `src/control/runtime.ts` is the integration seam.
- `abort()` reports honestly but does not yet cancel an in-flight adapter call.
- The substrate timeout interrupts synchronous loops; asynchronous runaway code
  needs the production isolate (moejs/WASM/process).
- Next slices, in thesis order: real oar adapter, durable record-stream resume,
  per-agent scoped plugin presets (deepseek-harness), fleet accounting.
