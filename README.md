# Workbench

Workbench is a personal development platform for an always-on EC2 instance, used from desktop and phone. It organizes projects into feature workspaces, each a Git worktree, and provides:

- readable Codex conversations with approvals and questions;
- persistent shells and application processes with previews;
- the authoritative Git diff of each workspace;
- durable background jobs and schedules.

Work continues on the server when the browser closes; open it again from any device.

Choose System, Dark, or Light from Appearance at the bottom of the desktop sidebar
or the theme dropdown in the phone header. The preference is saved in that browser;
System follows the device's appearance, including changes while Workbench is open.

Conversations render fenced Mermaid diagrams and Markdown images, including local
screenshots. Codex image-view, image-generation, and tool-image results appear inline.
Local images are retained with conversation state and included in backups; click an
image to open it at full size. Diagrams follow the current appearance and expose their
source when rendering fails.

It started from [the phased implementation plan](IMPLEMENTATION_PLAN.md) and reuses design and workspace ideas from [Canopy](../canopy) (see [NOTICE](NOTICE)).

## Status

Phases 0–3 and 5–9 are implemented and verified; see the [acceptance record](docs/operations/acceptance.md). Phase 4 (Claude) is pending until an API key is provided ([decision 0003](docs/decisions/0003-claude-agent-sdk.md)).

The services run under systemd on this machine and listen on `127.0.0.1:4310`. Before first use:

1. `npm run set-password`, then `sudo systemctl restart workbench-server`.
2. `sudo tailscale up`, then `sudo tailscale serve --bg --https=443 http://127.0.0.1:4310`, and open the `ts.net` address on your devices.

## Layout

```text
apps/web        React + Vite UI (desktop panes, phone views)
apps/server     Hono API: auth, commands, snapshot + SSE replay, terminals, previews
apps/worker     Codex provider, workspaces, shells/apps (tmux), jobs, scheduler
packages/contracts  Shared types and validated command schemas
packages/db         SQLite (node:sqlite) schema, migrations, queries
packages/runtime    Git, project config, schedules (Node-only helpers)
deploy/         systemd units and tmux config
scripts/        deploy, backup, restore, set-password, protocol generation, dev control
probes/codex    Phase 0 app-server probes and redacted transcripts
e2e/            Real-Codex browser test (desktop-to-phone handoff)
docs/decisions  Architecture decisions with evidence
docs/operations Setup, operations, and the acceptance record
```

## Development

```sh
npm ci
npm run check                 # lint, typecheck, 56 tests (no real Codex usage)
scripts/devctl.sh start       # dev worker and server on .workbench/ state (see .workbench/env)
npm run dev -w @workbench/web # Vite on :5173; set WORKBENCH_DEV_API to the dev server
```

To check rich conversation rendering against a running UI without real Codex calls,
run `node e2e/rich-content.e2e.mjs` (or set `B` to the UI's development URL).

Operations (deploys, backups, restores, recovery, Codex upgrades) are described in [docs/operations/setup.md](docs/operations/setup.md).
