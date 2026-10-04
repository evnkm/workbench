// Persistent shells and application processes, each a tmux session owned by
// the tmux unit, so they outlive API and worker restarts. The worker records
// their lifecycle; the API attaches browser terminals directly.
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { nowIso, type ProcessSession, uuidv7, type Workspace } from "@workbench/contracts";
import { getProject, getWorkspace, listProcesses, saveProcess } from "@workbench/db";
import { portEnv, portFor, readProjectConfig } from "@workbench/runtime";
import { CommandError, type Handlers } from "./commands.ts";
import type { WorkerContext } from "./context.ts";
import { Tmux } from "./tmux.ts";

const RUNNING = new Set(["starting", "running"]);

export function portFree(port: number): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRNOTAVAIL"));
      srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
    });
  // Sequential: probing both addresses at once would collide with itself.
  return tryHost("127.0.0.1").then((ok) => ok && tryHost("0.0.0.0"));
}

export class Processes {
  private readonly ctx: WorkerContext;
  readonly tmux: Tmux;
  private timer: NodeJS.Timeout | null = null;

  constructor(ctx: WorkerContext) {
    this.ctx = ctx;
    this.tmux = new Tmux(ctx.config.tmuxSocket, ctx.log);
  }

  handlers(): Handlers {
    return {
      "shell.create": { key: (p) => `processes:${p.workspaceId}`, run: (p) => this.createShell(p.workspaceId, p.name) },
      "shell.kill": { key: (p) => `process:${p.processId}`, run: (p) => this.stop(p.processId, "shell") },
      "app.start": { key: (p) => `processes:${p.workspaceId}`, run: (p) => this.startApp(p.workspaceId) },
      "app.stop": { key: (p) => `process:${p.processId}`, run: (p) => this.stop(p.processId, "app") },
    };
  }

  /** Archive guard: refuse while shells or apps are running in the workspace. */
  archiveBlocker = (workspaceId: string): string | null => {
    const live = listProcesses(this.ctx.db).filter((p) => p.workspaceId === workspaceId && RUNNING.has(p.state));
    if (!live.length) return null;
    return `Stop its running ${live.map((p) => (p.kind === "app" ? "app" : `shell "${p.name}"`)).join(", ")} before archiving.`;
  };

  private requireWorkspace(id: string): Workspace {
    const w = getWorkspace(this.ctx.db, id);
    if (!w) throw new CommandError("Workspace not found.");
    if (w.state !== "ready" && w.state !== "setup_failed")
      throw new CommandError(`The workspace is ${w.state.replace("_", " ")}.`);
    return w;
  }

  private env(w: Workspace) {
    const project = getProject(this.ctx.db, w.projectId)!;
    const cfg = readProjectConfig(project, w.worktreePath);
    return { cfg, env: { ...portEnv(cfg, w), WORKBENCH_WORKSPACE: w.name } };
  }

  async createShell(workspaceId: string, name?: string) {
    const w = this.requireWorkspace(workspaceId);
    const existing = listProcesses(this.ctx.db).filter((p) => p.workspaceId === w.id && p.kind === "shell");
    const id = uuidv7();
    const now = nowIso();
    const session: ProcessSession = {
      id,
      workspaceId: w.id,
      kind: "shell",
      name: name?.trim() || `Shell ${existing.length + 1}`,
      command: null,
      cwd: w.worktreePath,
      tmuxSession: `wb-sh-${id.slice(-12)}`,
      state: "running",
      exitCode: null,
      port: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
    await this.tmux.newSession(session.tmuxSession, w.worktreePath, this.env(w).env);
    saveProcess(this.ctx.db, session);
    this.ctx.published();
    return { processId: id };
  }

  async startApp(workspaceId: string) {
    const w = this.requireWorkspace(workspaceId);
    const apps = listProcesses(this.ctx.db).filter((p) => p.workspaceId === w.id && p.kind === "app");
    if (apps.some((p) => RUNNING.has(p.state))) throw new CommandError("The app is already running in this workspace.");
    // Earlier runs keep their final screen until the next start.
    for (const old of apps) await this.tmux.kill(old.tmuxSession);
    const { cfg, env } = this.env(w);
    if (cfg.error) throw new CommandError(cfg.error);
    if (!cfg.runCommand) {
      throw new CommandError(
        "No dev command is configured. Add dev.command to workbench.json or set a run command for the project.",
      );
    }
    // A reservation is not a guarantee: check every reserved port right before launch.
    for (const name of cfg.ports) {
      const port = portFor(cfg, w, name);
      if (port != null && !(await portFree(port))) {
        throw new CommandError(`Port ${port} (${name}) is already in use by another process. Stop it, then retry.`);
      }
    }
    const id = uuidv7();
    const dir = join(this.ctx.config.runsDir, id);
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "output.log");
    const now = nowIso();
    const session: ProcessSession = {
      id,
      workspaceId: w.id,
      kind: "app",
      name: "App",
      command: cfg.runCommand,
      cwd: w.worktreePath,
      tmuxSession: `wb-app-${id.slice(-12)}`,
      state: "running",
      exitCode: null,
      port: cfg.devPort ? portFor(cfg, w, cfg.devPort) : null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
    // Output goes to the terminal and, through tee, to a log the Run panel reads.
    const wrapper = `bash -c 'exec > >(tee -a "$WB_LOG") 2>&1; echo "$ $WB_CMD"; exec bash -lc "$WB_CMD"'`;
    await this.tmux.newSession(
      session.tmuxSession,
      w.worktreePath,
      { ...env, WB_CMD: cfg.runCommand, WB_LOG: log },
      wrapper,
    );
    saveProcess(this.ctx.db, session);
    this.ctx.published();
    return { processId: id, port: session.port };
  }

  async stop(processId: string, kind: "shell" | "app") {
    const p = listProcesses(this.ctx.db).find((x) => x.id === processId && x.kind === kind);
    if (!p) throw new CommandError("Process not found.");
    await this.tmux.kill(p.tmuxSession);
    if (RUNNING.has(p.state)) {
      saveProcess(this.ctx.db, { ...p, state: "exited", updatedAt: nowIso(), endedAt: nowIso() });
      this.ctx.published();
    }
    return { processId };
  }

  /** Record exits and vanished sessions. Runs on startup and every few seconds. */
  async reconcile() {
    const panes = await this.tmux.panes();
    if (panes === null) return;
    const bySession = new Map(panes.map((p) => [p.session, p]));
    let changed = false;
    for (const p of listProcesses(this.ctx.db)) {
      if (!RUNNING.has(p.state)) continue;
      const pane = bySession.get(p.tmuxSession);
      if (pane && !pane.dead) continue;
      const exitCode = pane?.status ?? null;
      saveProcess(this.ctx.db, {
        ...p,
        state: exitCode != null && exitCode !== 0 ? "failed" : "exited",
        exitCode,
        updatedAt: nowIso(),
        endedAt: nowIso(),
      });
      // A finished shell has nothing left to show; an app's final screen is kept until the next start.
      if (pane && p.kind === "shell") await this.tmux.kill(p.tmuxSession);
      changed = true;
    }
    if (changed) this.ctx.published();
  }

  async start() {
    try {
      await this.tmux.ensureServer();
    } catch (e) {
      this.ctx.log.error("tmux unavailable", { err: e });
    }
    await this.reconcile();
    this.timer = setInterval(
      () => void this.reconcile().catch((e) => this.ctx.log.error("process reconcile", { err: e })),
      3000,
    );
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
