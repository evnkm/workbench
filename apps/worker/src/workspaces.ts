// Projects and feature workspaces: registration, worktree creation, setup
// commands, rename, archive, and restore.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { nowIso, type Project, type Run, uuidv7, type Workspace } from "@workbench/contracts";
import {
  getProject,
  getWorkspace,
  listActiveRuns,
  listProjects,
  listWorkspaces,
  saveProject,
  saveRun,
  saveWorkspace,
  updateRun,
  updateWorkspace,
} from "@workbench/db";
import {
  addWorktree,
  branchExists,
  discoverDefaultBranch,
  isLinkedWorktree,
  listWorktrees,
  portEnv,
  pruneWorktrees,
  readProjectConfig,
  refExists,
  repoToplevel,
  validBranchName,
} from "@workbench/runtime";
import { CommandError, type Handlers } from "./commands.ts";
import type { WorkerContext } from "./context.ts";
import { projectEnv, slugify } from "./util.ts";

export class Workspaces {
  private readonly ctx: WorkerContext;
  private setups = new Map<string, ReturnType<typeof spawn>>();
  /** Hooks other modules use to block archive while they own live work. */
  private archiveGuards: ((workspaceId: string) => string | null)[] = [];

  constructor(ctx: WorkerContext) {
    this.ctx = ctx;
  }

  addArchiveGuard(guard: (workspaceId: string) => string | null) {
    this.archiveGuards.push(guard);
  }

  handlers(): Handlers {
    return {
      "project.register": { key: () => "projects", run: (p) => this.registerProject(p) },
      "project.update": { key: (p) => `project:${p.projectId}`, run: (p) => this.updateProject(p) },
      "workspace.create": { key: (p) => `project:${p.projectId}`, run: (p) => this.createWorkspace(p) },
      "workspace.rename": {
        key: (p) => `workspace:${p.workspaceId}`,
        run: async (p) => {
          this.requireWorkspace(p.workspaceId);
          updateWorkspace(this.ctx.db, p.workspaceId, { name: p.name });
          this.ctx.published();
          return { workspaceId: p.workspaceId };
        },
      },
      "workspace.retry": { key: (p) => `workspace:${p.workspaceId}`, run: (p) => this.retry(p.workspaceId) },
      "workspace.archive": { key: (p) => `workspace:${p.workspaceId}`, run: (p) => this.archive(p.workspaceId) },
      "workspace.restore": { key: (p) => `workspace:${p.workspaceId}`, run: (p) => this.restore(p.workspaceId) },
    };
  }

  private requireProject(id: string): Project {
    const p = getProject(this.ctx.db, id);
    if (!p) throw new CommandError("Project not found.");
    return p;
  }

  private requireWorkspace(id: string): Workspace {
    const w = getWorkspace(this.ctx.db, id);
    if (!w) throw new CommandError("Workspace not found.");
    return w;
  }

  // ------------------------------------------------------------ projects

  async registerProject(p: { path: string; name?: string; defaultBranch?: string; setupCommand?: string | null }) {
    const top = await repoToplevel(p.path);
    if (!top) throw new CommandError(`${p.path} is not inside a Git repository.`);
    if (await isLinkedWorktree(top)) {
      throw new CommandError("That path is a linked worktree. Register the main checkout instead.");
    }
    const existing = listProjects(this.ctx.db).find((x) => x.repoPath === top);
    if (existing) return { projectId: existing.id, existing: true };

    let defaultBranch = p.defaultBranch ?? (await discoverDefaultBranch(top));
    if (!defaultBranch) {
      throw new CommandError(
        "Could not determine the default branch (no origin/HEAD and not exactly one of main or master). Choose one explicitly.",
      );
    }
    if (!(await refExists(top, defaultBranch))) throw new CommandError(`Branch ${defaultBranch} does not exist.`);
    defaultBranch = defaultBranch.trim();
    const now = nowIso();
    const project = saveProject(this.ctx.db, {
      id: uuidv7(),
      name: p.name ?? basename(top),
      repoPath: top,
      defaultBranch,
      setupCommand: p.setupCommand?.trim() || null,
      runCommand: null,
      createdAt: now,
      updatedAt: now,
    });
    this.ctx.published();
    return { projectId: project.id, existing: false };
  }

  async updateProject(p: {
    projectId: string;
    name?: string;
    defaultBranch?: string;
    setupCommand?: string | null;
    runCommand?: string | null;
  }) {
    const project = this.requireProject(p.projectId);
    if (p.defaultBranch && !(await refExists(project.repoPath, p.defaultBranch))) {
      throw new CommandError(`Branch ${p.defaultBranch} does not exist.`);
    }
    saveProject(this.ctx.db, {
      ...project,
      name: p.name ?? project.name,
      defaultBranch: p.defaultBranch ?? project.defaultBranch,
      setupCommand: p.setupCommand === undefined ? project.setupCommand : p.setupCommand?.trim() || null,
      runCommand: p.runCommand === undefined ? project.runCommand : p.runCommand?.trim() || null,
      updatedAt: nowIso(),
    });
    this.ctx.published();
    return { projectId: project.id };
  }

