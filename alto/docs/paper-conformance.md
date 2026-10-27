# Cordis paper conformance

The repository makes a deliberately narrow claim: it implements and tests the Cordis composition semantics used by this harness. It does not claim feature parity with every subsystem in DeepSeek Harness.

Run the focused proof:

```bash
npm run test:paper
```

The suite checks observable state and identity, not implementation snapshots.

| Claim | Observable proof |
| --- | --- |
| Revertible effects | A nested effect mutates external state, then disposal restores it in exact LIFO order. |
| Reactive coeffects | A consumer starts pending, activates when its provider appears, suspends when it disappears, and reactivates with the same fiber UID for a replacement provider. |
| Dependency-aware teardown | The provider lifetime nests its `provide` effect, so consumer cleanup finishes before underlying resource cleanup. |
| Isolation | Two scopes provide the same service name with different values; each consumer observes only its own realm, and removing one provider leaves the other graph active. |
| Interception | Descendant loggers observe their scope's intercepted name rather than root configuration. |
| Nested entries | A version 2 profile exposes parent IDs, depths, injection edges, provided names, isolation, and interception in the runtime snapshot. |
| Per-entry config reconciliation | Updating one provider's config reactivates only its dependent consumer; an isolated sibling graph and unrelated identity probe remain unchanged. |
| Live enable/disable | Disabling a provider tears down its effects and suspends its consumer; re-enabling it reactivates that same consumer fiber while isolated and unrelated graphs retain identity. |
| Component HMR | Replacing one provider source changes that component's load identity while unrelated components keep their identity and activation count. |
| Transaction rollback | A replacement that compiles but throws during activation restores the previous source, provider behavior, dependent graph, and unrelated fiber. |
| Browser component HMR | A content-addressed client update disposes and replaces only its browser fiber while unrelated renderers stay registered. |
| Browser teardown | Disabling a client entry removes its surface renderer, contribution interpreter, submit middleware, and owned stylesheet; enabling it remounts those effects without rebuilding the page. |
| Browser rollback | If a new browser plugin throws during activation, the previous renderer is remounted and the browser program reports a failed revision without losing the working UI. |
| Browser artifact retention | Active content-addressed bundles remain servable even when cache pruning removes older generated modules. |
| Generic client extensions | A server fiber can expose plugin state and methods through one stable channel; updating state broadcasts a new snapshot, and disposing the owner removes both the state and callable method. |
| Stable tool discovery | One app-server tool schema remains byte-for-byte stable while newly registered tools appear in `list`, become invokable, and disappear with their owner. |
| UI ownership | A fiber-owned shell, exclusive shell region, surface, contribution, and action handler all vanish when their owner is disposed. The default sidebar can be removed and replaced while the base shell retains identity. |

The key distinction is nesting. Cordis reverses disposers inside one effect; separate sibling effects may unload concurrently. Where teardown order matters, the code must represent that dependency by nesting the dependent effect. The proof suite uses that pattern explicitly.

These tests establish the local semantics under Cordis `4.0.0-rc.8` and this repository's server and browser reconcilers. They do not prove browser-engine memory reclamation, multi-process distribution, arbitrary code migration, or compatibility with future Cordis or app-server protocol versions.
