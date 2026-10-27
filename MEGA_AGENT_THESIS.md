# Mega-Agent Thesis

Source set: AgentOnWeb, alto, CommaAgents, deepseek-harness (`dsh`), jaz, moejs, oar, openhuman — in `/Users/mac/zode-agent`.
Method: the built-in `deep-research` workflow returned no claims; a custom per-app workflow returned full source evidence for AgentOnWeb, CommaAgents, and `dsh`, and notes only for alto, jaz, moejs, oar, and openhuman. The five note-only apps were then read directly (README and architecture docs). No tests were run. Claims below cite the app that owns each mechanism.

## Thesis

**The mega-agent is not a bigger agent loop. The mega-agent is a durable, provider-independent session kernel — one append-only record stream per agent, typed honest control, fleet-cheap execution — with composable agents/humans/flows above the kernel, a transactional self-modifying workspace as the human surface, and ambient attention routing that brings the human to the exact agent that needs a decision, without the presentation layer ever making the decision.**

Every app in the set owns exactly one layer of that stack. No app owns two layers well. Consolidation means stacking the layers, not picking a winner app and discarding the rest.

## Unique contribution per app

### AgentOnWeb — ambient presence and attention routing
- Inverts browser embedding: the human's current webpage stays the backdrop; the unmodified native agent workspace (PTY running Codex/Claude Code/Pi, or the `dsh` web UI) overlays the webpage. AgentOnWeb runs no shell in the page and provides no AI runtime (`AgentOnWeb/docs/architecture.md`).
- Versioned loopback `SurfaceAdapter` protocol (ports 3847–3850): the runtime owns execution, UI, and auth; the extension owns only presentation and a delegated cookie. The same connector-host serves two unrelated runtimes — terminal-host and a `dsh` plugin — and launch-token-to-cookie exchange happens server-side, so credentials never reach page JS.
- Agent status comes from observational per-agent lifecycle hooks normalized into `AgentSession{status, attentionId}`, never from scraping PTY output. A notification click activates the exact `terminalId`.
- Hard rule worth copying verbatim: presentation never sends keystrokes to approve. Approvals stay in the native CLI TUI. Hook payloads strip commands, tool output, and responses.
- Do not copy: approximate status (Codex `PermissionRequest` has no `tool_use_id`; a killed CLI leaves a stale snapshot), in-memory registry with no restore after host restart, install-time mutation of each CLI's `hooks.json`/`config.toml`/`settings.json`.

### alto — the self-modifying workspace, transactionally
- The workspace itself (chat views, pane layouts, commands, application tools) is TypeScript/React Cordis plugins. An agent edits the workspace from inside a conversation; alto compiles and reloads only affected plugins while the application runs (`alto/README.md`, `alto/docs/architecture.md`).
- Transactional reload: bundle and hash every enabled module, reconcile fibers by stable ID, and on any activation failure reconcile back to the previous profile and restore original files. The browser observes a complete old UI snapshot or a complete new UI snapshot, never a half-applied mixture.
- Long-lived kernel vs. reloadable program: the Codex bridge, web gateway, and browser recovery path sit outside the reloadable subtree, so a reload never interrupts active threads, connected browsers, or pending approvals. `cordis_reprogram` (apply now) and `cordis_propose_change` (in-memory proposal, human accepts) share the same validation path.
- Detachable remote agents: closing the laptop only detaches the client; the remote process keeps running; an ordered journal with stable cursors reconstructs the chat on reopen; failed writes are never auto-retried (`alto/docs/remote-agents.md`).
- Do not copy: pre-alpha, macOS-first; the reload machinery assumes one trusted local user editing one workspace.

### CommaAgents — one contract for agent, human, and flow
- Flow IS Agent: `buildFlowAgent()` returns `Agent{name, call, reset}`, so flows nest recursively as steps under one `call()`/`stream()` contract (`CommaAgents/packages/core/src/flows/flow/flow.ts`).
- Human IS Agent: `createUserAgent` is `createAgent` with an execute override that collects input instead of calling an LLM, usable in any flow step and declaratively as `type: user` in a Strategy.
- Declarative Strategy (Zod schema: LLM/User/Custom agents + recursive FlowDef) is the portable, shareable unit; `launch_strategy` recursively spawns sub-strategies with isolated run IDs.
- Daemon systems attach human-in-the-loop behaviour by hooks after creation — input, permission, question, steering mailbox, sub-launch, persistence — without editing the Strategy. The daemon owns runs; the TUI only displays and collects.
- Do not copy: string-only message passing between steps, separator-join fan-in, textual break-signals (`==BUILD_APPROVED==`, substring `done` false-fires on "not done yet" — admitted by the authors), known abort gaps (daemon `stopRun` does not cancel in-flight LLM calls).

