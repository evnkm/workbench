# Setup and operations

This guide covers installing Workbench on the EC2 instance, reaching it from desktop and phone, and the routine operations: deploys, backups, restores, and recovery. Decisions behind these steps are in [docs/decisions](../decisions).

## Prerequisites

These were installed in Phase 0 ([decision 0001](../decisions/0001-runtime-and-tooling.md)):

- Node.js 24.21.0 in `/opt`, with symlinks in `/usr/local/bin`.
- `build-essential`, for the `node-pty` native module.
- tmux 3.6.
- Tailscale 1.102.4.
- Codex CLI 0.160.0, logged in (`codex login status` reports a ChatGPT login).
- Docker 29 with Compose v2 (Ubuntu packages `docker.io` and `docker-compose-v2`). `ubuntu` is in the `docker` group, which projects such as Canopy use to run Postgres and Electric. Membership is effectively root access, the same as the passwordless sudo this user already has.
- Canopy's `infra/electric/compose.yaml` pins `electricsql/electric:1.7.7`, but that Docker Hub repository has been broken since 2026-09-28 (electric-sql/electric#4822). As a local workaround, `electricsql/electric-temp:1.8.1` is pulled and tagged as `electricsql/electric:1.7.7`:
  `docker pull electricsql/electric-temp:1.8.1 && docker tag electricsql/electric-temp:1.8.1 electricsql/electric:1.7.7`.
  Remove the tag (`docker rmi electricsql/electric:1.7.7`) once Canopy updates its compose file.
- mise, in `~/.local/bin`, for projects that pin their toolchains with it (Canopy installs bun 1.4.0 and node 24.20.0 through mise; the system Node is not affected).

## First install

```sh
cd ~/workbench
npm ci
npm run set-password                 # writes WORKBENCH_PASSWORD_HASH to ~/.config/workbench/env
cat .env.example >> ~/.config/workbench/env   # then edit; keep the hash line
chmod 600 ~/.config/workbench/env
scripts/deploy.sh                    # builds a release into ~/.local/share/workbench/releases
sudo cp deploy/systemd/workbench-* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now workbench-tmux workbench-worker workbench-server workbench-backup.timer
curl -s http://127.0.0.1:4310/api/health
```

The server listens only on `127.0.0.1:4310`.

## Access from desktop and phone (Tailscale)

1. Run `sudo tailscale up` and open the login URL it prints.
2. Run `sudo tailscale serve --bg --https=443 http://127.0.0.1:4310`.
3. Install Tailscale on your phone and desktop, logged into the same tailnet.
4. Open `https://<machine>.<tailnet>.ts.net` and sign in with the Workbench password.

Tailscale provides the TLS certificate. Cookies are `Secure`, `HttpOnly`, and `SameSite=Strict`. Mutations, the event stream, and terminal WebSockets also check the `Origin` header. If you reach Workbench under a second hostname, add it to `WORKBENCH_ALLOWED_ORIGINS`.

For desktop editor links, set `WORKBENCH_SSH_HOST` to the SSH host alias your desktop uses for this machine (the one Cursor Remote-SSH connects to).

## Services

| Unit | Owns | Effect of restarting it |
| --- | --- | --- |
| `workbench-tmux` | Persistent shells and application processes | **Kills every shell and app.** Only restart deliberately. |
| `workbench-worker` | Codex app-server, Git mutations, setup commands, jobs, scheduler | Active agent turns and jobs are interrupted, then reconciled on start and marked `interrupted`. They are never assumed successful. |
| `workbench-server` | HTTP API, login, event streams, terminal attachments | Browsers reconnect and replay events from their cursor. Execution is unaffected. |

Logs are structured JSON in journald: `journalctl -u workbench-worker -f`.

To check health, run `curl -s localhost:4310/api/health`. It returns 503 when the worker heartbeat is stale. The app shows a banner when the worker is not responding, when Codex is unavailable, or when the browser is reconnecting.

## Deploying

```sh
scripts/deploy.sh              # API only: safe during agent turns
scripts/deploy.sh --worker     # also restarts the worker: interrupts active turns and jobs
scripts/deploy.sh --rollback   # switch back to the previous release
```

Each deploy builds into a new release directory, type-checks it, takes a backup, and then switches the `current` symlink. Before deploying with `--worker`, check the app for active turns or jobs.

Schema migrations run automatically at startup and are additive. Rolling back the code does not undo a migration. If a release with a migration must be undone, restore the backup that the deploy took (see below).

### Upgrading Codex

The worker refuses a Codex version it was not tested against. After `codex` updates itself:

1. Rerun the probes against a disposable repository: `node probes/codex/scenarios.mjs basic|approval|interrupt|resume|kill|userinput <repo> <outDir>`.
2. Run `node scripts/generate-codex-protocol.ts`, then `npm run typecheck && npm test`.
3. Update [decision 0002](../decisions/0002-codex-app-server.md) with any behavior changes, then deploy with `--worker`.

To run an untested version anyway, temporarily set `WORKBENCH_CODEX_ALLOW_UNTESTED=1`.

## Backups

`npm run backup`, or `node scripts/backup.ts`, writes `~/.local/share/workbench/backups/<timestamp>/` and keeps the newest 7 (`WORKBENCH_BACKUP_KEEP`). Every deploy also takes a backup.

| Included | Not included |
| --- | --- |
| Application database (a consistent `VACUUM INTO` copy) | Credentials: `~/.codex/auth.json`, `~/.config/workbench/env` |
| Codex databases, session files, and `config.toml` (needed to resume threads) | Run logs and artifacts, unless you pass `--with-runs` |
| Each workspace's uncommitted tracked changes (binary patch) and untracked files | Ignored files such as `node_modules` and `.env` in worktrees |

Backups live on the same EBS volume, so they protect against mistakes but not volume loss. For off-machine copies, sync the backups directory to S3 or another host, for example with a scheduled Workbench job running `aws s3 sync`.

`workbench-backup.timer` runs the same backup daily at 03:30 UTC (`systemctl list-timers workbench-backup`). It is persistent, so a run missed while the machine was off happens at the next boot.

## Restoring

```sh
sudo systemctl stop workbench-server workbench-worker
mv ~/.local/share/workbench/workbench.sqlite{,.old}   # plus -wal/-shm if present
node scripts/restore.ts <backupDir> ~/.local/share/workbench [--codex-home ~/.codex] [--worktrees]
sudo systemctl start workbench-worker workbench-server
```

- `restore.ts` refuses to overwrite an existing database.
- `--worktrees` recreates missing worktrees from their branches, then reapplies the saved patch and untracked files. Branches must exist in the project repositories: push them, or restore the repository first.
- After restoring onto a new machine, run `codex login` and `npm run set-password`, and reinstall Tailscale.
- Runs that were active when the backup was taken come back as `interrupted` after the worker reconciles them. Review those workspaces before continuing.

## Recovery scenarios

| Scenario | What happens | What to do |
| --- | --- | --- |
| API restart or crash | The worker keeps running. Browsers show "Reconnecting" and replay missed events. | Nothing. |
| Worker crash | systemd restarts it. Active turns and jobs become `interrupted`, and pending approvals are cancelled. Shells survive. | Review interrupted turns; send a follow-up to continue the conversation. |
| Codex app-server crash | The worker restarts it with backoff. Active turns become `interrupted`, with history kept. | Same as worker crash. |
| Machine reboot | All units start on boot. Shells are gone: tmux does not survive a reboot. Turns and jobs show as `interrupted`, and jobs follow their retry policy. | Restart app processes from the Run panel. |
| Disk nearly full | Run output is capped per run, and old runs are pruned (see Retention). | `du -sh ~/.local/share/workbench/*`; delete old worktrees or backups. |

## Health monitoring

The worker reports disk and memory headroom, event-loop delay, the oldest queued job's age, active jobs, and Codex restarts. These appear in `/api/health` and in every worker status event. The app shows a banner when any of the following holds:

- free disk is below `WORKBENCH_MIN_FREE_DISK_GB` (5);
- free memory is below 5%;
- event-loop delay p99 is above 500 ms;
- a queued job is older than `WORKBENCH_MAX_QUEUE_AGE_MINUTES` (15);
- Codex has restarted three or more times.

Detailed diagnostics are in journald.

## Retention

- **Events:** pruned after `WORKBENCH_EVENT_RETENTION_DAYS` (14). Conversation history lives in item rows and is not pruned. A browser holding an older cursor receives a reset and reloads.
- **Run logs and artifacts:** removed after `WORKBENCH_RUN_RETENTION_DAYS` (30), unless pinned or the run is active. Each run's log is capped at `WORKBENCH_RUN_OUTPUT_LIMIT_MB`, and the total is capped at `WORKBENCH_RUNS_DISK_LIMIT_MB`, deleting the oldest unpinned runs first.

## Development

```sh
scripts/devctl.sh start    # worker + server on .workbench/ state, port from .workbench/env
npm run dev -w @workbench/web   # Vite on :5173, proxying /api to WORKBENCH_DEV_API
npm run check              # lint, typecheck, tests (no real Codex calls)
```

The tests use a scripted fake app-server (`apps/worker/test/fake-codex.mjs`). To test against real Codex, use the probes, which consume account usage.
