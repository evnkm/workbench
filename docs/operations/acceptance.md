# Acceptance record

Recorded October 4, 2026 for the first build. Versions: Node 24.21.0, Codex CLI 0.160.0, Ubuntu 26.04 (aarch64).

"Production" means the systemd services on this instance (`workbench-tmux`, `workbench-worker`, `workbench-server`) running from `~/.local/share/workbench/current`. "Dev" means the same code run by `scripts/devctl.sh` against `.workbench/` state. "Tests" means `npm test`: 56 tests using the scripted fake app-server, run with `npm run check` together with lint and typecheck. "E2E" means `e2e/handoff.e2e.mjs`, which drives Chromium (desktop and iPhone 13 emulation) against real Codex.

After the production scenarios ran, production state was reset and the temporary password removed, so the installation starts empty.

## Verification matrix

| Scenario | Expected outcome | Result | Evidence |
| --- | --- | --- | --- |
| Close browser during an agent turn | Worker continues; another device observes the same run. | Pass | E2E: the turn started on desktop, the browser closed mid-turn, and the phone opened the conversation, answered the approval, and saw the final message. |
| Reconnect during message streaming | History and live events join without omissions or duplicates. | Pass | Dev: replay after an API restart returned 13 strictly increasing events with the final answer. Tests: cursor replay, `Last-Event-ID`, and reset when a cursor is not retained. E2E: the user message appears once. |
| Restart API during a shell command | Persistent session continues and can be reattached. | Pass | Production: a shell counter kept running through `systemctl restart workbench-server`. A Codex turn running at the time finished `succeeded`. |
| Crash worker during an agent edit | Reconciled or marked interrupted; no assumed success or blind replay. | Pass | Production: `systemctl kill -s KILL workbench-worker` during a turn and a job. systemd restarted the worker, no orphaned processes remained, both runs ended `interrupted` with an explanation, the job was not retried (unknown outcome), and the shell survived. |
| Provider failure | A visible failed or interrupted run with history kept. | Pass | Production: SIGKILL of `codex app-server` mid-turn left the turn `interrupted` with the worker unaffected. Codex restarted and the next turn succeeded in the same conversation. Tests: a turn failed by Codex is recorded as failed. |
| Submit the same command twice | One accepted command and execution. | Pass | Tests: concurrent HTTP submissions with one request id store one command. Dev: a repeated `workspace.create` returned the same command and created one worktree. |
| Answer an approval from two devices | One response wins; the other reports a stale request. | Pass | Dev, real Codex: two concurrent responses produced one success and one "already answered". Tests: the same with the fake provider, plus a database-level race across two connections. |
| Launch two mutating agents in one workspace | Worker enforces the queue policy. | Pass | Dev, real Codex: the second conversation's turn queued and started when the first was interrupted. A second turn in the same conversation is refused. |
| Archive dirty workspace | Edits and untracked files survive. | Pass | Tests: modified and untracked files are intact after archive and restore. Archive is refused while turns, jobs, shells, or apps are running. |
| Start two application workspaces | Port allocation and preview routing stay independent. | Pass | Tests: distinct port blocks; an occupied reserved port is reported by name. Dev: preview proxy auth, `Host` rewrite, cookie isolation, WebSocket upgrade, and 502 after stop. |
| Stream very large output on phone | Output is bounded; navigation and composer stay usable. | Pass (bounded) | Command output is kept to the last 64 KiB per item, diffs are capped at 256 KiB with a notice, and job logs are capped per run (test: 3 MB of output truncated at 1 MB). Not measured on a physical phone. |
| Restart scheduler near a due time | One occurrence is enqueued per the missed-run policy. | Pass | Tests: two schedulers produced one run per occurrence; an occurrence 10 minutes late was recorded as "missed", not run. Dev: a minutely schedule produced one run per minute across a worker kill. |
| Reboot machine mid-job | Attempt is recoverable or visibly interrupted; retries follow policy. | Pass (simulated) | Production: stopping and starting all three units, tmux included, kept all metadata. The lost shell was recorded as exited (this found and fixed a reconcile bug). A real reboot was **not** performed. |
| Restore backup into a clean location | Durable metadata and development state are recovered. | Pass | Production backup restored to a separate directory and served on another port: project, workspace, conversation (14 items), run outcomes, and Codex state. Dev: worktree patch and untracked files captured. |
| Upgrade the application | No silent run duplication or missing history. | Pass | Production: `scripts/deploy.sh --worker` left run, item, command, and conversation counts identical and took a pre-switch backup. The resumed conversation remembered earlier context. |
| Low disk | Documented and visible. | Pass (simulated) | Dev: with the threshold forced above free space, `/api/health` and the app banner reported low disk. Retention by age and total size is tested. Filling the actual filesystem was not attempted. |
| Unauthenticated access | No commands or streams without a session. | Pass | Tests: 401 for state, commands, and events; 403 for foreign or missing `Origin` on mutations, streams, and terminal WebSockets. |

## Phase exit criteria

| Phase | Status | Notes |
| --- | --- | --- |
| 0 Integrations | Done | Codex demonstrated (decision 0002). Claude deferred by the user (decision 0003). Access is Tailscale; state is in `~/.local/share/workbench`. |
| 1 Foundation | Done, except device access | Services, migrations, IPC, idempotent commands, auth, and backup/restore are verified. Loading on a phone through Tailscale needs the node logged in (see setup). |
| 2 Workspaces | Done | Independent worktrees, duplicate-safe creation, setup retry, archive/restore, and narrow-viewport navigation. |
| 3 Codex workflow | Done | All six exit criteria were demonstrated with real Codex (E2E and dev) and with tests. |
| 4 Claude | **Pending** | Waiting for an API key (decision 0003). The UI shows Claude as unavailable with the reason. |
| 5 Changes and shells | Done, except editor handoff on a client | Status and diffs (side-by-side on wide screens, stacked on phones), persistent shells, and phone key strip. Editor links need `WORKBENCH_SSH_HOST` and have not been tried from your desktop. |
| 6 Apps and previews | Done | Previews bind to the Tailscale IP once it exists; until then, to 127.0.0.1. |
| 7 Jobs | Done | Covered by 12 tests plus production kill tests. |
| 8 Schedules | Done | Timezones and DST semantics verified. Notifications are in-app only (unread badge, filters). |
| 9 Operations | Done, with the gaps below | Deploy, rollback, backups (daily timer), restore, health monitoring, and this record. |

## Known gaps

- Real iOS Safari and Android browsers have not been tested; only Chromium device emulation was used. Check touch targets, the keyboard with the composer open, and safe areas on your own devices.
- No real machine reboot was performed.
- Backups stay on the same EBS volume; configure off-machine copies.
- Codex's sandbox modes fail on this host (AppArmor restricts user namespaces), so conversations run with full access in their worktree, with an approval policy you choose.
