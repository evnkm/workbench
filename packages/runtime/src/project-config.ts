// Per-project configuration, read from `workbench.json` in the worktree, or
// Canopy's `canopy.json` for compatibility. Project settings stored in the
// database override the file.
//
// {
//   "setup": { "command": "npm ci" },
//   "dev": { "command": "npm run dev", "port": "PORT" },
//   "ports": ["PORT", "API_PORT"],
//   "previews": [{ "name": "web", "port": "PORT", "path": "/" }]
// }
//
// Each workspace reserves a block of ports; the n-th named port is
// `portBase + n` and is exported to setup, shells, and the dev command, along
// with CONDUCTOR_PORT = portBase for projects written for Conductor.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Workspace } from "@workbench/contracts";

export type Preview = { name: string; port: string; path: string };

export type ProjectConfig = {
  source: "workbench.json" | "canopy.json" | null;
  setupCommand: string | null;
  runCommand: string | null;
  ports: string[];
  /** Env var name of the dev server's main port. */
  devPort: string | null;
  previews: Preview[];
  error: string | null;
};

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function readProjectConfig(project: Project, worktree: string): ProjectConfig {
  const cfg: ProjectConfig = {
    source: null,
    setupCommand: null,
    runCommand: null,
    ports: ["PORT"],
    devPort: "PORT",
    previews: [],
    error: null,
  };
  for (const name of ["workbench.json", "canopy.json"] as const) {
    const path = join(worktree, name);
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      cfg.source = name;
      const setup = raw.setup as { command?: unknown } | undefined;
      const dev = raw.dev as { command?: unknown; port?: unknown } | undefined;
      if (typeof setup?.command === "string") cfg.setupCommand = setup.command;
      if (typeof dev?.command === "string") cfg.runCommand = dev.command;
      if (Array.isArray(raw.ports)) {
        const ports = raw.ports.filter((p): p is string => typeof p === "string" && ENV_NAME.test(p));
        if (ports.length) cfg.ports = ports;
      }
      if (typeof dev?.port === "string" && cfg.ports.includes(dev.port)) cfg.devPort = dev.port;
      else cfg.devPort = cfg.ports[0] ?? null;
      if (Array.isArray(raw.previews)) {
        for (const p of raw.previews as Record<string, unknown>[]) {
          if (typeof p?.name === "string" && typeof p.port === "string" && cfg.ports.includes(p.port)) {
            cfg.previews.push({ name: p.name, port: p.port, path: typeof p.path === "string" ? p.path : "/" });
          }
        }
      }
    } catch (e) {
      cfg.error = `${name} is not valid JSON: ${(e as Error).message}`;
    }
    break;
  }
  if (project.setupCommand) cfg.setupCommand = project.setupCommand;
  if (project.runCommand) cfg.runCommand = project.runCommand;
  if (!cfg.previews.length && cfg.devPort) cfg.previews.push({ name: "app", port: cfg.devPort, path: "/" });
  return cfg;
}

/** Environment variables for the workspace's reserved ports. */
export function portEnv(cfg: ProjectConfig, w: Workspace): Record<string, string> {
  if (w.portBase == null) return {};
  // CONDUCTOR_PORT is what Conductor-style projects (Canopy's scripts/dev.sh)
  // derive their ports from, so their servers land inside this block.
  const env: Record<string, string> = { WORKBENCH_PORT_BASE: String(w.portBase), CONDUCTOR_PORT: String(w.portBase) };
  cfg.ports.forEach((name, i) => {
    env[name] = String(w.portBase! + i);
  });
  return env;
}

export function portFor(cfg: ProjectConfig, w: Workspace, name: string): number | null {
  const i = cfg.ports.indexOf(name);
  return i < 0 || w.portBase == null ? null : w.portBase + i;
}