### deepseek-harness (`dsh`) — no privileged core, per-agent plugin trees
- Everything is a Cordis plugin: agent loop, tool registry, session log, and model adapter are replaceable; registrations are reversible `ctx.effect()`/`ctx.on()` effects that unwind on unload/HMR. Web, desktop, headless, SDK, and ACP profiles are the same plugin tree composed differently.
- Per-agent spatiotemporal composition: `createScope()` gives each agent a scoped context — events flow up the scope-parent chain, registrations inherit down. Presets mount a whole Loader subtree per agent with isolate realms, plus a `leakedServices()` audit for services leaking to the root realm.
- Model-visible ⟺ logged: the append-only `SessionEvent` log is the source of model history via `deriveMessages()`, and pure synchronous projections fold the same log into every UI/state view. Steering splices are logged (`agent/inbox/spliced`), so the model history and the audit history cannot diverge silently.
- Fail-closed one-shot approval: an `approval/request` waterfall of answerers (human or machine); no answerer means reject; `approval/asked` and `approval/decided` are audit-only, never model-visible. Capability seam is a Definition/Provider/Consumer triple, so subagent providers swap from in-process fork to Claude Code/Codex/ACP behind one interface.
- Do not copy: the `node:vm` dynamic Cordis runner as a security boundary (`dsh` documentation states the runner is not one — a plugin equals bash access), vendored/rescoped Cordis, waterfall listeners that silently short-circuit when `next()` is not called, approval with no allow-always and no pending-request recovery.

### jaz — harness as a language, effects as the only extension point
- Code-first REPL loop: the LLM writes Python, observes results, iterates. `invoke` is recursive — a sub-invocation is a variable inside the REPL — and inputs are live Python objects, not serialized copies (`jaz/README.md`, `src/jaz/_invoke.py`, `_subinvoke.py`).
- One uniform effect algebra: Enter/Send/Complete/Exit spans across Invoke/LLMQuery/REPLExec, with Supply/Modify/Abort effects. Replay, caching, budget pools, validation, return-typing (`ReturnType(int)`), and tracing are all hooks in that algebra, not core features.
- The copyable lesson: make every cross-cutting concern (budget, cache, replay, typed returns) a hook on a small set of uniform spans, instead of growing core options forever.
- Do not copy uncritically: Python-only, t-string console needs Python ≥3.14; live-object passing assumes a single trusted process.

### moejs — the cheap execution substrate (not an agent)
- A pure-Go JavaScript runtime for embedding: ~1.4 µs to create a runtime, ~81 KiB per runtime with the largest benchmark plugin loaded, frozen builtins shared across runtimes, every `import` routed through a host function, `eval`/`new Function` cappable or disabled (`moejs/README.md`, `runtime.go`, `engine/realm.go`).
- Host-mediated capabilities only: no timers, no network, no filesystem unless the host installs them; any goroutine can interrupt a running plugin; memory is charged per runtime with an uncatchable budget; Go↔JS values convert lazily, one level at a time.
- The transferable idea: agent-written code and agent-installed tools should run in a disposable isolate per task with host-granted capabilities and hard external budgets — the property `dsh`'s `node:vm` runner explicitly lacks.
- Do not claim: moejs has no agents, no multi-agent coordination, and no human-in-the-loop model. moejs contributes a substrate, not a collaboration design.

### oar — the provider-independent session contract
- One `Session` API drives Claude Code, Codex, Cursor, Grok, Kimi, OpenCode, Pi, Qwen, Qoder, and Antigravity. An option a runtime cannot honour is refused before anything opens (`UnsupportedOptionError`), never silently dropped (`oar/README.md`).
- One record stream per session: every fact is an `Event` with `seq` and `agentPath` (`[]` is the root, each subagent has a path); `rawEvents()`/`records()` keep native payloads verbatim; `@botiverse/oar/observe` folds records into conversation/status/tasks/stalls with no Node imports, so the same folds run in a browser.
- Honest control: `prompt`, `steer`, `queue`, `withdraw`, and `abort` answer accepted or rejected with typed codes (`busy`, `no_active_turn`, `runtime_exited`); where input landed is read from events, never guessed. `deliver` steers where the runtime can steer and queues where the runtime cannot.
- Cross-runtime crews: `createSubagents({maxRunning})` spawns other runtimes as subagents; each report wakes the waiting session via `deliver(formatReport(...), {origin})`. `openVoyage` records sessions to JSONL for later folds; `@botiverse/oar/testing` provides a scripted runtime with real `Session` semantics and no binary or login.
- Do not copy blindly: the contract is only as honest as each runtime adapter; capability matrices per runtime are permanent maintenance.

