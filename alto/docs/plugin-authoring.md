# Plugin authoring contract

Alto's compact application context points agents to the `alto-authoring` skill.
Before changing Alto itself, invoke `cordis_authoring_skill` through the `cordis`
dispatcher to load `program/skills/alto-authoring/SKILL.md`. The same loader works
for Codex and local ACP agents without depending on their native skill discovery.
The detailed contract and live shell snapshot are not injected into ordinary
turns. Call `cordis_runtime_status` for current slots, outlets, and contribution
IDs before choosing placement. Codex context entries stay within app-server's
4,000-byte limit, and unchanged ACP application context is deduplicated.

When replacement files are already staged, invoke `cordis_reprogram` with `files: [{ path: 'plugins/example.ts', sourcePath: 'example.ts' }]`. Describe the tool to find its staging directory, then write the replacement there with ordinary file tools. `sourcePath` is relative to that directory and is mutually exclusive with inline `content`. Alto reads the complete contents and preserves the same approval, activation, and rollback behavior. Do not edit live program files directly.

## Lifetime

`ctx.tools.register`, `ctx.ui.register`, `ctx.ui.registerSurface`, `ctx.ui.registerShellRegion`, `ctx.ui.registerShell`, `ctx.clientExtensions.registerState`, `ctx.clientExtensions.registerMethod`, and `ctx.on` create effects owned by the current fiber. Cordis removes them when that fiber unloads.

Raw resources still need an owned inverse operation. Create timers, watchers, subprocesses, and abortable requests inside `ctx.effect`, and return the cleanup. Async work must check its lifetime after every `await` before updating a registration.

```ts
const feature: HarnessPlugin = (ctx) => {
  let active = true
  const ui = ctx.ui.register(ctx, initialView)

  ctx.effect(() => {
    const timer = setInterval(() => void refresh(), 15_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, 'feature.poll')

  async function refresh(): Promise<void> {
    const next = await readState()
    if (active) ui.update(view(next))
  }
}
```

Declare `inject` and `provide` metadata. Put related fibers below a module-less parent entry when they share isolation or interception. A source or config change should target the smallest entry that owns the behavior.

For background command polling, inject `processRunner` and call
`ctx.processRunner.execFile(file, args, { timeout, signal })`. Process creation
can block Electron's input thread even with Node's asynchronous `execFile`.
This service launches commands in a worker and limits concurrency to four.
It returns UTF-8 `stdout` and `stderr`, preserves command errors, and accepts
`cwd`, `env`, and `maxBuffer`. Use a fiber-owned `AbortController` when a
request should stop as soon as its feature unloads.

Keep persistent session services separate from display components in the import graph. Shared activity and history transforms live in `ui/activity-model.ts` and `ui/history-model.ts`; importing their React views into a session service makes a display edit restart that service and its dependent panes. The composer has its own fiber so a conversation renderer replacement preserves the draft editor, focus, and selection.

## External plugin directories

Plugins that should not ship in the Alto repository can live in a separate
directory. Alto loads only directories explicitly listed in
`ALTO_PLUGIN_DIRS`; use the platform path separator when listing more than one.
Normal desktop launches can instead use the ignored local file
`.codex-cordis/plugin-directories.json`; changes to the directory list require
an Alto restart. The file contains `{"version":1,"directories":["/path/to/plugins"]}`.
Each directory contains an `alto-plugins.json` manifest whose mounts attach
entries to stable IDs in the built-in program:

```json
{
  "version": 1,
  "mounts": [
    {
      "parent": "work-contexts",
      "plugins": [
        {
          "id": "my-remote-provider",
          "name": "My Remote Provider",
          "description": "Runs selected branches on the company work service.",
          "module": "plugins/remote-provider.ts",
          "enabled": true,
          "config": {}
        }
      ]
    }
  ]
}
```

Omit `parent` to mount top-level entries. Module and client paths are relative
to the external directory and may not escape it. IDs remain global across the
composed program, so a duplicate ID or an unknown parent rejects the whole
activation and leaves the previous program running.

External directories are trusted executable code. The loader watches their
manifests and source graphs for live reload, but exposes their files under
`@external/<directory>/...` as read-only program sources. Cordis reprogramming
continues to write only inside Alto's own `program` directory.

External browser panes can obtain Alto's shared Markdown renderer with
`ctx.clientUi.component('markdown.content')`. It accepts `source`, `className`,
and an optional `label`, and follows the active code-block, math, and file-link
plugins. Declare `resources.requires.components: ['markdown.content']` on the
browser plugin so Alto can validate that dependency. This avoids importing
renderer implementation files from a particular Alto checkout.

## Browser-owned components

