# 0002 Codex integration through app-server

Status: accepted, October 4, 2026 (Phase 0). Tested against Codex CLI `0.160.0`, authenticated with a ChatGPT login.

## Decision

The worker owns one `codex app-server` child process over stdio (newline-delimited JSON-RPC 2.0) and multiplexes every Workbench Codex conversation through it. Protocol types are generated from the installed CLI with `codex app-server generate-ts --experimental`. If the installed version is not the one recorded in `packages/contracts`, the worker refuses to start Codex conversations until the contract probes are rerun.

The probes live in [`probes/codex`](../../probes/codex), and redacted transcripts are in [`probes/codex/samples`](../../probes/codex/samples).

## Observed protocol

Handshake: the client sends the `initialize` request (`clientInfo`, `capabilities.experimentalApi`), then the `initialized` notification.

| Capability | Method or event | Demonstrated behavior |
| --- | --- | --- |
| Start conversation | `thread/start` with `cwd`, `approvalPolicy`, `sandbox` | Returns `thread.id` (UUIDv7), the model, and the effective sandbox and approval policy. |
| Send message | `turn/start` with `threadId` and `input: [{type:"text", text, text_elements:[]}]` | Returns `turn.id` immediately; `turn/started` follows. |
| Streaming | `item/started`, `item/agentMessage/delta`, `item/completed`, `turn/diff/updated`, `turn/completed` | Item types seen: `userMessage`, `agentMessage` (`phase`: `commentary` or `final_answer`), `reasoning`, `commandExecution`, `fileChange`. Items carry `threadId` and `turnId`. |
| Thread state | `thread/status/changed` | `active` with `activeFlags` (`waitingOnApproval`, `waitingOnUserInput`), or `idle`. |
| Approval | server request `item/commandExecution/requestApproval` (also `item/fileChange/requestApproval`) | Sent with policy `untrusted`. Includes `availableDecisions`. Replying `decline` marks the item `declined`; `accept` runs it. `serverRequest/resolved` follows each reply. |
| Duplicate reply | A second response with the same JSON-RPC id | **Silently ignored.** Workbench must enforce first-response-wins itself. |
| Questions | server request `item/tool/requestUserInput` | Only available in plan collaboration mode (`turn/start.collaborationMode = {mode:"plan", settings:{model, reasoning_effort:null, developer_instructions:null}}`). Questions have `id`, `header`, `question`, `options`, `isOther`, `isSecret`; the reply is `{answers:{[id]:{answers:[...]}}}`. |
| Cancel | `turn/interrupt` with `threadId` and `turnId` | `turn/completed` with status `interrupted` arrives about 10 ms later. **The running shell command is not killed**: its `item/completed` arrived 60 s after the turn ended. |
| Stale cancel | `turn/interrupt` for a finished turn | **No response at all.** The worker must time out requests and only interrupt turns it believes are active. |
| Follow-up | `turn/start` on the same thread | Works immediately after an interrupt. |
| Resume | `thread/resume` with `excludeTurns:true`, then `thread/turns/list` with `itemsView:"full"` | Works in a fresh app-server process. History and model context are preserved. |
| Crash | SIGKILL of app-server mid-command | The child command died with it. On reload the turn reports `interrupted` with no error, and the in-flight `commandExecution` item was **not persisted**. |

## Limitations and consequences

- **The sandbox does not work on this host.** Ubuntu sets `kernel.apparmor_restrict_unprivileged_userns=1`, so Codex's bubblewrap sandbox fails (`bwrap: Operation not permitted`) under `workspace-write` and `read-only`. The user's own Codex configuration already uses `danger-full-access`. Workbench conversations default to `danger-full-access` with a selectable approval policy (`never` or `untrusted`). Enabling sandboxing would need an AppArmor profile for Codex's bwrap. That is a host security change, deferred until requested.
- Workbench records turn state from `turn/completed`, never from process liveness. Late `item/*` events for a completed turn are stored against that turn without reopening its run.
- A worker restart kills the app-server and interrupts active turns, which then show as `interrupted` after reconciliation. The app-server also supports `--listen unix://PATH`, which could decouple Codex lifetime from the worker later. That option is untested.
- MCP servers in `~/.codex/config.toml` load for every thread. The Notion server currently logs an authentication error on stderr. This is harmless, and the worker captures stderr only to its log.
- Workbench passes `ephemeral` as unset, so threads persist in `~/.codex` (provider-native session storage, which backups must include).
