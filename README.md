# Zode Agent

> Durable, provider-independent agent session kernel and unified workspace.

The main project in this repository is **[mega-agent](./mega-agent)**, a consolidated full-stack agent framework synthesizing mechanisms from eight reference agent architectures into an 8-layer stack.

## Repository Structure

- **[`mega-agent/`](./mega-agent/)** — The primary project. Full-stack skeleton implementing the consolidated 8-layer agent kernel:
  1. **Session kernel** (`src/kernel/`): Append-only record stream, JSONL persistence, pure fold views.
  2. **Honest control** (`src/control/`): Typed honest steering, rejection, and runtime adaptation.
  3. **Composition & Effects** (`src/composition/`, `src/effects/`): Unified agent/human/flow contracts with effect algebra.
  4. **Delegation** (`src/crew/`): Cross-runtime subagents and crew orchestration.
  5. **Substrate** (`src/substrate/`): Disposable isolates with host-granted RPC capabilities.
  6. **Economics** (`src/economics/`): Context-by-handle (CCR) and deferred tool schema registry.
  7. **Human surface** (`src/surface/`): Transactional workspace reprogramming and ambient attention index.
  8. **Decision plane** (`src/decision/`): Fail-closed approval waterfalls and parked requests.
- **[`MEGA_AGENT_THESIS.md`](./MEGA_AGENT_THESIS.md)** — Architectural thesis, per-app evidence, overlap winners, and anti-patterns.
- **[`VENDOR.md`](./VENDOR.md)** — Upstream source repositories and commit references for vendor implementations.

### Reference Codebases

The following reference implementations are included as working vendor sources (with commit histories trimmed):
- `AgentOnWeb` — Ambient presence and attention routing
- `alto` — Self-modifying workspace (transactional Cordis plugins)
- `CommaAgents` — Unified agent/human/flow contract and declarative strategies
- `deepseek-harness` (`dsh`) — Cordis plugin trees and append-only session event logs
- `jaz` — Effect algebra and interactive Python REPL loop
- `moejs` — High-efficiency Go-embedded JavaScript runtime substrate
- `oar` — Typed honest control and crew delegation
- `openhuman` — Context compaction (CCR) and deferred tool schemas

## Getting Started with Mega-Agent

```bash
cd mega-agent
npm run demo   # end-to-end run through all eight layers
npm test       # test suite across all layers
```