Do not implement feature UI in `src/client/App.tsx`. That file is the fixed mounting and recovery kernel. A visible feature gets an optional `client` entry beside its server `module`:

```json
{
  "id": "my-feature",
  "name": "My Feature",
  "description": "Explains the user-visible behavior this plugin owns.",
  "module": "plugins/my-feature.ts",
  "client": "plugins/my-feature.client.tsx",
  "enabled": true,
  "config": {}
}
```

The server half owns privileged I/O, tools, actions, and the serializable surface descriptor. The browser half owns its component, local state, keyboard shortcuts, browser effects, and feature-specific styling:

```tsx
import type { BrowserPlugin, ClientSurfaceProps } from '../../src/client/plugin-api.js'
import styles from './my-feature.css'

const client: BrowserPlugin = (ctx) => {
  const host = ctx.clientHost
  function MyFeature({ surface }: ClientSurfaceProps) {
    return <button onClick={() => void host.call('my-feature.refresh')}>{surface.label}</button>
  }

  ctx.clientUi.registerSurface(ctx, 'my-feature', MyFeature)
  ctx.clientUi.registerStyle(ctx, 'my-feature', String(styles))
}

client.inject = ['clientHost', 'clientUi']
export default client
```

Both registrations are effects owned by the browser fiber. Cordis removes the renderer, listeners returned from the plugin, and its `<style>` element before a replacement activates. Keep raw browser APIs such as observers and global listeners inside an owned effect or a React effect with cleanup. Browser modules may import React and Cordis; Node built-ins and filesystem/process work belong in the server half.

Fenced Markdown renderers use the same lifetime. Register a catch-all code renderer without `languages`, or a specialized renderer with normalized language names. Specialized renderers fall through to the next matching renderer when they unload or do not recognize the current fence:

```tsx
ctx.clientMarkdown.registerCodeBlock(ctx, {
  id: 'my-diagram',
  component: Diagram,
  languages: ['my-diagram'],
  priority: 100,
})
```

Keep parsing, asynchronous rendering, security policy, styles, and teardown in that fiber. The conversation surface only dispatches the fenced source and language through `clientMarkdown`.

Desktop browser surfaces are the one additional fixed capability. Inject `clientNativeViews`, check `available()`, and create a view from a mounted React page. Keep the returned handle in that component and call `destroy()` from its effect cleanup. Report its current `getBoundingClientRect()` through `setBounds`, hide it when an application overlay is open, and provide a normal web fallback. Only HTTP and HTTPS URLs cross this boundary. The plugin still owns the URL, placement, controls, storage, and lifecycle; the kernel only owns the sandboxed Electron primitive and persistent browser session.

`registerSurface` targets one exact descriptor ID. `registerKind` deliberately replaces the renderer for every surface of a kind in that scope. Prefer the exact form for independent features. A client-only entry is valid when it does not need server state; a server-only entry is valid for tools, turn middleware, or generic declarative contributions.

The default `UiContribution` controls are not kernel UI either. The interface fiber installs them with `registerContributionRenderer`; replacing that registration changes how every declarative contribution is rendered, and disabling its owner removes the interpreter completely.

## Data and actions across the browser boundary

The fixed browser host deliberately knows nothing about feature state. It exposes the native app-server event journal and commands as `clientHost`, plus one generic JSON call path. The default `clientSession` service that turns those events into tasks, activity cards, history, models, workspaces, and skills is itself a browser plugin. A replacement interface may inject it, replace it, or ignore it.

For new server-backed UI, register state and methods from the server fiber instead of adding a command, reducer, or field to the kernel:

```ts
const state = ctx.clientExtensions.registerState(ctx, 'my-feature', initialState)
ctx.clientExtensions.registerMethod(ctx, 'my-feature.refresh', async () => {
  const next = await refresh()
  state.update(next)
  return next
})

server.inject = ['clientExtensions', 'ui']
```

The client reads `ctx.clientHost.snapshot().snapshot?.extensions['my-feature']`, subscribes to `clientHost`, and invokes `await ctx.clientHost.call('my-feature.refresh')`. Both registrations disappear with the server fiber. Keep payloads JSON-serializable and namespace names by feature. Use native commands only for behavior that is genuinely part of the trusted app-server bridge.

Composer submission is also a browser-owned extension point. `ctx.clientUi.registerSubmitMiddleware(ctx, middleware, { activeTurn: true })` wraps the host's normal send operation and tells a compatible composer that it may accept input while a turn is running. The middleware receives the requested `queue` or `steer` mode, then either consumes the draft or calls `next(draft)`. Its registration disappears with the fiber, so disabling a queue or routing plugin restores the base idle-only send behavior without a shell change.

