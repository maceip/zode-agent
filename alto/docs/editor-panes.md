# Editor panes

Command-E opens or focuses a Neovim pane for the current chat's local checkout.
The composer **Editor** button also opens a pane by default. In **Settings →
Editor**, set **Editor button** to **External editor** to open the selected
Cursor, Visual Studio Code, or Zed application in a new window. This preference
does not change Command-E.

The pane runs the installed `nvim` with the user's normal configuration, starting
in the checkout and opening its directory. The Neovim Editor plugin's optional
`executable` configuration accepts an absolute path to a different Neovim binary.
A missing executable or checkout produces a retryable error in the pane.

Clicking a Rust or other source-file link opens it in an existing editor for the
chat's checkout, preferring a pane in the same Alto tab. If the file is already
visible in Neovim, Alto focuses that window; otherwise it opens a new Neovim tab.
Citations jump to their line and column. Existing tabs and unsaved buffers remain
intact. When no matching editor is open, links use the source viewer. Rendered
Markdown, PDF links, and explicit diff-review actions retain their viewers.

The Editor File Links plugin connects to the running process's default
[Neovim RPC socket](https://neovim.io/doc/user/api/), found through its exact tmux
terminal identity. It uses the existing process, including editors started
before this feature was enabled. Paths and coordinates are passed as data;
Alto does not type commands into the terminal or write buffers. This integration
currently requires Terminal Persistence and macOS. Connection and file errors
appear in the editor pane.

With Terminal Persistence enabled, editor state belongs to the checkout rather
than to the pane. Closing and reopening a pane, opening it from another Alto tab,
or restarting Alto reattaches the same tmux-hosted Neovim process. Open tabs,
buffers, cursor state, and unsaved edits remain in that process. Separate
worktrees have separate editor sessions. Quitting Neovim, stopping its saved
terminal, or rebooting the machine ends the process; the next launch starts a
new editor. This is process persistence, not a disk backup of unsaved buffers.

The Option-Tab switcher and pane picker leave the native editor visible around
the popup. Popup input is kept out of Neovim, and dismissing it restores editor
focus. This needs the updated native bridge, so an already-running Alto must be
relaunched after installing the change.

Native editor panes currently use Alto's macOS Ghostty backend. Remote editor
transport and ACP buffer integration are not included.

Run the focused checks with:

```sh
npx vitest run tests/editor-pane.test.ts tests/open-in-ide.test.ts
```

On a Mac with the native addon, Neovim, and tmux installed, the native fixture
verifies a new pane and tab can restore the same process, two Neovim tabs, and an
unsaved buffer. It also checks native resizing and source-link navigation,
including quoted filenames, line and column jumps, and reuse of existing tabs:

```sh
node_modules/.bin/electron tests/fixtures/editor-pane-native.cjs
```
