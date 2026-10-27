# Alto

![Alto with an agent conversation and a native terminal side by side](assets/alto-workspace.png)

Alto is a workspace for coding agents. Its chat views, pane layouts, commands,
and application tools are implemented as TypeScript and React plugins. An agent
can modify these plugins from an Alto conversation and apply the changes while
the application is running.

[Cordis](https://arxiv.org/pdf/2608.25512) manages plugin dependencies and
lifetime. Alto compiles and reloads the affected plugins when a change is
applied. If compilation or activation fails, it restores the previous program.

Agents connect through Agent Client Protocol (ACP) or Codex App Server. Each
agent runs its own cycle of model requests and tool calls; Alto provides the
interface, workspace context, and application tools. Chats can use separate
worktrees and run alongside native terminals, browsers, and code review in
split panes.

Alto is pre-alpha and under active development. The desktop app currently
targets macOS; browser mode supports chat and plugin development.
Tagged releases publish a portable macOS app for Apple Silicon on
[GitHub Releases](https://github.com/block/alto/releases). See the
[release process](CONTRIBUTING.md#releases) for build and signing details.

Alto is a side project at Block. For agent tools developed by dedicated teams
at Block, see [Buzz](https://github.com/block/buzz) and
[Berd](https://github.com/block/berd/).

[Get started](#get-started) · [Agent support](#agent-support) ·
[Runtime customization](#runtime-customization) · [Development](#development) · [FAQ](#faq)

## Workspace features

Chat, Terminal, Browser, and Canvas panes can be arranged in resizable splits
and grouped into workspace tabs. Conversations can be pinned or reopened from
history. Inactive panes remain mounted when you switch tabs, preserving drafts,
shells, and browser sessions.

Each chat has a working directory. You can select a project folder or an
existing worktree, or ask the agent to create a branch and open a separate chat
for it. This lets several chats work in independent checkouts. Backend plugins
can also provide remote execution targets.

The chat interface shows tool calls and approval requests. Depending on the
provider, it also supports queued messages, steering during an active turn,
and subagent progress and transcripts in the Agents panel. The Tasks panel
groups work by project and associates chats with individual tasks. The Scheduled
panel configures recurring Codex tasks, which run locally while Alto is running
or through an external scheduling provider.

You can open source files and diffs, and send inline review comments back to
chat. Code Tours pair explanations with the relevant changes. GitHub integration
shows pull requests, checks, and review status, and the Editor action opens
the current local checkout in Cursor, VS Code, or Zed.

Conversations render Markdown, highlighted code, Mermaid diagrams, and
mathematics. Linked source, Markdown, and PDF files open in viewers. Native
terminals use libghostty, and embedded browser panes open web pages within the
workspace. Plugins can use Canvas pages for custom tools and views.

## Get started

### Prerequisites

- **Node.js 22.19 or newer** and Git. `nix develop` provides Node 22 and the
  command-line build tools if you prefer the pinned development environment.
- **An agent of your choice**, installed and authenticated through its own CLI.
  [Codex CLI](https://developers.openai.com/codex/cli/) is only required for
  Codex. See [agent setup](docs/agent-providers.md#local-setup) for runtime and
  adapter configuration.
- **macOS and a full Xcode installation** for the desktop app's native Ghostty
  terminal. The Command Line Tools alone are insufficient for that build.

Clone the repository and install its dependencies:

```bash
git clone https://github.com/block/alto.git
cd alto
npm ci
```

If using Nix, enter `nix develop` after `cd alto` and before `npm ci`. Agent CLIs
and Xcode are installed separately. For Codex, run `codex login` before your
first Codex chat; Alto starts App Server when you use a Codex feature.

### Run the desktop app

Build the native terminal once, then start the development app:

```bash
npm run build:ghostty
npm run desktop:dev
```

The native build downloads pinned Ghostty and Zig sources and builds the
terminal bridge. You do not need a separate Ghostty application installed.
See the [native backend notes](native/ghostty/README.md) for build details.

To build and install `Alto.app` in `~/Applications`:

```bash
npm run install:mac-app
open ~/Applications/Alto.app
```

From a fresh checkout, the Nix path is:

```bash
nix develop
npm ci
npm run install:mac-app
```

The build downloads Electron's app bundle automatically if it is missing.
Nix supplies the command-line toolchain; full Xcode must be installed and
selected separately for the native terminal build. Network access is required
for npm packages, Electron, and the pinned Ghostty and Zig sources.

This development installation links back to your checkout, so keep the checkout
in place. Closing the macOS window keeps the workspace running; **Cmd–Q** quits
Alto and stops ordinary terminal processes.

For terminal sessions that survive an Alto restart, install `tmux`, enable
**Terminal Persistence** in Plugins, and open new terminals. This extension is
disabled by default. See [terminal persistence](docs/terminal-persistence.md)
for session ownership, shutdown behavior, and limitations.

### Run in a browser

```bash
npm run dev
```

Open the **complete URL printed in the terminal**. The default origin is
`http://127.0.0.1:4317`; the startup URL also establishes your local browser
session. `ALTO_PORT` selects a different port for browser mode.

Browser mode is useful for chat and plugin development. Native Ghostty terminals
and embedded web browsing require the desktop app. Alto is a local, single-user
application.

### Start working

Open a chat and select the agent before sending the first message. Selecting
a project sets the chat's working directory. New chats without a selected
project use `~/.alto/scratch`, which Alto creates automatically and preserves
between launches, separate from the application's program files. Reopening an
existing conversation keeps its saved working directory.

Use the split controls to place another chat or a supporting pane beside it.
Agents can also manage the workspace. For example, you can ask:

> Create a branch called docs-cleanup from origin/main and open it in a new
> chat pane to the right.

A few default macOS shortcuts:

| Shortcut | Action |
| --- | --- |
| Cmd–K | Search commands, chats, and settings |
| Cmd–D / Cmd–Shift–D | Split beside / below the focused pane |
| Option–Tab | Switch between recent workspace tabs |
| Ctrl–Tab / Ctrl–Shift–Tab | Move to the next / previous workspace tab |
| Cmd–Shift–H | Open chat history |
| Cmd–Shift–A | Toggle the Agents panel |
| Tap Option outside text inputs | Open the leader-key shortcut menu |

The leader key and its action bindings can be changed in Hotkeys. GitHub
features use the `gh` CLI; run `gh auth login` before using pull request and
check information.

## Agent support

ACP agents can connect natively or through an adapter. Configure the agent's
command and arguments in `program/cordis.json`. Each agent uses its own runtime
and authentication; Alto provides a shared chat interface, workspace context,
and application tools.

Codex connects through App Server, which gives Alto access to native history,
approvals, queued messages, steering, and subagent inspection. Alto starts
`codex app-server` on demand, so Codex CLI is only needed for Codex features.

The agent cannot be changed after a chat's first message. Available models,
attachments, steering, and session resumption depend on the provider's
capabilities. Code Tour generation and local scheduled tasks currently use
Codex.

Permission controls also follow the provider. ACP approval handling does not
add Codex's sandbox to another agent. See [agent providers](docs/agent-providers.md)
for authentication, adapter versions, capability differences, and known limits.

## Runtime customization

An agent can inspect the running program, discover its tools and UI, and submit
source changes through Alto's reprogramming tools. These changes affect the
application's own plugins under `program/`. For example, you can ask a local
agent to implement a project-specific view:

> Add a Canvas page for this project with a checklist that persists between
> sessions.

The same mechanism can add a composer action that opens project documentation,
change a chat view, or register a keyboard shortcut. Alto compiles and activates
the affected plugins in place, restoring the previous program if compilation
or activation fails.

A change made from a turn that started with **Full access** applies immediately.
**Ask** and **Auto** turns produce a proposal for approval. You can also explicitly
ask to review a change before it is applied.

The Plugins panel lists entries and their configuration, with controls to
enable or disable them. Each plugin owns its tools, UI, styles, and
registrations. [Cordis](https://github.com/cordiverse/cordis) removes these when
the plugin unloads. Transport, native integration, and recovery remain in a
fixed host so they are available while the program changes.

For source builds, the program lives in your checkout. Saved application state
uses the ignored `.codex-cordis/` directory and browser storage. Keep program
changes you want to share under version control.

### External plugins and remote work

Additional plugins can live outside the Alto repository. Each directory has an
`alto-plugins.json` manifest that declares where its entries attach to the
built-in program:

```bash
ALTO_PLUGIN_DIRS=/absolute/path/to/my-alto-plugins npm run desktop:dev
```

For launches from Finder or the Dock, configure the same directories in the
ignored local file `.codex-cordis/plugin-directories.json`, then restart Alto:

```json
{
  "version": 1,
  "directories": ["/absolute/path/to/my-alto-plugins"]
}
```

On macOS, separate multiple `ALTO_PLUGIN_DIRS` paths with `:`. External plugins
are trusted application code. Their source is watched for reloads and is
read-only through Alto's built-in reprogramming tools.

Remote execution becomes available when a plugin registers a backend. The
backend supplies authentication, provisioning, and process transport; Alto
provides chat, approvals, replay, and reconnect handling. A backend can keep
agent processes running while Alto is disconnected. See the
[remote agent contract](docs/remote-agents.md) and
[external plugin guide](docs/plugin-authoring.md#external-plugin-directories).

## Development

The feature code lives in the Cordis program. The smaller fixed host handles
processes, transport, plugin loading, native capabilities, and recovery.

| Location | Responsibility |
| --- | --- |
| [`program/cordis.json`](program/cordis.json) | Plugin hierarchy, defaults, configuration, and enabled features |
| [`program/plugins/`](program/plugins/) | Agent integrations, tools, React surfaces, styles, and workspace behavior |
| [`src/server/`](src/server/) | App Server connection, program runtime, registries, and local web gateway |
| [`src/client/`](src/client/) | Browser plugin host, transport, shell mounting, and recovery |
| [`src/desktop/`](src/desktop/) | Electron application and native capability bridges |
| [`native/ghostty/`](native/ghostty/) | macOS terminal bridge and native build |

Useful commands, after `npm ci`:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Browser development server |
| `npm run desktop:dev` | Electron app with development assets |
| `npm run build` | Client, server, and desktop preload builds |
| `npm run check` | Design-system audit, typecheck, tests, and production build |
| `npm test -- tests/todo.test.ts` | Run one test file |
| `npm run test:paper` | Focused Cordis lifecycle and composition checks |
| `npm run build:mac-release` | Build a self-contained app in `dist/mac/Alto.app` |

`nix run .#check` and `nix run .#build-ghostty` wrap the corresponding commands
with the pinned toolchain. GitHub Actions runs checks on pushes to `main` and
on pull requests. Version tags trigger the macOS Apple Silicon release workflow.

A portable release bundles its dependencies and application assets. On first
launch, it copies the mutable program into the user's Application Support
directory, so live customization can persist there. Release builds are
currently ad-hoc signed and are not notarized.

Read the [architecture](docs/architecture.md) for the runtime boundaries and
[plugin authoring guide](docs/plugin-authoring.md) for server and browser APIs,
dependency declarations, UI ownership, and cleanup. The
[Cordis conformance notes](docs/paper-conformance.md) describe the lifecycle
properties covered by the tests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, validation, and pull request
guidance. Use [GitHub issues](https://github.com/block/alto/issues) for bugs,
questions, and proposed changes. [CODEOWNERS](CODEOWNERS) lists the default
reviewer; [GOVERNANCE.md](GOVERNANCE.md) describes project governance.

## License

Alto is licensed under the [Apache License, Version 2.0](LICENSE).
See [NOTICE](NOTICE) for the original license notice retained with the imported
source.

## FAQ

### Name and design background

The name refers to the [Xerox Alto](https://en.wikipedia.org/wiki/Xerox_Alto),
the computer introduced at Xerox PARC in 1973 that helped pioneer graphical
personal computing and hosted early Smalltalk environments.

Alto takes inspiration from the ability to modify a computing environment
while using it. Here, that means changing the application's interface and
tools through reloadable plugins.

### Agent execution

The agent loop is the cycle of requesting model output, executing tool calls,
and returning their results to the model. Each connected agent harness runs
this loop. Alto communicates with it through ACP or Codex App Server and
provides workspace context and application tools. Alto does not implement an
agent loop of its own.

### Comparison with other tools

Alto's pane splitting and tabbed workspace draw inspiration from
[Zellij](https://zellij.dev/) and [Herdr](https://herdr.dev/). Its panes contain
graphical agent conversations, terminals, browsers, and custom plugin views.

| Project | What it provides | Where Alto differs |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) | A Cordis-based harness with a replaceable agent loop, model adapters, tools, UI, and live extensions. | Alto uses Cordis for its workspace and connects to existing agent harnesses through ACP or App Server. Those harnesses run the agent loop. |
| [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) | An extensible coding agent with a terminal interface, RPC mode, and a TypeScript SDK. | Alto provides a graphical interface for connected agents, with split chats, native terminals, browsers, worktrees, and code review. |
| [Claude Mods](https://code.claude.com/docs/en/plugins/mods/overview) | JavaScript or TypeScript hooks inside Claude Code that can change tool behavior and draw or restyle UI in supported Claude interfaces. | Alto plugins implement a separate workspace used across agent providers, including its chat views, panes, shortcuts, and application tools. |
| [Codex Plugins](https://developers.openai.com/plugins/concepts/plugins) | Installable bundles of skills, MCP tools, integrations, and lifecycle hooks, with optional UI on supported surfaces. | Alto's Cordis plugins implement and modify the workspace application itself, including its chat interface and pane layout. |
| [Zellij](https://zellij.dev/documentation/creating-a-layout.html) | A terminal workspace with split panes, tabs, reusable layouts, and plugins. | Alto uses a similar pane model for graphical agent conversations, native terminals, browser pages, and React views. |
| [Herdr](https://herdr.dev/docs/concepts/) | A terminal workspace for multiple coding agents, with split panes, agent status, and persistent sessions. Each agent runs in its own terminal. | Alto renders structured conversations and approvals through ACP or App Server, alongside browsers, code review, and native terminals. |

Provider capabilities and current integration limits are listed under
[Agent support](#agent-support).
