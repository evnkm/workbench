# 0005 Access, storage, and process supervision

Status: accepted, October 4, 2026 (Phase 0).

## Access

Private access through **Tailscale**, chosen by the user. Tailscale `1.102.4` is installed from the official repository. The node is not yet logged in: run `sudo tailscale up` once, then `sudo tailscale serve --bg --https=443 http://127.0.0.1:4310` to expose the API with a tailnet HTTPS certificate.

The Workbench server binds only to `127.0.0.1`. It still requires its own password login and an HTTP-only session cookie, because tailnet membership alone should not grant agent execution. Mutations and streams validate the session and the request `Origin`.

## Durable state

| Purpose | Path |
| --- | --- |
| Source checkout | `/home/ubuntu/workbench` |
| Application state and SQLite | `/home/ubuntu/.local/share/workbench` |
| Managed repositories | `/home/ubuntu/.local/share/workbench/repos` |
| Feature worktrees | `/home/ubuntu/.local/share/workbench/worktrees` |
| Run logs and artifacts | `/home/ubuntu/.local/share/workbench/runs` |
| Configuration and secrets | `/home/ubuntu/.config/workbench/env` (mode 600, outside Git) |
| Codex provider state | `/home/ubuntu/.codex` (owned by Codex; included in backups) |

The root volume is the only disk. Protection against instance or volume loss requires off-machine backups, which Phase 9 must decide. Until then, local backups protect only against application mistakes.

## Supervision

There are three systemd system units, all running as `ubuntu` so that the services share the user's Git, SSH, and Codex credentials:

- `workbench-tmux.service` owns persistent shells.
- `workbench-worker.service` owns the Codex app-server, Git mutations, and command execution.
- `workbench-server.service` owns HTTP, authentication, static assets, and SSE/WebSocket delivery.

The API talks to the worker over a Unix socket in the state directory. The units are independent: restarting the server does not restart the worker.