  // ------------------------------------------------------------ workspace creation

  private allocatePortBase(): number {
    const [lo, hi] = this.ctx.config.portRange;
    const step = this.ctx.config.portsPerWorkspace;
    // Blocks may have been allocated with a different size earlier; avoid any overlap.
    const used = listWorkspaces(this.ctx.db)
      .map((w) => w.portBase)
      .filter((b): b is number => b != null);
    const overlaps = (base: number) => used.some((b) => base < b + step && b < base + step);
    for (let base = lo; base + step - 1 <= hi; base += step) if (!overlaps(base)) return base;
    throw new CommandError("No free port block is available for a new workspace.");
  }

  async createWorkspace(p: { projectId: string; name: string; branch?: string; baseRef?: string }) {
    const project = this.requireProject(p.projectId);
    const branch = p.branch ?? slugify(p.name);
    const baseRef = p.baseRef ?? project.defaultBranch;
    if (!(await validBranchName(project.repoPath, branch))) throw new CommandError(`Invalid branch name: ${branch}`);
    if (!(await refExists(project.repoPath, baseRef))) throw new CommandError(`Base ${baseRef} does not exist.`);
    const known = listWorkspaces(this.ctx.db).find((w) => w.projectId === project.id && w.branch === branch);
    if (known) throw new CommandError(`Workspace "${known.name}" already uses branch ${branch}.`);
    if (await branchExists(project.repoPath, branch)) {
      throw new CommandError(`Branch ${branch} already exists in the repository. Choose another branch name.`);
    }

    const id = uuidv7();
    const now = nowIso();
    const worktreePath = join(
      this.ctx.config.worktreesDir,
      slugify(project.name, 30),
      `${slugify(branch, 50)}-${id.slice(-6)}`,
    );
    const workspace = saveWorkspace(this.ctx.db, {
      id,
      projectId: project.id,
      name: p.name,
      branch,
      baseRef,
      worktreePath,
      state: "creating",
      error: null,
      setupExitCode: null,
      portBase: this.allocatePortBase(),
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    this.ctx.published();
    await this.materialize(workspace, project);
    return { workspaceId: id };
  }

  /** Create (or confirm) the worktree, then run setup. Safe to repeat after a partial failure. */
  private async materialize(workspace: Workspace, project: Project) {
    try {
      await this.ctx.locks.run(`repo:${project.repoPath}`, async () => {
        await pruneWorktrees(project.repoPath);
        const trees = await listWorktrees(project.repoPath);
        const tree = trees.find((t) => t.path === workspace.worktreePath);
        if (tree && tree.branch === workspace.branch) return;
        if (tree) throw new Error(`${workspace.worktreePath} is checked out at ${tree.branch ?? "a detached HEAD"}.`);
        if (existsSync(workspace.worktreePath)) {
          throw new Error(`${workspace.worktreePath} exists but is not a worktree of this repository.`);
        }
        mkdirSync(join(workspace.worktreePath, ".."), { recursive: true });
        const exists = await branchExists(project.repoPath, workspace.branch);
        await addWorktree(project.repoPath, workspace.worktreePath, workspace.branch, workspace.baseRef, !exists);
      });
    } catch (e) {
      updateWorkspace(this.ctx.db, workspace.id, { state: "create_failed", error: (e as Error).message });
      this.ctx.published();
      throw new CommandError(`Could not create the worktree: ${(e as Error).message}`);
    }
    this.startSetup(workspace.id, project);
  }

  // ------------------------------------------------------------ setup

  private startSetup(workspaceId: string, project: Project) {
    const workspace = getWorkspace(this.ctx.db, workspaceId)!;
    const cfg = readProjectConfig(project, workspace.worktreePath);
    const setupCommand = cfg.setupCommand;
    if (!setupCommand) {
      updateWorkspace(this.ctx.db, workspaceId, { state: "ready", error: null, setupExitCode: null });
      this.ctx.published();
      return;
    }
    const runId = uuidv7();
    const dir = join(this.ctx.config.runsDir, runId);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "output.log");
    const run: Run = {
      id: runId,
      kind: "workspace_setup",
      workspaceId,
      conversationId: null,
      jobId: null,
      state: "running",
      providerTurnId: null,
      summary: setupCommand,
      stopReason: null,
      error: null,
      attempt: 1,
      createdAt: nowIso(),
      startedAt: nowIso(),
      endedAt: null,
    };
    this.ctx.db.tx(() => {
      saveRun(this.ctx.db, run, this.ctx.instanceId);
      updateWorkspace(this.ctx.db, workspaceId, { state: "setting_up", error: null, setupExitCode: null });
    });
    this.ctx.published();

    const out = createWriteStream(logPath);
    out.write(`$ ${setupCommand}\n`);
    const env = projectEnv(portEnv(cfg, workspace));
    const child = spawn("bash", ["-lc", setupCommand], { cwd: workspace.worktreePath, env, detached: true });
    this.setups.set(workspaceId, child);
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("close", (code, signal) => {
      this.setups.delete(workspaceId);
      out.end(`\n[exit ${code ?? signal}]\n`);
      const ok = code === 0;
      this.ctx.db.tx(() => {
        updateRun(this.ctx.db, runId, {
          state: ok ? "succeeded" : "failed",
          endedAt: nowIso(),
          stopReason: signal ? `signal ${signal}` : `exit ${code}`,
        });
        updateWorkspace(this.ctx.db, workspaceId, {
          state: ok ? "ready" : "setup_failed",
          setupExitCode: code,
          error: ok ? null : `Setup command exited with ${code ?? signal}. See the setup log.`,
        });
      });
      this.ctx.published();
    });
    child.on("error", (e) => this.ctx.log.error("setup spawn failed", { workspaceId, err: e }));
  }

  async retry(workspaceId: string) {
    const w = this.requireWorkspace(workspaceId);
    const project = this.requireProject(w.projectId);
    if (w.state === "create_failed") {
      updateWorkspace(this.ctx.db, w.id, { state: "creating", error: null });
      this.ctx.published();
      await this.materialize(getWorkspace(this.ctx.db, w.id)!, project);
    } else if (w.state === "setup_failed" || w.state === "ready") {
      if (!readProjectConfig(project, w.worktreePath).setupCommand) {
        throw new CommandError("This project has no setup command.");
      }
      this.startSetup(w.id, project);
    } else {
      throw new CommandError(`A workspace in state ${w.state} cannot be retried.`);
    }
    return { workspaceId };
  }

  // ------------------------------------------------------------ archive and restore

  /**
   * Archive policy (decision 0006): the worktree, branch, and any uncommitted
   * or untracked files stay on disk untouched. Archive only hides the
   * workspace and releases its port block; restore reverses it.
   */
  async archive(workspaceId: string) {
    const w = this.requireWorkspace(workspaceId);
    if (w.state === "archived") return { workspaceId };
    if (w.state === "creating" || w.state === "setting_up") {
      throw new CommandError("Wait for creation or setup to finish before archiving.");
    }
    const active = listActiveRuns(this.ctx.db).filter((r) => r.workspaceId === workspaceId);
    if (active.length) throw new CommandError("Stop the active agent turn or job in this workspace before archiving.");
    for (const guard of this.archiveGuards) {
      const reason = guard(workspaceId);
      if (reason) throw new CommandError(reason);
    }
    updateWorkspace(this.ctx.db, workspaceId, { state: "archived", archivedAt: nowIso(), portBase: null });
    this.ctx.published();
    return { workspaceId };
  }

  async restore(workspaceId: string) {
    const w = this.requireWorkspace(workspaceId);
    if (w.state !== "archived") throw new CommandError("Workspace is not archived.");
    const project = this.requireProject(w.projectId);
    const trees = await listWorktrees(project.repoPath);
    const present = trees.some((t) => t.path === w.worktreePath && t.branch === w.branch);
    updateWorkspace(this.ctx.db, workspaceId, {
      state: present ? "ready" : "create_failed",
      error: present ? null : "The worktree is missing; retry to recreate it from its branch.",
      archivedAt: null,
      portBase: this.allocatePortBase(),
    });
    this.ctx.published();
    return { workspaceId, worktreePresent: present };
  }

  /** On startup: setup commands do not survive a worker restart. */
  reconcile() {
    for (const run of listActiveRuns(this.ctx.db).filter((r) => r.kind === "workspace_setup")) {
      this.ctx.db.tx(() => {
        updateRun(this.ctx.db, run.id, {
          state: "interrupted",
          endedAt: nowIso(),
          stopReason: "worker restarted",
          error: "The worker restarted during setup.",
        });
        if (run.workspaceId) {
          updateWorkspace(this.ctx.db, run.workspaceId, {
            state: "setup_failed",
            error: "Setup was interrupted by a worker restart. Retry to run it again.",
          });
        }
      });
    }
    for (const w of listWorkspaces(this.ctx.db).filter((x) => x.state === "creating")) {
      updateWorkspace(this.ctx.db, w.id, {
        state: "create_failed",
        error: "The worker restarted while creating this workspace. Retry to finish.",
      });
    }
    this.ctx.published();
  }

  stop() {
    for (const child of this.setups.values()) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      }
    }
  }
}
