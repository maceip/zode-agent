# Remote agent chats

The `remote-agents` plugin adds backends to the **Run on** picker beside the
composer's permissions control. Choose an agent in the model menu and a location
separately. Switching location keeps the selected agent; locations that cannot
run it are disabled. Selecting a location or agent does not start a process.
The first nonempty prompt starts a separate persistent process on the selected
backend. Drafts offer Claude's model aliases, known Codex models, and model
options from connected agents. New remote Codex drafts inherit Alto's configured
model and reasoning defaults. Draft choices, including those defaults, are
checked against the new session's catalog and applied before sending the prompt.
If a choice is no longer available, the message stays in the composer and the actual options
are shown so the user can choose again.
Alto saves its exact process handle locally and reconstructs the chat
from the process's recorded input and output when the chat is reopened.

Closing a tab, quitting Alto, unloading the plugin, or losing the network only
detaches the client. The remote process keeps running. Stop sends the agent's
normal turn cancellation request; it does not delete the workstation. A question
or approval asked while disconnected appears when the client reconnects, and an
answered question remains in the transcript on later replays.

Question and approval IDs exposed to Alto are scoped by the persisted remote
session ID. The original protocol ID stays on the wire, so identical JSON-RPC
IDs from two processes cannot route a response to the wrong conversation.

This starts new remote chats. It does not move an existing local conversation.
The workspace shown in local history associates the chat with a project; agent
commands run in the remote process's working directory. The work header shows
only the branch and disables changing the local branch for a remote chat.
The composer shows the remote workspace name before sending and keeps the
actual connected workspace visible for existing chats. This is a plain label;
when no name is available, it is omitted. Resolving a draft name does not
provision a workstation or start an agent. Existing conversations
keep their location; start a new chat to change it.

## Backend contract

An external plugin injects `remoteAgents` and registers its backend with
`ctx.remoteAgents.register(ctx, backend)`. Mount it under `remote-agents` in the
external plugin manifest. The contract is in
[`remote-agent-api.ts`](../src/server/services/remote-agent-api.ts).

The backend supplies an ID, label, agent descriptors, and four operations. Its
optional `workspaceName` lookup returns a display name without provisioning or
starting anything; when given a saved process, it must use that process’s
workspace. New process handles can include the actual `workspaceName` directly:

- `create` starts a persistent process and returns its ID, remote working
  directory, and opaque non-secret connection data.
- `read` returns an ordered journal containing both stdin and stdout, plus stderr
  and process exit records. Every record has a stable cursor. `after` is exclusive;
  `follow: false` must finish after reaching the current end of the journal.
- `send` writes one JSON-RPC message to the process's stdin.
- `terminate` kills that exact process. Alto uses this to clean up a newly created
  process when its initial protocol handshake fails.

Aborting a read must detach without killing the process. Backends must preserve
input ordering and must not restart, select another agent's process, or resend a
prompt when reconnecting. Failed writes can have reached the remote process, so
Alto never retries them automatically. Recorded input determines what arrived.

Alto supplies ACP and Codex App Server protocol handling, the saved process
binding, transcript replay, request validation, reconnect backoff, and shared
chat UI. Remote infrastructure names, authentication, provisioning, retention,
and transport code belong in the backend plugin.

ACP agents expose their offered models, reasoning levels, images, plans, tool
calls, file changes, and the negotiated steering and child-agent extensions.
Codex App Server exposes models, reasoning, text, command output, file patches,
plans, usage, approvals, questions, steering, and turn interruption. Its clock
uses the remote system clock, so time requests do not depend on a connected
laptop. Native Codex children and ACP children use Alto's existing subagent
panels. Codex child transcripts, progress, completion, questions, and approvals
are reconstructed from the journal by native thread ID. Stopping a selected
active Codex child interrupts that child's exact active turn; Alto does not
offer child actions that App Server does not support.

## Boundaries

Queued prompts are saved on the laptop. They do not drain while Alto is closed,
and reopening a chat leaves its queue paused until explicitly resumed. The active
remote turn continues independently.

Remote chats do not receive Alto's laptop-side Cordis tools or local MCP bridge.
The agent can use tools and MCP servers configured on the remote host. Local file
references cannot be attached as remote paths; paste text or attach an image.

Ask relies on the selected agent's approval support. Alto explicitly switches
agents offering a bypass/manual mode pair into the selected permission mode;
Full access never answers user questions automatically. Ordinary Pi is not a
security sandbox. Provider-specific security wrappers are outside this feature.

Bindings under `.codex-cordis/remote-agents/` contain process identifiers, not
credentials. Their files are written atomically with owner-only permissions.
The remote journal is authoritative for transcript replay; the saved chat stays
visible when a reconnect fails. Deleting the workstation or exiting its agent
process ends that live session and marks all of its still-active children
stopped. A temporary connection loss leaves those children active because they
can keep running remotely. Alto preserves cached history but does not create a
replacement process silently.

## Verification

`tests/remote-agents.test.ts` exercises desktop teardown, offline parent and child
completion, repeated replay, offline questions and answers, selected-child and
parent cancellation, same-wire-ID request routing across processes, permission
mode changes, child state across disconnect and exit, and reconnect failure
without history loss. Protocol and transport tests cover thread-isolated native
App Server replay, cursor recovery, idle reconnection, and ambiguous write failures.
Backends should also test their cursor framing and process lifecycle
independently.
