// Runtime configuration shared by the server and worker. Values come from the
// environment (systemd loads ~/.config/workbench/env); see .env.example.
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  stateDir: string;
  dbPath: string;
  reposDir: string;
  worktreesDir: string;
  runsDir: string;
  backupsDir: string;
  workerSocket: string;
  host: string;
  port: number;
  /** Origins allowed to send mutations and open streams, besides same-origin requests. */
  allowedOrigins: string[];
  passwordHash: string | null;
  sessionTtlDays: number;
  secureCookies: boolean;
  webDist: string;
  tmuxSocket: string;
  codexBin: string;
  /** Inclusive range from which workspaces reserve blocks of application ports. */
  portRange: [number, number];
  portsPerWorkspace: number;
  eventRetentionDays: number;
  logLevel: "debug" | "info" | "warn" | "error";
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = env.WORKBENCH_STATE_DIR ?? join(homedir(), ".local/share/workbench");
  const [lo, hi] = (env.WORKBENCH_PORT_RANGE ?? "10000-19999").split("-").map(Number);
  return {
    stateDir,
    dbPath: join(stateDir, "workbench.sqlite"),
    reposDir: join(stateDir, "repos"),
    worktreesDir: join(stateDir, "worktrees"),
    runsDir: join(stateDir, "runs"),
    backupsDir: env.WORKBENCH_BACKUP_DIR ?? join(stateDir, "backups"),
    workerSocket: join(stateDir, "worker.sock"),
    host: env.WORKBENCH_HOST ?? "127.0.0.1",
    port: Number(env.WORKBENCH_PORT ?? 4310),
    allowedOrigins: (env.WORKBENCH_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    passwordHash: env.WORKBENCH_PASSWORD_HASH || null,
    sessionTtlDays: Number(env.WORKBENCH_SESSION_TTL_DAYS ?? 30),
    secureCookies: env.WORKBENCH_SECURE_COOKIES !== "false",
    webDist: env.WORKBENCH_WEB_DIST ?? join(import.meta.dirname, "../../../apps/web/dist"),
    tmuxSocket: env.WORKBENCH_TMUX_SOCKET ?? "workbench",
    codexBin: env.WORKBENCH_CODEX_BIN ?? "codex",
    // Below the Linux ephemeral range (32768+), so outgoing connections never
    // take an app's port. 200 ports per block fits Conductor-style projects
    // (Canopy uses CONDUCTOR_PORT + 0..3 and + 100..189).
    portRange: [lo ?? 10000, hi ?? 19999],
    portsPerWorkspace: Number(env.WORKBENCH_PORTS_PER_WORKSPACE ?? 200),
    eventRetentionDays: Number(env.WORKBENCH_EVENT_RETENTION_DAYS ?? 14),
    logLevel: (env.WORKBENCH_LOG_LEVEL as Config["logLevel"]) ?? "info",
  };
}

/** Structured JSON logs on stdout; journald captures them under systemd. */
export function createLogger(service: string, level: Config["logLevel"] = "info") {
  const order = { debug: 10, info: 20, warn: 30, error: 40 } as const;
  const emit = (lvl: keyof typeof order, msg: string, fields?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    const line: Record<string, unknown> = { t: new Date().toISOString(), level: lvl, service, msg, ...fields };
    if (fields?.err instanceof Error) line.err = { message: fields.err.message, stack: fields.err.stack };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
  };
}
export type Logger = ReturnType<typeof createLogger>;
