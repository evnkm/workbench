# 0004 Persistent shells with tmux

Status: accepted, October 4, 2026 (Phase 0).

## Decision

Persistent shells and application processes run in a dedicated tmux server (`tmux -L workbench`) owned by its own systemd unit, `workbench-tmux.service`, with `exit-empty off`. The worker creates and kills sessions through the tmux CLI. A browser terminal is a `node-pty` process running `tmux attach` and relaying bytes over the authenticated WebSocket.

## Evidence

- A tmux server started by a transient systemd unit owned the pane processes: their cgroup was `/system.slice/<tmux unit>.service`. Restarting the API or worker therefore cannot kill shells.
- A `node-pty` client attached, received output, and exited. The session kept running (counter advanced from 11 to 13) with no clients attached.
- `capture-pane` provides bounded replay for reattachment, and `tmux resize-window` or the attached client's size handles resizing.

## Alternatives considered

- **zmx**, as used by Canopy: not installed here, and tmux is already present and proven.
- **PTYs owned by the worker**: these die with the worker, which fails the shell exit criteria.
- **GNU screen**: available, but its scripting and capture interfaces are weaker than tmux's.
