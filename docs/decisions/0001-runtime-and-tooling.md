# 0001 Runtime and tooling

Status: accepted, October 4, 2026 (Phase 0).

## Observed environment

| Item | Value |
| --- | --- |
| Machine | EC2, aarch64, 2 vCPU, 15 GiB RAM, no swap |
| Disk | 123 GB root volume, 119 GB free |
| OS | Ubuntu 26.04, kernel 7.0.0-1006-aws |
| Agents | Codex CLI `0.160.0` and Claude Code `2.1.289`, both standalone binaries in `~/.local/bin` |
| Present | Git, systemd, tmux 3.6, GNU screen 4.09, Python 3 |
| Absent before Phase 0 | Node.js, npm, Bun, mise, Docker, C/C++ compiler |
| Desktop editor workflow | Cursor Remote SSH (a `~/.cursor-server` installation is present) |

## Decision

- **Node.js 24.21.0** from the official arm64 tarball, checksum-verified, installed to `/opt/node-v24.21.0-linux-arm64` with `node`, `npm`, `npx`, and `corepack` symlinked into `/usr/local/bin`. It does not touch the agent binaries in `~/.local/bin`. The version is pinned in `.node-version` and `package.json` `engines`.
- **npm workspaces** as the single package manager, because it ships with Node and avoids another global install. `package-lock.json` is committed.
- **SQLite through the built-in `node:sqlite` module** (SQLite 3.53.4 in Node 24.21.0). It needs no native addon, so Node upgrades cannot break a compiled database binding.
- **`build-essential`** (installed with apt) for the single native dependency, `node-pty`, which has no linux-arm64 prebuild. Rebuild it after any Node major upgrade with `npm rebuild node-pty`.
- TypeScript, React 19, Vite, Hono with `@hono/node-server`, `ws` for terminal WebSockets, zod for runtime validation, and Vitest. The exact versions are in `package-lock.json`.

## Consequences

- npm 11 lists dependency install scripts for approval. `node-pty` is the only package that needs its install script.
- A Node upgrade follows the same procedure: install the new tarball beside the old one, switch the symlinks, run `npm rebuild`, then run the tests.