### openhuman — fleet economics
- One Rust process hosts many isolated agents (claim: 500+ agents on a $10 VPS) composed from versioned `tiny*` modules on a tinybus, instead of one heavy process per agent resending a large prompt per call (`openhuman/README.md`, `vendor/tiny*`, `crates/openhuman-*`).
- Token economics as architecture: TinyJuice CCR handles (compressed context referenced by handle, expanded on demand) and Jev deferred-tool search (tools discovered per need instead of every tool schema in every turn) cut per-turn tokens; benchmark claims are public but were not re-run here.
- Human control at fleet scale: durable parked approvals (an approval can wait without holding a turn hostage) and mid-turn steering.
- Do not copy blindly: early beta; the vendor-crate evidence in the workflow was docs/types level — re-measure fleet and token claims before adopting numbers.

## Overlaps: which implementation wins

- **Plugin composition** — alto and `dsh` both use Cordis; CommaAgents uses hook stores; jaz uses span effects. Winner: Cordis-style scoped effects for application composition (`dsh` scope/preset mechanism), jaz-style span effects inside one agent's execution. The two winners operate at different scales and do not conflict.
- **Self-modification** — alto transactional reload vs. `dsh` Creator mode dynamic runner. Winner: alto. Compile-all, hash, reconcile, roll back on failure, commit only after activation. `dsh` Creator mode is the same ambition without the transaction.
- **Event log** — `dsh` session log vs. oar record stream vs. openhuman tinybus. Winner: oar as the external contract (cross-runtime, `agentPath` attribution, raw payloads preserved, browser-safe folds), with the `dsh` rule adopted internally: model-visible ⟺ logged, projections are pure folds.
- **Human as participant** — CommaAgents Human-IS-Agent vs. `dsh` approval waterfall vs. openhuman parked approvals vs. AgentOnWeb native-TUI approvals. Winner is a composition: CommaAgents for where a human can appear (any flow step), `dsh` for how a decision is requested (fail-closed, one-shot, audit-only), openhuman for how long a decision may wait (durable, parked, recoverable — the gap `dsh` admits), AgentOnWeb for the boundary (presentation routes attention; presentation never decides).
- **Steering** — CommaAgents mailbox, `dsh` inbox splice, alto `turn/steer` with `expectedTurnId`, oar `deliver`. Winner: oar/alto typed honesty (steered vs. queued vs. rejected-stale, read back from events), recorded as a `dsh`-style logged splice.
- **Subagents** — oar crews (cross-runtime), `dsh` provider triple, CommaAgents `launch_strategy`, jaz recursive `invoke`. Winner: oar crews for delegation across runtimes; jaz recursive invoke for delegation inside one code-first agent. CommaAgents contributes the declarative unit (Strategy) that a crew spawns.
- **Sandboxed agent-written code** — moejs isolate vs. `dsh` `node:vm` vs. jaz Python REPL vs. CommaAgents guard/cwd-jail. Winner: moejs properties (disposable isolate per task, frozen builtins, host-only capabilities, external interrupt, uncatchable memory budget), regardless of implementation language.
- **Context/tool economics** — only openhuman treats token cost as architecture (CCR handles, deferred tool search). Winner by default; every other app resends large prompts and full tool schemas.

## The mega-agent, as a stack

