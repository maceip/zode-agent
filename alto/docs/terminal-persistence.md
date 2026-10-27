# Terminal persistence

**Terminal Persistence** is enabled in this profile and runs new terminal surfaces
through tmux. It is a separate Cordis extension and requires a local `tmux`
executable. Alto searches its PATH and the usual Homebrew locations; the plugin's
`executable` configuration can specify an absolute path. Disable it in Plugins
to use ordinary terminals on installations without tmux.

Ghostty still renders the terminal. The extension supplies its launch command
through `clientGhosttyTerminal.registerLauncher`; no tmux code lives in the
desktop bridge or workspace compositor. Enabling the extension leaves existing
surfaces running their current command. A raw shell cannot be moved into tmux;
open a new terminal to use persistence.

New terminals start in `~/development` when it exists, otherwise the home
directory. The Ghostty Terminal plugin's `workingDirectory` setting can override
that default. Saved tabs keep their launch directory; reattaching tmux preserves
the running shell's current directory.

Alto already persists workspace, pane, and inner terminal-tab IDs. The extension
hashes that tuple into a stable tmux session name, so moving or renaming a tab,
changing directory in its shell, and restarting Alto retain the same binding.
It also records the identity on the tmux session for inspection. Each Alto
installation's project root gets a private tmux socket namespace and generated
configuration under `.codex-cordis/tmux-terminals`. Personal tmux sessions and
configuration are separate.

Closing Alto, unloading the extension, or closing a whole workspace tab or pane
detaches its clients. Shells and jobs keep running; restoring that pane attaches
to its original session. Closing an individual inner terminal tab ends that
session. Closed panes may therefore retain running sessions even after they
leave Alto's recent-close history. Ask the agent to list saved terminals or end
one: the extension owns the `terminal/list` and `terminal/stop` Cordis tools. Stop
accepts an exact identity from the list and requires Full access. The extension
does not poll sessions or automatically kill detached jobs.

The private configuration hides the tmux status bar and disables both prefix
keys. It keeps Ghostty in its normal screen to preserve native scrolling and
selection, then replays saved scrollback before attaching to an existing
session. tmux retains up to 50,000 history lines. The shell's process, directory,
variables, running applications, and terminal screen survive a client restart.
Ghostty's selection and exact scroll offset do not. Captured history restores
text and colors, rather than every terminal-specific annotation or image.

This is local process persistence, not a process checkpoint. A machine reboot,
an exited shell, or a stopped tmux server ends that session; opening the pane
then starts a fresh shell. Laptop sleep pauses local execution. Remote terminal
hosting would need a separate transport integration.

Run the following for launcher and real-tmux checks:

```sh
npx vitest run tests/tmux-terminals.test.ts tests/terminal-workspace.test.ts tests/native-terminals.test.ts
```

The integration tests skip when tmux is unavailable. Run
`npx electron tests/fixtures/terminal-launcher.cjs` for browser lifecycle and
responsive error/retry checks. On macOS with the native addon built, run
`npx electron tests/fixtures/tmux-native.cjs` to exercise actual Ghostty surface
creation, destruction, resize, and reconnection. `ALTO_TEST_GHOSTTY_ROOT` can point
that fixture at another checkout's built addon; all test sessions use isolated
socket namespaces and are removed afterward.