Compact composer buttons use `clientComposer.actions.register(ctx, { id, order, component })`.
Inject `clientComposer` and render an icon button from the registered component.
It receives `{ session }` for the composer containing it; use that session rather
than the app-wide focused session so split panes act on their own chats. The
registration and its rendered controls disappear when the owning fiber unloads.
Privileged operations still belong in a server method registered through
`clientExtensions`.

## Workspace sources

A server plugin can add a live workspace catalog without teaching the project registry about that catalog's storage format. Register names and roots together with any exact thread assignments:

```ts
const source = ctx.projects.registerSource(ctx, 'my-workspaces', {
  projects,
  threadProjectIds,
  unassignedThreadIds,
})

source.update(await loadWorkspaces())
```

The registry namespaces source-owned IDs, merges them with locally created workspaces, and uses explicit assignments before its folder and Git-worktree fallback. Source-owned workspaces are read-only in the default settings UI. The registration disappears with its fiber, so put file watchers and refresh logic in the same plugin and close them with `ctx.effect`.

## Remote work providers

Remote execution belongs in a provider plugin, not in Alto's work-context registry. A provider receives a local source checkout and returns the remote checkout that represents the same project and branch:

```ts
ctx.workContexts.registerProvider(ctx, {
  id: 'my-runner',
  label: 'My Runner',
  description: 'Runs a branch in an isolated remote checkout.',
  async createTarget({ threadId, source }) {
    const remote = await provision({ threadId, source })
    return {
      id: remote.id,
      kind: 'my-runner',
      projectId: source.projectId,
      branch: source.branch,
      label: remote.name,
      location: remote.name,
      status: remote.status,
    }
  },
})

provider.inject = ['workContexts']
```

Implement `createBranchTarget` when the provider can create a branch from a requested base reference. The registry validates that returned checkouts use the provider ID and remain in the source project, then persists the selected target per chat. The default work-target UI and the `work` dispatcher discover these capabilities from the registration; neither contains provider-specific code. Disable the provider and its operations and advertised checkouts disappear together.

## Placement

Slots are convenient insertion points, not capability boundaries. For a small additive widget, prefer a compatible slot returned by the live shell. If none matches, add a slot in the same transaction instead of borrowing an unrelated region.

Outlets are exclusive replacement points for complete shell subtrees. A region plugin owns its subtree and every surface referenced by that subtree:

```ts
ctx.ui.registerSurface(ctx, historySurface)
ctx.ui.registerShellRegion(ctx, {
  id: 'my-sidebar',
  outlet: 'sidebar',
  root: {
    type: 'box',
    role: 'aside',
    width: 'narrow',
    children: [{ type: 'surface', id: historySurface.id }],
  },
})
```

Only one region may occupy an outlet. Disable the current owner before enabling its replacement; the reconciler removes disabled entries before mounting new ones, and batches the resulting UI snapshot. Region trees may use boxes, surfaces, slots, and direct contributions, but may not contain nested outlets.

A feature may also replace or remove any live shell box, layout, theme, surface, or contribution. For exact placement, register the contribution and reference it directly from `shell-ui.ts`:

```ts
{
  type: 'contribution',
  id: 'git-widget',
  presentation: 'inline',
}
```

Directly placed contributions are removed from slot rendering automatically, so one contribution is never shown twice. Only the WebSocket/renderer recovery kernel remains fixed. Keep the default shell and regions simple and make the smallest layout change that satisfies the request; a new widget should not trigger an unrelated redesign.

| Presentation | Intended content |
| --- | --- |
| `inline` | One compact toolbar row. No contribution title, description, metric, list, group, or input. Use short text and at most one or two small actions. |
| `plain` | Page-aligned content that participates in the main flow. Groups and lists are acceptable. |
| `cards` | A self-contained panel with an optional title and description. |

Keep IDs stable and use `order` for sibling placement. Use declarative nodes and theme tones for small generic data panels. Use a browser-owned renderer and stylesheet when the behavior or appearance is feature-specific. Text in constrained regions must be disposable: shorten it first and let it truncate rather than growing the parent.

After applying a visible change, inspect it at the normal viewport and below the shell's responsive breakpoint. It must not enlarge a toolbar, cover the conversation, move the composer, or push built-in controls off-screen.

## Canvas pages

Canvas is a plugin-owned workspace pane. Workspace Layout supplies its placement, split resizing, focus, full screen, and persistence; the Canvas browser fiber owns only page tabs, page order, and project-scoped page persistence. A Canvas page plugin owns one complete tab-sized experience—not a card inside a widget board:

```tsx
import type { BrowserPlugin } from '../../src/client/plugin-api.js'
import type { CanvasPageProps } from './canvas-api.js'

function BuildStatus({ storage }: CanvasPageProps) {
  const filter = storage.read('filter', 'all')
  return <div>{filter}</div>
}

const plugin: BrowserPlugin = (ctx) => {
  ctx.clientCanvas.registerPage(ctx, {
    id: 'build-status',
    title: 'Build status',
    component: BuildStatus,
  })
}

plugin.inject = ['clientCanvas']
export default plugin
```

Put the page entry under the Canvas entry in `cordis.json`, or otherwise ensure its scope can inject `clientCanvas`. The component receives the entire active page with no imposed header, padding, layout system, or card chrome. It may implement an editor, preview, graph, dashboard, or another browser-rendered tool. Use the dedicated Browser and Terminal pane services for websites and PTYs so native resource focus and teardown remain correct. Disabling the page disposes its registration and React subtree; re-enabling it restores the page for workspaces that have not explicitly closed it. Disabling Canvas removes its pane renderer, registry, styles, and every nested page fiber together.

Pages are available in every workspace by default. For a workspace-specific page, add `availableIn: (workspace) => boolean` to the registration. Canvas evaluates it before creating or restoring the tab; the predicate receives the stable workspace key, display name, path, and optional project ID. This keeps a pinned project dashboard from appearing when the user creates a tab in another workspace.

Use the supplied storage instead of reading a project path directly. It is isolated to that page in the active workspace. Canvas can occupy any split, so page UI must tolerate its pane growing substantially wider or narrower. Size from the supplied container and use a `ResizeObserver` when behavior—not just CSS—depends on the available width.

Canvas also exposes a compact dock above its board. Dock items are browser components owned by their registering fibers:

```tsx
const plugin: BrowserPlugin = (ctx) => {
  function RefreshCanvas() {
    return <button className="canvas-dock-button" aria-label="Refresh">↻</button>
  }

  ctx.clientCanvas.registerDockItem(ctx, {
    id: 'build-status.refresh',
    component: RefreshCanvas,
    order: 100,
  })
}

plugin.inject = ['clientCanvas']
```

A dock component receives workspace-scoped storage and page actions for creating, selecting, closing, and reordering Canvas pages. Keep it to compact controls; freeform content belongs in a page component. The stock tab strip uses this same registration API and can be disabled or replaced independently.

## Browser start pages

Browser is a separate pane kind with native, persistent tabs. A feature plugin contributes a start page instead of mounting a `WebContentsView` itself:

```ts
const plugin: BrowserPlugin = (ctx) => {
  ctx.clientBrowser.registerStartPage(ctx, {
    id: 'build-status',
    title: 'Build status',
    url: 'https://status.example.com/',
    availableIn: (workspace) => workspace.name === 'payments',
  })
}

plugin.inject = ['clientBrowser']
```

The Browser fiber owns navigation, visibility, persistence, and native-view cleanup. Disabling the start-page fiber removes only its contributed tabs; unrelated browser tabs and panes remain mounted.

## Hotkeys

The default hotkey plugin provides `clientHotkeys`. Feature plugins register actions against their own fiber instead of adding key listeners to the shell:

```ts
const plugin: BrowserPlugin = (ctx) => {
  ctx.clientHotkeys.registerAction(ctx, {
    id: 'builds.toggle',
    label: 'Toggle builds',
    category: 'Panels',
    binding: { kind: 'leader', key: 'b' },
    run: () => ctx.clientBuilds.toggle(),
  })
}

plugin.inject = ['clientHotkeys', 'clientBuilds']
```

The action appears in Hotkey control and disappears when its fiber unloads. Put an integration action in a small dependent fiber when either side can be replaced independently. Cordis then suspends that action while one of its injected services is unavailable without unloading the rest of the hotkey plugin.

Nested leader chords use labeled prefixes. The leader HUD initially shows only the prefix; pressing it reveals that group's immediate children:

```ts
binding: {
  kind: 'leader',
  prefix: [{ key: 'h', label: 'History' }],
  key: 'j',
}
```

This binding runs on <kbd>Leader</kbd>, <kbd>H</kbd>, <kbd>J</kbd>. Prefixes may be nested further, and the hotkey service rejects ambiguous bindings where one action's complete sequence is another action's prefix.

Hotkeys is shortcut infrastructure, not a home for the features that use it. Harpoon owns only workspace-scoped pinned slots and its `clientHarpoon` service. The Recent Chats plugin separately owns MRU order, persistence, the Ctrl+Tab switcher, and `clientRecentChats`. Both register their own actions through `clientHotkeys`, so either feature can unload without taking Hotkey control or the other feature with it.