1. **Session kernel (oar + `dsh` rule).** One append-only record stream per agent; every event carries `seq` and `agentPath`; native payloads preserved verbatim; model history derived from the log and nothing else; all UI state is a pure fold. Sessions are resumable across processes and recordable to JSONL for replay and testing.
2. **Honest control plane (oar + alto).** `prompt/steer/queue/withdraw/abort/deliver` return typed accepted/rejected answers; unsupported options refuse at open time; steering names the expected turn and fails stale. No control path guesses where input landed.
3. **Composition (CommaAgents + `dsh` scopes + jaz effects).** One `call()` contract for LLM agent, human, flow, and sub-strategy; declarative Strategies as the shareable unit; per-agent scoped plugin trees with isolate realms and leak audits; inside each agent, one span-effect algebra owns budget, caching, replay, validation, and typed returns.
4. **Delegation (oar crews + jaz invoke).** A crew spawns other runtimes/agents with a concurrency cap; reports wake the waiting session as attributed deliveries. Inside a code-first agent, sub-invocation is a first-class REPL value with live-object inputs.
5. **Execution substrate (moejs properties).** Agent-written code, agent-installed tools, and plugins run in disposable isolates: frozen builtins, host-granted capabilities only, external interrupt, uncatchable CPU/memory budgets, lazy data exchange.
6. **Fleet economics (openhuman).** Many agents per process; context passed by handle and expanded on demand; tool schemas discovered per need, not resent per turn; per-agent cost is measured and budgeted, not discovered on an invoice.
7. **Human surface (alto + AgentOnWeb).** A transactional self-modifying workspace: agents propose or apply workspace changes through compile-reconcile-rollback; the kernel, bridges, and pending approvals survive reloads; remote agents detach and reattach by journal. Ambient surfaces (browser overlay, notifications) normalize cross-agent attention — needs-approval, done, stalled — from lifecycle hooks and route the human to the exact session. The surface never approves.
8. **Decision plane (CommaAgents placement + `dsh` request + openhuman durability).** A human can be scheduled as a step, asked mid-loop, or summoned by an approval waterfall; every request is fail-closed, one-shot, audit-logged, and parkable across restarts until a human or an authorized machine answerer decides.

## Human–agent collaboration principles

- Humans are addressable participants with the same contract as agents — schedulable, askable, steerable — not an escape hatch outside the system (CommaAgents).
- Attention is a routed resource: the system computes which agent needs the human and deep-links to that exact session; the human does not poll terminals (AgentOnWeb).
- Decisions are fail-closed, attributable, and durable; an unanswered request is a parked state, never a timeout-into-approval (`dsh`, openhuman).
- Steering is honest: the human learns whether a message steered the live turn, queued for the next turn, or was rejected, from the record stream (oar, alto).
- The workspace the human sees is itself agent-editable, but only through transactions the human can inspect, accept as proposals, or roll back (alto).
- Detachment is normal: closing a laptop, a browser, or an overlay never kills work; reattachment replays a journal (alto, AgentOnWeb, oar).

## Explicit anti-patterns (present in the source set, excluded from the thesis)

- Textual break-signals and substring termination tokens (CommaAgents cycle observer).
- String-only inter-agent channels and separator-join fan-in (CommaAgents flows).
- Scraping PTY/terminal output to infer agent state (rejected by AgentOnWeb; still the default elsewhere).
- `node:vm` or in-process eval presented as a sandbox (`dsh` dynamic runner; `dsh` documentation agrees).
- Silently dropping unsupported session options (rejected by oar; common elsewhere).
- Presentation layers that can approve, answer questions under full-access, or send keystrokes on the human's behalf (rejected by AgentOnWeb and alto).
- Resending full prompt + full tool schema set every turn (every app except openhuman).
- Install-time mutation of third-party CLI config files as an integration mechanism (AgentOnWeb hooks; works, but fragile — prefer a provider contract like oar's).

## Build order

1. **Kernel first:** record stream, `agentPath` attribution, pure-fold projections, JSONL recording, scripted-runtime test double (oar shape). Everything else debugs against the kernel.
2. **Control plane:** typed honest control + refusal of unsupported options + one real runtime adapter and one scripted adapter.
3. **Composition:** unified agent/human/flow contract + declarative Strategy + span-effect hooks for budget/typed returns/replay.
4. **Decision plane:** fail-closed approval waterfall with durable parked requests and audit-only decision events.
5. **Crews:** cross-runtime subagents with report-wakes-parent delivery and concurrency caps.
6. **Substrate:** disposable isolates for agent-written code and installed tools, before any self-modification feature ships.
7. **Economics:** context-by-handle and deferred tool discovery, with per-agent token/cost accounting from the record stream.
8. **Surfaces last:** transactional self-modifying workspace, then ambient attention routing. Surfaces are replaceable; the kernel contract is not.

## Open risks / unverified

- No app in the set was executed for the thesis; maturity and benchmark numbers are static counts and published claims, not observed passes.
- openhuman fleet/token claims and moejs benchmark ratios need independent re-measurement before the mega-agent budget model relies on openhuman or moejs numbers.
- Cordis appears in alto, `dsh`, and (vendored/rescoped) inside `dsh` itself; betting the composition layer on Cordis concentrates risk in one small ecosystem. The thesis needs the Cordis properties (scoped reversible effects, isolate realms), not necessarily the Cordis library.
- Durable multi-agent coordination is the least-proven layer in every app: `dsh` agent-teams are experimental/process-local, oar crews are host-driven, CommaAgents abort semantics are incomplete. The kernel (layer 1) is where durability must be proven first.
