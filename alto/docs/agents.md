# Agents

Agents is a view into Codex's native subagents, not a separate agent runtime.
Codex decides when to delegate and owns execution, messages, and saved history.
The plugin does not register spawn/send/wait tools, inject delegation prompts,
or maintain a second task database.

While native subagents run, the parent chat's turn pill shows small status dots.
Click the dots to see their names and statuses; click a row to inspect that
agent's history in the existing panel. Each split shows only its own descendants.
The dots can appear before the first file change and disappear when no agents
are active. An open list keeps completed rows in place until dismissed. At most
four dots are shown, followed by an overflow count, and reduced-motion settings
disable their pulse.

Turn Progress exposes an optional accessory component used by both single-chat
and split-pane renderers. Agents registers the dots through that component slot,
so disabling Agents removes the accessory without changing file/plan tracking.

The top-bar button opens a floating monitor below the pane controls. This chat
shows native descendants of the focused parent conversation, including nested
agents. All chats shows recent agents across conversations. Status comes from
native thread and collaboration events; saved turn history fills in completed
results after a reconnect.

Expand a task and choose **View history** to read its conversation inside the
same panel. Instructions, replies, and expandable thinking/tool entries use
Alto's Markdown and code renderers. Earlier messages load on demand. Inspection
uses read-only app-server requests: it never resumes the child, starts a turn,
or opens another chat pane. Back returns to the agent list.

Active tasks and unresolved failures remain visible. Completed and stopped
tasks move into a collapsed History section, limited to the ten most recent
completions in the selected scope. That limit never deletes native history.
The monitor retains up to 200 terminal task summaries in memory and reads the
100 most recently updated native descendants for each requested scope.

Notifications for recognized native children return to their parent chat,
reusing its pane if already open, and use the parent's notification tag. The
existing current-chat preference keeps them quiet while the parent is focused.

The toolbar button toggles pinned and hidden. Command-Shift-A temporarily
reveals or hides the panel without pinning it. Moving to the right edge also
reveals it; leaving or clicking outside closes the floating panel after a short
delay. Keyboard focus protects ongoing interaction. Pinning persists globally
and keeps the panel floating without moving the conversation.

Stop agent explicitly interrupts that child's current native turn, after
checking its parent relationship. Merely closing or disabling the plugin never
cancels agents. The previous experimental agents.json file is no longer read
or written; existing sessions and that file are left untouched.

Tests cover native ancestry, nested descendants, scoped history and interrupts,
pagination, live state changes, escaped Markdown, bounded caching, reload
cleanup, notification routing, and the floating panel's keyboard behavior.
