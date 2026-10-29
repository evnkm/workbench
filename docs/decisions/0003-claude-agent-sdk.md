# 0003 Claude Agent SDK integration

Status: implemented October 10, 2026; subscription authentication verified live.

## Decision

Use the pinned `@anthropic-ai/claude-agent-sdk` 0.3.289 release with the installed
Claude CLI and its local claude.ai subscription login, explicitly requested by
the user. Startup checks `claude auth status --json` for a first-party claude.ai
login. Both the check and SDK subprocess strip inherited API keys, bearer tokens,
setup tokens, Anthropic profiles, and cloud-provider flags. Invocation settings
pin `forceLoginMethod` to `claudeai`, rejecting conflicting authentication rather
than switching billing paths. Credentials remain owned by Claude's local store.

Anthropic's [current subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
confirms the Agent SDK and third-party apps can use subscription limits. This
supersedes the original API-key-only decision. Usage shares the user's Claude
subscription allowance.

Each turn owns an SDK subprocess and resumes the conversation's durable session
ID. A final SDK result confirms success. Process loss or worker restart leaves an
interrupted outcome rather than replaying possibly completed mutations. Browser
and API disconnects do not interrupt execution.

Subagents, background shells, and monitors belong to that subprocess. A one-shot
string prompt closes the CLI's input once it goes idle, which kills them seconds
after the reply, so the provider streams input and keeps the process open. The
turn ends at an `idle` session state with no live non-ambient background tasks;
a result alone is not the end, because a task's completion notification starts
another model turn whose result decides the outcome. Task events persist as
`task` items, and `task.stop` forwards the SDK's per-task stop. Follow-up
messages queue until the turn, including its background work, ends.

Load the Claude Code system-prompt preset and user, project, and local setting
sources explicitly. This enables project `CLAUDE.md`, skills, and configured MCP
servers instead of relying on SDK defaults. Workbench appends shared-worktree
coordination instructions to that preset.

Approvals and `AskUserQuestion` use the existing durable pending-input protocol.
Never ask auto-allows permission callbacks but still asks user questions;
on-request follows Claude's permission requests. Untrusted forces approval for
shell and file-edit tools through PreToolUse hooks. Plan mode uses the SDK's plan
permission mode. Answers resolve once and are cancelled when their process ends.

Conversations run independently in a shared worktree. Their individual message
queues preserve order. Both providers receive a read-only live session-discovery
command and guidance to avoid overlapping edits and broad Git mutations.
Coordination is advisory, not filesystem isolation; separate worktrees are the
appropriate boundary for conflicting edits.

Codex-specific inspection, reasoning tiers, review, fork, and compaction controls
are excluded from Claude's Workbench menu and rejected at the worker boundary.
Unknown Claude slash commands reach the SDK as prompts for project skills.

## Verification

Local tests exercise streamed and completed message deduplication, tool results,
session resume, configuration options, approvals, questions, interruption,
provider failure, restarts, and concurrent Claude/Codex conversations. A live
Haiku turn verifies the existing Max subscription login, no API-key source, a
completed reply, and a durable session ID. Project configuration loading and
other account models still require their own live acceptance scenarios.

Authentication follows [Anthropic's Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview).
