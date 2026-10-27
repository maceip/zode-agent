# Alto battery investigation

September 22, 2026. Six subagents reviewed rendering, background jobs, native panes, compilation, state/storage, and the measurements and fix plan. The initial investigation was read-only; the worktree and shimmer fixes implemented afterward are recorded below.

**The initial investigation found substantial avoidable work: repeated Git scans were the largest measured cost, and continuous UI animation generated unnecessary frames. Both fixes and their follow-up measurements are recorded below.**

The measurements below came from the running development checkout, plugged into AC, during active chats and this investigation. They are CPU/rendering measurements, not a controlled idle test or a battery-discharge measurement. They cannot establish watts or hours of battery life.

**Relative impact of the proposed fixes.** Scores estimate battery-saving potential for this installation: **1–2 = minor, 3–5 = useful, 6–8 = substantial, 9–10 = dominant**. Ranges reflect workload differences and uncertainty, not measured confidence intervals or percentages. The shared power policy overlaps the other fixes; scores and savings must not be added together.

| Fix | Impact / 10 | Basis and limits |
| --- | --- | --- |
| Eliminate repeated all-worktree Git scans | **9–10** | Largest measured cost: about 3.25 CPU cores. Strongest evidence and first priority. |
| Shared hidden/battery policy for optional work | **6–9** | Can prevent hours of needless background work, chiefly by enforcing the Git and animation fixes. This is overlapping benefit, not another independent hotspot. |
| Replace perpetual working-text shimmer | **4–6** | Confirmed paint/raster work with unchanged text. Relevant whenever the working label is visible; live energy savings remain unmeasured. |
| Batch streaming Markdown and cache math/code rendering | **3–6** | Most useful during sustained streaming, particularly long tables, formulas and code fences. Little benefit between responses. |
| Pause tab spinners and subagent pulses when inactive | **2–4** | Confirmed compositor frames, but no main-thread paint in the fixture. Smaller than text shimmer; actual GPU cost remains unmeasured. |
| Publish only changed extension state | **2–4** | Avoids full-map cloning, serialization and downstream invalidation. Current live payload sizes/rates have not been measured. |
| Back off remaining remote/agent/PR polls | **2–3** | Recurring subprocess/network work, but observed non-Git child CPU was small. This score excludes Git scanning. |
| Stabilize completed-turn memoization | **1–3** | Removes repeated historical-turn calculations during streaming; existing card memoization already protects much of the content. |
| Reduce bundle duplication, inline maps and compiler work | **2–4** | Helps startup and frequent live reloads. Compiler CPU was nearly zero between builds, so steady-state impact is low. |
| Make native-pane hiding independent of animation frames | **1–4** | Plausible lifecycle problem, not a reproduced energy hotspot. Value depends on whether a hidden surface keeps doing work. |
| Simplify blur/transparency where profiling justifies it | **1–4** | Potential compositing savings; no controlled A/B measurement yet. Profile before changing the design. |
| Coalesce layout persistence during pane resizing | **1–2** | Reduces a short burst of synchronous storage and file writes, not ongoing idle work. |
| Narrow development watches and defer speculative prefetch | **1–2** | Secondary opportunities. Watchers are event-driven, and prefetch already deduplicates requests; no major idle cost was established. |

| Evidence | Result |
| --- | --- |
| Live Git subprocesses, 69-second observation | At least **225 CPU-seconds**, averaging **3.25 CPU cores**. These were Alto-owned Git processes, separate from investigation tool commands. Short-lived processes can escape sampling, so this is a lower bound. |
| Independent 45-second OS counter sample | Alto's exited child processes averaged **3.51 CPU cores** during this separate window. This corroborates the subprocess cost; do not add it to the first sample. |
| Other live processes, same 69-second observation | Main process **13%**, renderer **15%**, GPU helper **22%**, Codex server **4%**, compiler **0.03%** of one CPU core. GPU-helper CPU is not GPU utilization. |
| Existing shimmer CSS with unchanged text | An isolated Electron fixture produced **181 output frames in three seconds**; pausing the shimmer produced **zero**. It also generated paint/raster work. This proves recurring redraw, not full-screen repaint or battery cost. |

**1. Stop rescanning every worktree. Highest priority.**

