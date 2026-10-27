# Conversation titles

The Conversation Titles plugin asks the conversation's agent to maintain a short, specific title with `conversation/set_title`. It names a conversation before the first substantive response and updates the name when the main topic changes. Ordinary follow-ups should keep the existing title. This uses the current agent and does not start a separate model request.

The tool is scoped to the invoking conversation. Native Codex chats use thread metadata; local ACP chats use the saved agent-chat title. The agent must support Alto's Cordis tools and prompt context. Titles appear in conversation headers and history. Default chat tabs follow generated titles, including in Command-K search. Existing custom tab names and task names are preserved.

Explicit conversation renames pin the name. Automatic and manual writes are serialized so a concurrent manual rename wins. The plugin also preserves existing custom conversation names and stops updating a generated name if another client changes it. Ownership is saved in `.codex-cordis/conversation-titles.json`, so restarting Alto does not remove that protection. Existing unnamed conversations can receive a title on their next agent response; installing the plugin does not scan or rename old chats in bulk.

Disable Conversation Titles in the plugin settings to remove both the naming tool and its prompt guidance. Existing names remain stored with their conversations.
