# 0006 Workspace archive, processes, and previews

Status: accepted, October 4, 2026 (Phases 2, 5, and 6).

## Archive policy

Archiving never touches the worktree. The branch, the worktree directory, uncommitted changes, and untracked files all stay on disk. Archive hides the workspace from navigation and releases its port block; restore re-reserves a block and checks the worktree is still present.

Archive is refused while an agent turn, setup command, job, shell, or app is running in the workspace. Automatic checkpoint-and-remove is deferred, because the retain-in-place approach cannot lose work and has been tested (`apps/worker/test/workspaces.test.ts`). Deleting worktrees is left to the user.

## Project configuration

Workbench reads `workbench.json` from the worktree, falling back to Canopy's `canopy.json` so existing repositories work unchanged. It uses `setup.command`, `dev.command`, `dev.port`, `ports`, and `previews`. A setup or run command saved in project settings overrides the file.

Each workspace reserves a block of `WORKBENCH_PORTS_PER_WORKSPACE` ports (default 200) from `WORKBENCH_PORT_RANGE` (default 10000–19999, below Linux's ephemeral range starting at 32768). The n-th named port is `portBase + n`, exported as that environment variable to setup, shells, and the dev command. `CONDUCTOR_PORT` is also set to `portBase`, so Conductor-style projects derive their ports inside the block. Canopy's `scripts/dev.sh` uses `CONDUCTOR_PORT` + 0–3 (control, Vite, Postgres, Electric) and + 100–189 (devbox workspaces), which is why blocks are 200 ports. New blocks never overlap existing ones, even ones allocated under an older block size.

*Revised October 4, 2026:* the original defaults (10-port blocks in 41000–41999) collided with Canopy's port layout and sat inside the ephemeral range.

The reservation is unique in the database, but a reservation is not a guarantee. `app.start` probes every reserved port and fails with the name of the busy one.

## Processes

Shells and the dev command are tmux sessions in the `workbench-tmux` unit (see [decision 0004](0004-shell-persistence.md)). App output is copied with `tee` to `runs/<processId>/output.log` for the Run panel. Because of this, the app's stdout is a pipe rather than a TTY; stdin is still the terminal.

With `remain-on-exit`, the worker reads each exit status. A finished shell's session is removed. A finished app keeps its last screen until the next start.

Stopping an agent turn never stops processes, and stopping a process never affects a turn.

## Previews

A path-prefix proxy on the Workbench origin breaks most dev servers, which use absolute asset paths and HMR URLs. It would also share cookies with Workbench. Instead, each preview gets its own origin:

- The API opens a proxy listener on `appPort + WORKBENCH_PREVIEW_OFFSET` (default 10000, so previews use 20000–29999, outside the app range) when a preview is first requested, and closes it once no running app owns the target.
- The listener binds to the Tailscale IPv4 address when present, otherwise to `127.0.0.1` (override with `WORKBENCH_PREVIEW_HOST`). It is not exposed on the public interface.
- It proxies only ports inside the block of a workspace with a running app. There is no arbitrary target.
- The authenticated app issues a link with an HMAC token that is valid for 2 minutes. The proxy exchanges it for an `HttpOnly` per-port cookie (12 hours), strips that cookie before forwarding, and passes the app's own cookies through.
- `Host` is rewritten to `localhost:<port>` so dev-server host checks (for example Vite's `allowedHosts`) accept requests. `X-Forwarded-Host` carries the original.
- WebSocket upgrades (HMR) are proxied after the same cookie check.
- Dev servers that serve HTTPS with a self-signed certificate (for example Vite with `plugin-basic-ssl`, as Canopy uses) are detected by a TLS handshake and proxied over TLS, with no certificate verification because the connection is to 127.0.0.1 only. The result is cached for 30 seconds per port. Tested in `apps/server/test/previews.test.ts`.

Preview origins use plain HTTP inside the tailnet, where WireGuard encrypts the traffic. Browsers treat them as insecure contexts, so features that require HTTPS are unavailable in previews. The alternative is `tailscale serve --https=<port>` per preview, which needs root and per-port setup; this is deferred until a project needs it.

Verified with a demo app (`.workbench` dev state):

- An unauthenticated preview request returned 401.
- The signed link returned a 302 that set the cookie.
- Proxied requests reached the app with `Host: localhost:41000`, with the Workbench cookie stripped and app cookies passing through.
- A WebSocket upgrade echoed data.
- After stop, the preview returned 502.