The workspace refresh visits every registered project every 15 seconds and runs `git status --porcelain=v1` for every worktree. This installation has **eight projects and 52 worktrees**: roughly 68 Git launches per completed sweep, including topology and remote lookups. Single-flight refresh and four-command concurrency already exist, but neither removes the work. A native stack sample also found the process worker repeatedly launching children. Moving this work off the input thread fixed responsiveness, not energy use. [Implementation](../program/plugins/work-contexts.ts#L373)

Cache topology and remotes separately. Refresh dirty status for actively used checkouts after relevant changes, known Git operations and a return to the app. Give inactive checkouts a long fallback interval and explicit refresh. Reuse Git-support's cache and set `GIT_OPTIONAL_LOCKS=0` for background reads. Preserve an unknown/stale state on failure. Avoid replacing scans with recursive watchers across all 52 worktrees. This improvement should apply on AC too.

**2. Stop continuous decorative frames and reduce streaming work.**

The original working-text shimmer animated a text-clipped gradient, requiring fresh paint even between messages. The implemented replacement keeps the effect, using a masked transform sweep with pauses between cycles, as described below. Tab spinners and subagent pulses also kept producing compositor frames in the fixture after conversation animation was paused. Apply the same inactivity policy to all indicators. The fixture used software rendering at 60 fps; confirm savings with a live hardware trace. [Shimmer](../program/plugins/ui/default.css#L1319), [tab status](../program/plugins/thread-status.css#L22)

Streaming currently updates React and parses the unfinished Markdown tail at display refresh rate. Try 20–30 content updates per second, with immediate final completion, and benchmark tables, math and code. Stabilize completed-turn file arrays, which currently defeat turn memoization. Completed Markdown blocks are already cached; preserve that behavior. [Streaming and turn rendering](../program/plugins/ui/activity.tsx#L75)

**3. Give optional background work a shared activity and power policy.**

Closing Alto hides its window while the backend continues running. The enabled remote-workspace provider polls every ten seconds; agent reconciliation runs every 30 seconds. Slow these when nothing relevant is active, back off on failures, and refresh on demand. Suspend optional discovery when hidden or locked. Keep running agents, scheduled jobs, terminal commands, approvals and completion notifications working. [Window lifecycle](../src/desktop/main.ts#L236)

Use one policy for visibility, battery and thermal signals rather than separate timers in every plugin. Electron exposes the necessary [power events](https://www.electronjs.org/docs/latest/api/power-monitor). Native panes should also receive hidden/occluded state immediately; their current reliance on a subsequent animation frame is a code-backed risk, not a reproduced energy bug.

**4. Address state and startup overhead after the first three fixes.**

Every extension-state change clones and broadcasts the entire extension map. Publish changed keys, preserve unchanged references and suppress no-op updates. Measure the benefit before redesigning streaming transport. [Extension registry](../src/server/services/client-extension-registry.ts#L73)

The current 57 browser bundles occupy **187 MiB**, including **141 MiB of inline source maps**, with heavy libraries duplicated. External maps, shared dependencies, lazy pane code and bounded compilation should reduce startup/reload work. These are file sizes, not measured heap usage. The compiler was nearly idle; its large RSS alone does not establish a leak or current drain. [Compiler](../src/server/services/program-runtime.ts#L651)

The audit also covered disk persistence, network/backpressure, prefetch, watchers, native terminals, cached panes and blur/transparency. Pane resizing repeatedly persists the full layout; coalesce those writes as a lower-priority burst optimization. The replay journal and transport buffers are bounded. No terminal redraw loop or continuous watcher polling was established. Hidden chat subscriptions already pause; Electron background throttling remains enabled; MD pane caching is useful. Blur needs an A/B trace before changing the design. Do not disable GPU acceleration or discard cached panes as a blanket fix.

**Validation and release criteria.** Repeat five-minute visible-idle, unfocused, hidden, waiting-for-input and streaming scenarios with one versus 50 worktrees and few versus many tabs. Record the complete process tree's CPU, wakeups, disk I/O and Chromium paint/compositor frames. First targets: no recurring inactive-worktree status sweeps while hidden; no continuous decorative frames in settled idle/waiting views; unchanged historical turns do not rerender during streaming. Then repeat on battery at fixed brightness and workload, measuring actual discharge. Verify tab return, Markdown edits, queued replies, approvals, running agents and schedules still behave correctly.

Raw measurements and six detailed reviews are in `tmp/alto-battery/` in this checkout.

**Implemented afterward: worktree Git scans.** Checkout discovery now reads topology and remotes without scanning file contents. It runs every five minutes, when projects change, when the picker opens, and after Alto creates or switches a branch. The focused local checkout checks status once a minute and on return to the app, pausing while hidden or unfocused. These reads share Git Support's cache and concurrent local scan, including requests that also load remote metadata. Failed, expired and uninspected status remains unknown. Background Git reads suppress optional index locking.

In a 90-second follow-up, the main process's exited children averaged **2.09% of one CPU core**, versus **351.22%** in the earlier 45-second sample—about a **99% reduction in this measured subprocess cost**. Main-process CPU fell from 12.00% to 2.27%. These were separate active-session observations, not a controlled battery-discharge comparison; renderer/GPU costs remain outside this fix. Samples are in `tmp/alto-git-scan/`.

Validation: 51 focused Git, work-context, visibility, cache-sharing and plugin-runtime tests passed, along with type checking, the design audit and the build. An unrelated pre-existing plugin-list assertion in `tests/program-profile.test.ts` still fails because its expected list omits existing plugins.


**Implemented afterward: working-text shimmer.** Alto now moves a masked highlight over an inert copy of the rendered inline text. Opposite transforms keep the text aligned as the highlight passes. A sweep lasts one second, with three seconds of rest before the next sweep. The copy does not mount a second set of Markdown components, receive focus, enter text selection, or appear in accessibility output. Waiting for input or approval, inactive chats, and reduced motion stop the animation timers. Links, inline code, and media retain their original appearance.

An eight-second comparison using the actual new component and the original CSS produced **9 Paint operations versus 960**, and **98 output frames versus 480**. Disabling the new component's animation produced **zero frames and zero Paint operations** in the following eight seconds. The isolated Electron fixture uses software rendering at a 60 fps cap, with identical static text. These results confirm reduced rendering work, not a percentage improvement in battery life. Measurements and a visual fixture are in `tmp/alto-shimmer/`.

Validation: 88 focused Markdown, activity, waiting-state, renderer-lifetime, plugin-runtime, and browser tests passed, along with type checking, the design audit, and the build. Browser checks cover wrapped text and list geometry, highlight alignment, single-copy selection, keyboard access to links, changing text, grouped tools, reduced motion, and timer cleanup. Applying the change also exposed an agent-panel hot-reload failure: published renderers read services from a disposed plugin context. Capturing those services at registration fixed the failure; live program revision 42 activated successfully.
