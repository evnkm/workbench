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

Drag photos from Finder anywhere onto an open conversation, paste an image into
the message box, or use the paperclip button. Workbench uploads PNG, JPEG, GIF,
and WebP files (up to 20 MiB each) and adds their server paths to your draft.
Send the message to share those paths with Claude or Codex. Files live in
`~/.local/share/workbench/media`, survive restarts, and are included in backups.

Use the X on a conversation tab to delete its history. Active or queued runs must
be stopped first. Deletion syncs to other browsers; job execution history and
artifacts are retained independently of the conversation.

Type `/` at the start of the message box for a searchable command menu on desktop
or phone. Select with the arrow keys and Enter/Tab, or tap an option; Escape closes
the menu. `/model`, `/reasoning`, `/fast`, and `/permissions` save conversation
settings for subsequent turns. Model choices, reasoning efforts, and Fast tiers
come from the connected Codex account. `/review`, `/compact`, and `/fork` use native
Codex operations; other commands open workspace tools, session information, or
skill/app pickers. Commands requiring the terminal, IDE, or a feature Workbench
does not yet integrate explain their availability rather than being sent as prompts.
Paths such as `/home/ubuntu/project` remain ordinary message text.

Claude conversations use the Agent SDK with the installed Claude CLI and your
local claude.ai subscription login. They support streamed messages and tools, approvals, user questions,
Plan mode, cancellation, and resuming saved sessions. Claude loads user, project,
and local settings, including project instructions, skills, and MCP configuration.
Its command menu offers supported Workbench controls; `/model` accepts a model ID
or alias. Follow-up messages wait for the next Claude turn.

Claude's subagents, background shells, and monitors appear as cards in the
transcript and, while running, in a task list above the message box, where each
can be stopped individually. A turn stays open until its background tasks end,
and their completion notifications continue it, as in the terminal.

Independent conversations can run concurrently in the same worktree, including
Claude alongside Codex. Only messages within one conversation queue. Agents receive
coordination instructions and a live command to inspect other sessions' tasks and
recent tools; the composer also shows when other sessions share the worktree.
Coordination is advisory: use distinct files, preserve each other's changes, and
use separate worktrees for conflicting edits. Full-access tools cannot guarantee
isolation inside a shared filesystem.

While Codex is working, use **Queue message** (or Enter on desktop) to submit
follow-ups. They are stored on the server and delivered in order into the live Codex turn
as soon as a tool call finishes, using native `turn/steer`. If the turn ends
first, unsent messages become subsequent turns. Plan-mode changes and reviews
remain subsequent turns because native steering cannot change turn settings.
Confirmed messages appear in the live turn’s transcript. Ambiguous delivery
after a restart is shown as failed with the message retained, rather than
resending something Codex may already have received. The pending list above the
message box lets you remove unsent messages; Stop interrupts the current turn.

Open the bell beside Appearance on desktop or in the phone header for
**Turn notifications**. Enable a completion chime, device notifications, or both;
use the test buttons to check this browser. Push notifications arrive even when
Workbench is closed and open the corresponding conversation when tapped.
Device notification delivery is tied to the signed-in session and stops on logout
or session expiry. Settings and permission are specific to each device. On iPhone
and iPad (iOS 16.4+), add Workbench to the Home Screen and enable notifications in
that installed app. HTTPS is required outside localhost.

Completion push deliveries are committed with run transitions and sent by the
API from a durable outbox. VAPID identity lives in `push-keys.json` under the state
directory and is included in backups. The push-only service worker never caches
conversation data or authenticated pages.

Open **Mini-apps** in the navigation for tools that run independently of coding
conversations. Rolodex is the first: describe people and their relationships in
the draggable chat pill, then explore the live 3D graph or searchable person cards.
Possible name matches show existing cards and require confirmation before any
changes from that note are committed. You can match an existing person, create
a separate person with the same name, or cancel the note. Corrections preserve
unrelated facts; explicit name corrections retain the old name as an alias.

Pokerbot tracks bot development for Sequoia's No Limit tournament: experiments,
bots, logged matches, a reading list of algorithms, and the 60-minute build plan.
A match records each seat's net chips (zero-sum, checked on save) and optionally
its per-hand standard deviation; results are shown in mbb/hand at the event's
50/100 blinds, pooled per pairing, and greyed while inside their 95% interval.
Bots and experiments that matches refer to cannot be deleted; retire a bot instead.

Mini-apps run in `workbench-miniapps.service` on loopback port 4312 behind
Workbench's authenticated `/api/apps/*` proxy, which allows each app's routes
explicitly. The host uses its own local credential and keeps each app's state in
its own SQLite file under `miniapps/<app>/` in the Workbench state directory. Backups include each mini-app's SQLite database through
SQLite's online backup mechanism. API restarts and coding-session restarts do not
stop mini-app work. Interrupted extraction is retained visibly for retry.

Rolodex uses the installed `codex exec` or `claude -p` with structured output and
no enrichment APIs. Notes, history, and graph data are stored locally; submitted
notes, relevant conversation history, and the current network are sent to the
selected AI provider for interpretation. This is not fully offline inference.
The agent proposes structured changes and cannot directly write the app database.
Graph updates are committed in one transaction and streamed to open browsers.

To build another mini-app in a coding session, add its own module and SQLite store
under `apps/miniapps/src`, mount its local routes, explicitly allow its authenticated
proxy paths in `apps/server/src/app.ts`, and add its gallery entry/view in
`MiniAppsView.tsx`. Keep each app's state in its own subdirectory under `miniapps/`;
files ending in `.sqlite` are picked up by the backup process automatically.

It started from [the phased implementation plan](IMPLEMENTATION_PLAN.md) and reuses design and workspace ideas from [Canopy](../canopy) (see [NOTICE](NOTICE)).

## Status

Phases 0–3 and 5–9 are implemented and verified; see the [acceptance record](docs/operations/acceptance.md). Claude conversations use the local subscription login ([decision 0003](docs/decisions/0003-claude-agent-sdk.md)).

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
npm run check                 # lint, typecheck, tests (no real Codex usage)
scripts/devctl.sh start       # dev worker and server on .workbench/ state (see .workbench/env)
npm run dev -w @workbench/web # Vite on :5173; set WORKBENCH_DEV_API to the dev server
```

To check rich conversation rendering against a running UI without real Codex calls,
run `node e2e/rich-content.e2e.mjs` (or set `B` to the UI's development URL).
`node e2e/conversation-deletion.e2e.mjs` checks tab deletion and cross-browser
updates on desktop and mobile using disposable API fixtures.
`node e2e/slash-commands.e2e.mjs` checks command completion, settings, and active-turn
behavior on both layouts without real Codex calls.

Operations (deploys, backups, restores, recovery, Codex upgrades) are described in [docs/operations/setup.md](docs/operations/setup.md).
