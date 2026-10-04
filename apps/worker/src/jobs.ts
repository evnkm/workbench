// Durable background jobs and schedules (decision 0007).
//
// Queue: job runs are `runs` rows in state 'queued'; a worker claims one with
// a single UPDATE and holds a lease it renews while executing. Runs whose
// lease expires without finishing are reconciled as `interrupted` (outcome
// unknown) and are retried only when the job allows it.
//
// Schedules: each due occurrence inserts at most one run, enforced by a
// UNIQUE (job_id, occurrence_at) constraint in the same transaction that
// advances the job's next occurrence.
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isTerminalRunState, type Job, nowIso, type Run, type RunState, uuidv7 } from "@workbench/contracts";
import {
  claimJobRun,
  deleteJob,
  getArtifact,
  getJob,
  getJobRunRow,
  getRun,
  getWorkspace,
  insertJobRun,
  listJobs,
  markRunsRead,
  saveArtifact,
  saveJob,
  updateJobRun,
  updateRun,
} from "@workbench/db";
import { status as gitStatus, nextOccurrence, validTimezone } from "@workbench/runtime";
import type { CodexProvider } from "./codex/provider.ts";
import { CommandError, type Handlers } from "./commands.ts";
import type { WorkerContext } from "./context.ts";
import { exec, projectEnv, slugify } from "./util.ts";
import type { Workspaces } from "./workspaces.ts";

const LEASE_MS = 30_000;
const KILL_GRACE_MS = 10_000;
/** Occurrences more than this late (worker was down) are skipped, not run. */
const MISSED_GRACE_MS = 90_000;
const ACTIVE = ["starting", "running", "stopping", "waiting_for_input"];

type Outcome = { state: RunState; exitCode?: number | null; error?: string | null; finalMessage?: string | null };
type Active = { cancel: () => void; timeout: () => void };

type JobInput = {
  name: string;
  workspaceId: string | null;
  projectId: string | null;
  kind: "shell" | "codex";
  command: string;
  isolation: "workspace" | "worktree";
  timeoutSeconds: number;
  maxAttempts: number;
  retryUnknownOutcome: boolean;
  schedule: { cron: string; timezone: string; overlap: "skip" | "queue" } | null;
};

export class Jobs {
  private readonly ctx: WorkerContext;
  private readonly workspaces: Workspaces;
  private readonly codex: CodexProvider;
  private readonly concurrency = Number(process.env.WORKBENCH_JOB_CONCURRENCY ?? 2);
  private readonly outputLimit = Number(process.env.WORKBENCH_RUN_OUTPUT_LIMIT_MB ?? 50) * 1024 * 1024;
  private active = new Map<string, Active>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private started = false;

  constructor(ctx: WorkerContext, workspaces: Workspaces, codex: CodexProvider) {
    this.ctx = ctx;
    this.workspaces = workspaces;
    this.codex = codex;
  }

  handlers(): Handlers {
    return {
      "job.create": { key: () => "jobs", run: (p) => this.create(p) },
      "job.update": { key: (p) => `job:${p.jobId}`, run: (p) => this.update(p) },
      "job.delete": {
        key: (p) => `job:${p.jobId}`,
        run: async (p) => {
          this.requireJob(p.jobId);
          deleteJob(this.ctx.db, p.jobId);
          this.ctx.published();
          return { jobId: p.jobId };
        },
      },
      "job.launch": {
        key: (p) => `job:${p.jobId}`,
        run: async (p) => {
          const job = this.requireJob(p.jobId);
          const runId = this.enqueue(job, { trigger: "manual", attempt: 1 });
          this.ctx.published();
          this.dispatch();
          return { runId };
        },
      },
      "job.cancel": { key: (p) => `jobrun:${p.runId}`, run: (p) => this.cancel(p.runId) },
      "job.retry": { key: (p) => `jobrun:${p.runId}`, run: (p) => this.retry(p.runId) },
      "artifact.pin": {
        key: (p) => `artifact:${p.artifactId}`,
        run: async (p) => {
          const a = getArtifact(this.ctx.db, p.artifactId);
          if (!a) throw new CommandError("Artifact not found.");
          saveArtifact(this.ctx.db, { ...a, pinned: p.pinned });
          this.ctx.published();
          return { artifactId: a.id };
        },
      },
      "notification.markRead": {
        key: () => "notifications",
        run: async (p) => {
          markRunsRead(this.ctx.db, p.runIds);
          return { count: p.runIds.length };
        },
      },
    };
  }

  private requireJob(id: string): Job {
    const j = getJob(this.ctx.db, id);
    if (!j) throw new CommandError("Job not found.");
    return j;
  }

  // ------------------------------------------------------------ definitions

  private validate(p: JobInput) {
    if (p.isolation === "workspace" && !p.workspaceId) throw new CommandError("Choose a workspace for the job.");
    if (p.isolation === "worktree" && !p.projectId && !p.workspaceId)
      throw new CommandError("Choose a project for the job.");
    if (p.workspaceId && !getWorkspace(this.ctx.db, p.workspaceId)) throw new CommandError("Workspace not found.");
    if (p.schedule) this.next(p.schedule.cron, p.schedule.timezone);
  }

  private next(cron: string, timezone: string, after = new Date()): string {
    if (!validTimezone(timezone)) throw new CommandError(`Unknown timezone ${timezone}.`);
    try {
      return nextOccurrence(cron, timezone, after).toISOString();
    } catch (e) {
      throw new CommandError((e as Error).message);
    }
  }

  async create(p: JobInput) {
    this.validate(p);
    const projectId = p.projectId ?? (p.workspaceId ? getWorkspace(this.ctx.db, p.workspaceId)!.projectId : null);
    const now = nowIso();
    const job = saveJob(this.ctx.db, {
      id: uuidv7(),
      name: p.name,
      kind: p.kind,
      command: p.command,
      projectId,
      workspaceId: p.isolation === "workspace" ? p.workspaceId : null,
      isolation: p.isolation,
      timeoutSeconds: p.timeoutSeconds,
      maxAttempts: p.maxAttempts,
      retryUnknownOutcome: p.retryUnknownOutcome,
      schedule: p.schedule,
      paused: false,
      nextRunAt: p.schedule ? this.next(p.schedule.cron, p.schedule.timezone) : null,
      createdAt: now,
      updatedAt: now,
    });
    this.ctx.published();
    return { jobId: job.id, nextRunAt: job.nextRunAt };
  }

  async update(p: {
    jobId: string;
    name?: string;
    command?: string;
    timeoutSeconds?: number;
    paused?: boolean;
    schedule?: { cron: string; timezone: string; overlap: "skip" | "queue" } | null;
  }) {
    const job = this.requireJob(p.jobId);
    const schedule = p.schedule === undefined ? job.schedule : p.schedule;
    const paused = p.paused ?? job.paused;
    const next = schedule && !paused ? this.next(schedule.cron, schedule.timezone) : null;
    saveJob(this.ctx.db, {
      ...job,
      name: p.name ?? job.name,
      command: p.command ?? job.command,
      timeoutSeconds: p.timeoutSeconds ?? job.timeoutSeconds,
      schedule,
      paused,
      nextRunAt: next,
      updatedAt: nowIso(),
    });
    this.ctx.published();
    return { jobId: job.id, nextRunAt: next };
  }

  // ------------------------------------------------------------ queue

  private enqueue(
    job: Job,
    o: {
      trigger: "manual" | "schedule" | "retry";
      attempt: number;
      occurrenceAt?: string | null;
      retryOf?: string | null;
      skipped?: string;
    },
  ): string | null {
    const now = nowIso();
    const run: Run = {
      id: uuidv7(),
      kind: "job",
      workspaceId: job.workspaceId,
      conversationId: null,
      jobId: job.id,
      state: o.skipped ? "cancelled" : "queued",
      providerTurnId: null,
      summary: job.name,
      stopReason: o.skipped ?? null,
      error: null,
      attempt: o.attempt,
      createdAt: now,
      startedAt: null,
      endedAt: o.skipped ? now : null,
    };
    const ok = insertJobRun(this.ctx.db, {
      run,
      jobId: job.id,
      occurrenceAt: o.occurrenceAt ?? null,
      trigger: o.trigger,
      retryOf: o.retryOf ?? null,
    });
    return ok ? run.id : null;
  }

  private dispatch() {
    if (!this.started || this.stopped) return;
    while (this.active.size < this.concurrency) {
      const run = claimJobRun(this.ctx.db, this.ctx.instanceId, LEASE_MS);
      if (!run) break;
      this.ctx.published();
      // Placeholder until the executor registers its real cancel/timeout handles.
      this.active.set(run.id, { cancel: () => {}, timeout: () => {} });
      const done = this.execute(run).catch((e) => {
        this.ctx.log.error("job execution failed", { runId: run.id, err: e });
        return { state: "failed" as RunState, error: `Workbench could not run the job: ${(e as Error).message}` };
      });
      void done.then((outcome) => this.finish(run.id, outcome));
    }
  }

  private async execute(run: Run): Promise<Outcome> {
    const db = this.ctx.db;
    const job = getJob(db, run.jobId!);
    if (!job) return { state: "cancelled", error: "The job was deleted before this run started." };
    const dir = join(this.ctx.config.runsDir, run.id);
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    const logPath = join(dir, "output.log");
    updateJobRun(db, run.id, {
      logPath,
      deadlineAt: new Date(Date.now() + job.timeoutSeconds * 1000).toISOString(),
    });

    let workspaceId = job.workspaceId;
    if (job.isolation === "worktree") {
      workspaceId = await this.createJobWorkspace(job, run);
      db.run("UPDATE runs SET workspace_id = :w WHERE id = :id", { w: workspaceId, id: run.id });
    }
    const w = workspaceId ? getWorkspace(db, workspaceId) : undefined;
    if (!w || (w.state !== "ready" && w.state !== "setup_failed")) {
      return { state: "failed", error: `The job's workspace is ${w ? w.state.replace("_", " ") : "missing"}.` };
    }
    if (job.isolation === "worktree") updateJobRun(db, run.id, { worktreePath: w.worktreePath });
    updateRun(db, run.id, { state: "running", workspaceId: w.id });
    this.ctx.published();

    return job.kind === "shell"
      ? this.runShell(run, job, w.worktreePath, logPath, join(dir, "artifacts"))
      : this.runCodex(run, job, w.id, logPath);
  }

  private async createJobWorkspace(job: Job, run: Run): Promise<string> {
    if (!job.projectId) throw new Error("worktree isolation needs a project");
    const stamp = run.id.slice(-6);
    const { workspaceId } = await this.workspaces.createWorkspace({
      projectId: job.projectId,
      name: `Job: ${job.name} #${stamp}`,
      branch: `job/${slugify(job.name, 30)}-${stamp}`,
    });
    // Wait for setup to finish (bounded by the job's deadline).
    const deadline = Date.now() + job.timeoutSeconds * 1000;
    for (;;) {
      const w = getWorkspace(this.ctx.db, workspaceId)!;
      if (w.state !== "setting_up" && w.state !== "creating") return workspaceId;
      if (Date.now() > deadline) return workspaceId;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private runShell(run: Run, job: Job, cwd: string, logPath: string, artifactsDir: string): Promise<Outcome> {
    return new Promise((resolve) => {
      const out = createWriteStream(logPath, { flags: "a" });
      let bytes = 0;
      let truncated = false;
      const write = (chunk: Buffer) => {
        if (truncated) return;
        if (bytes + chunk.length > this.outputLimit) {
          out.write(chunk.subarray(0, this.outputLimit - bytes));
          out.write(`\n[workbench: output truncated at ${Math.round(this.outputLimit / 1048576)} MB]\n`);
          bytes = this.outputLimit;
          truncated = true;
          return;
        }
        bytes += chunk.length;
        out.write(chunk);
      };
      out.write(`$ ${job.command}\n`);
      const env = projectEnv({
        WORKBENCH_RUN_ID: run.id,
        WORKBENCH_JOB_NAME: job.name,
        WORKBENCH_ARTIFACTS_DIR: artifactsDir,
        WORKBENCH_ATTEMPT: String(run.attempt),
      });
      let child: ChildProcess;
      try {
        child = spawn("bash", ["-lc", job.command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        resolve({ state: "failed", error: (e as Error).message });
        return;
      }
      updateJobRun(this.ctx.db, run.id, { pid: child.pid ?? null, pgid: child.pid ?? null });
      child.stdout!.on("data", write);
      child.stderr!.on("data", write);
      let reason: "cancel" | "timeout" | null = null;
      const killGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {}
      };
      const stop = (r: "cancel" | "timeout") => {
        if (reason) return;
        reason = r;
        out.write(
          `\n[workbench: ${r === "cancel" ? "cancelled" : `timed out after ${job.timeoutSeconds}s`}; stopping]\n`,
        );
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
      };
      const timer = setTimeout(() => stop("timeout"), job.timeoutSeconds * 1000);
      this.active.set(run.id, { cancel: () => stop("cancel"), timeout: () => stop("timeout") });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        out.end(`\n[exit ${code ?? signal}]\n`);
        updateJobRun(this.ctx.db, run.id, { logBytes: bytes });
        if (reason === "cancel") resolve({ state: "cancelled", exitCode: code });
        else if (reason === "timeout")
          resolve({ state: "failed", exitCode: code, error: `Timed out after ${job.timeoutSeconds}s.` });
        else if (code === 0) resolve({ state: "succeeded", exitCode: 0 });
        else resolve({ state: "failed", exitCode: code, error: `Exited with ${code ?? signal}.` });
      });
      child.on("error", (e) => out.write(`\n[workbench: ${e.message}]\n`));
    });
  }

  private async runCodex(run: Run, job: Job, workspaceId: string, logPath: string): Promise<Outcome> {
    const db = this.ctx.db;
    const { conversationId } = await this.codex.createConversation({
      workspaceId,
      provider: "codex",
      approvalPolicy: "never",
      title: `Job: ${job.name}`,
    });
    db.run("UPDATE runs SET conversation_id = :c WHERE id = :id", { c: conversationId, id: run.id });
    updateRun(db, run.id, { conversationId });
    const { runId: agentRunId } = await this.codex.submitTurn({ conversationId, text: job.command, mode: "default" });
    let reason: "cancel" | "timeout" | null = null;
    const interrupt = (r: "cancel" | "timeout") => {
      if (reason) return;
      reason = r;
      void this.codex.interrupt({ conversationId, runId: agentRunId }).catch(() => {});
    };
    this.active.set(run.id, { cancel: () => interrupt("cancel"), timeout: () => interrupt("timeout") });
    const deadline = Date.now() + job.timeoutSeconds * 1000;
    let mirrored: RunState | null = null;
    for (;;) {
      const agent = getRun(db, agentRunId)!;
      if (isTerminalRunState(agent.state)) {
        const last = db.get<{ data: string }>(
          "SELECT data FROM items WHERE run_id = :r AND kind = 'agent_message' ORDER BY position DESC LIMIT 1",
          { r: agentRunId },
        );
        const finalMessage = last ? (JSON.parse(last.data).text as string) : null;
        createWriteStream(logPath, { flags: "a" }).end(`${finalMessage ?? "(no final message)"}\n`);
        if (reason === "timeout")
          return { state: "failed", error: `Timed out after ${job.timeoutSeconds}s.`, finalMessage };
        if (reason === "cancel") return { state: "cancelled", finalMessage };
        return { state: agent.state, error: agent.error, finalMessage };
      }
      // Mirror "waiting for input" so the job is visibly blocked rather than silently stuck.
      const visible: RunState = agent.state === "waiting_for_input" ? "waiting_for_input" : "running";
      if (visible !== mirrored && getRun(db, run.id)!.state !== "stopping") {
        updateRun(db, run.id, { state: visible });
        if (visible === "waiting_for_input") updateJobRun(db, run.id, { unread: true });
        this.ctx.published();
        mirrored = visible;
      }
      if (Date.now() > deadline) interrupt("timeout");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private finish(runId: string, outcome: Outcome) {
    const db = this.ctx.db;
    this.active.delete(runId);
    const run = getRun(db, runId)!;
    const detail = getJobRunRow(db, runId)!;
    // Register artifacts written by the job.
    const dir = join(this.ctx.config.runsDir, runId, "artifacts");
    if (existsSync(dir)) {
      for (const file of walk(dir).slice(0, 500)) {
        saveArtifact(db, {
          id: uuidv7(),
          runId,
          name: relative(dir, file),
          path: file,
          bytes: statSync(file).size,
          pinned: false,
          createdAt: nowIso(),
        });
      }
    }
    db.tx(() => {
      updateRun(db, runId, {
        state: outcome.state,
        endedAt: nowIso(),
        error: outcome.error ?? null,
        stopReason: outcome.exitCode != null ? `exit ${outcome.exitCode}` : outcome.state,
      });
      updateJobRun(db, runId, {
        exitCode: outcome.exitCode ?? null,
        finalMessage: outcome.finalMessage?.slice(0, 20_000) ?? null,
        unread: true,
        leaseExpiresAt: null,
      });
    });
    this.ctx.published();
    void this.cleanupWorktree(run, detail.worktreePath);
    const job = getJob(db, run.jobId!);
    if (job && outcome.state === "failed" && run.attempt < job.maxAttempts) {
      this.enqueue(job, { trigger: "retry", attempt: run.attempt + 1, retryOf: runId });
      this.ctx.published();
    }
    this.dispatch();
  }

  /** Disposable worktrees are removed only when they hold no changes. */
  private async cleanupWorktree(run: Run, worktreePath: string | null) {
    if (!worktreePath || !run.workspaceId) return;
    const w = getWorkspace(this.ctx.db, run.workspaceId);
    if (!w || !existsSync(worktreePath)) return;
    try {
      const st = await gitStatus(worktreePath, w.baseRef);
      const project = this.ctx.db.get<{ repo_path: string }>("SELECT repo_path FROM projects WHERE id = :p", {
        p: w.projectId,
      })!;
      const ahead = await exec("git", ["-C", worktreePath, "rev-list", "--count", `${w.baseRef}..HEAD`]);
      if (st.files.length === 0 && ahead.stdout.trim() === "0") {
        await this.workspaces.archive(w.id).catch(() => {});
        await exec("git", ["-C", project.repo_path, "worktree", "remove", "--force", worktreePath]);
        await exec("git", ["-C", project.repo_path, "branch", "-D", w.branch]);
        this.ctx.db.run(
          "UPDATE workspaces SET error = 'Disposable job worktree removed: the job made no changes.' WHERE id = :id",
          { id: w.id },
        );
      } else {
        updateJobRun(this.ctx.db, run.id, {
          finalMessage:
            `${getJobRunRow(this.ctx.db, run.id)?.finalMessage ?? ""}\n\nChanges were kept in workspace "${w.name}".`.trim(),
        });
      }
      this.ctx.published();
    } catch (e) {
      this.ctx.log.warn("job worktree cleanup failed", { runId: run.id, err: e });
    }
  }

  async cancel(runId: string) {
    const run = getRun(this.ctx.db, runId);
    if (run?.kind !== "job") throw new CommandError("Job run not found.");
    if (isTerminalRunState(run.state)) throw new CommandError(`This run already ended (${run.state}).`);
    if (run.state === "queued") {
      const r = this.ctx.db.run(
        "UPDATE runs SET state = 'cancelled', ended_at = :now, stop_reason = 'cancelled while queued' WHERE id = :id AND state = 'queued'",
        { id: runId, now: nowIso() },
      );
      if (r.changes) {
        updateRun(this.ctx.db, runId, {});
        this.ctx.published();
        return { runId, state: "cancelled" };
      }
    }
    updateJobRun(this.ctx.db, runId, { cancelRequested: true });
    updateRun(this.ctx.db, runId, { state: "stopping" });
    this.ctx.published();
    const active = this.active.get(runId);
    if (active) active.cancel();
    return { runId, state: "stopping" };
  }

  async retry(runId: string) {
    const run = getRun(this.ctx.db, runId);
    if (run?.kind !== "job") throw new CommandError("Job run not found.");
    if (!isTerminalRunState(run.state)) throw new CommandError("Wait for the run to finish before retrying.");
    const job = this.requireJob(run.jobId!);
    const max = this.ctx.db.get<{ m: number }>("SELECT max(attempt) m FROM runs WHERE job_id = :j", { j: job.id })!.m;
    const id = this.enqueue(job, { trigger: "retry", attempt: Math.max(max, run.attempt) + 1, retryOf: runId });
    this.ctx.published();
    this.dispatch();
    return { runId: id };
  }

  // ------------------------------------------------------------ leases and recovery

  private renewLeases() {
    const lease = new Date(Date.now() + LEASE_MS).toISOString();
    for (const id of this.active.keys()) updateJobRun(this.ctx.db, id, { leaseExpiresAt: lease });
  }

  /**
   * Runs whose lease expired belong to a worker that stopped. Their outcome is
   * unknown: stop any leftover process group, mark them interrupted, and
   * retry only if the job opted in.
   */
  reconcileExpired() {
    const db = this.ctx.db;
    const stale = db.all<{ id: string }>(
      `SELECT r.id FROM runs r JOIN job_runs jr ON jr.run_id = r.id
       WHERE r.kind = 'job' AND r.state IN (${ACTIVE.map((s) => `'${s}'`).join(",")})
         AND (jr.lease_expires_at IS NULL OR jr.lease_expires_at < :now)`,
      { now: nowIso() },
    );
    for (const { id } of stale) {
      if (this.active.has(id)) continue;
      const detail = getJobRunRow(db, id)!;
      if (detail.pgid) {
        try {
          process.kill(-detail.pgid, "SIGKILL");
        } catch {}
      }
      const run = updateRun(db, id, {
        state: "interrupted",
        endedAt: nowIso(),
        stopReason: "worker stopped",
        error:
          "The worker stopped while this job was running; its outcome is unknown. Check its workspace before retrying.",
      });
      updateJobRun(db, id, { unread: true, leaseExpiresAt: null });
      const job = getJob(db, run.jobId!);
      if (job?.retryUnknownOutcome && run.attempt < job.maxAttempts) {
        this.enqueue(job, { trigger: "retry", attempt: run.attempt + 1, retryOf: id });
      }
      this.ctx.log.warn("job run reconciled as interrupted", { runId: id });
    }
    if (stale.length) this.ctx.published();
  }

  // ------------------------------------------------------------ scheduler

  /** Enqueue due occurrences. Safe to call repeatedly and from several workers. */
  schedule(now = new Date()) {
    const db = this.ctx.db;
    for (const job of listJobs(db)) {
      if (!job.schedule || job.paused || !job.nextRunAt || Date.parse(job.nextRunAt) > now.getTime()) continue;
      const occurrence = job.nextRunAt;
      const late = now.getTime() - Date.parse(occurrence);
      let next: string;
      try {
        next = nextOccurrence(
          job.schedule.cron,
          job.schedule.timezone,
          new Date(Math.max(now.getTime(), Date.parse(occurrence) + 1000)),
        ).toISOString();
      } catch (e) {
        this.ctx.log.error("invalid schedule", { jobId: job.id, err: e });
        continue;
      }
      db.tx(() => {
        const current = getJob(db, job.id);
        if (!current || current.nextRunAt !== occurrence) return; // deleted, or another scheduler advanced it
        const busy = db.get(
          `SELECT 1 FROM runs WHERE job_id = :j AND state NOT IN ('succeeded','failed','cancelled','interrupted')`,
          { j: job.id },
        );
        let skipped: string | undefined;
        if (late > MISSED_GRACE_MS) skipped = `missed: Workbench was not running at ${occurrence}`;
        else if (busy && job.schedule!.overlap === "skip") skipped = "skipped: the previous run was still active";
        this.enqueue(job, { trigger: "schedule", attempt: 1, occurrenceAt: occurrence, skipped });
        saveJob(db, { ...current, nextRunAt: next, updatedAt: nowIso() });
      });
      this.ctx.published();
    }
  }

  // ------------------------------------------------------------ retention

  /** Remove old run directories, keeping active runs and pinned artifacts. */
  retention() {
    const db = this.ctx.db;
    const root = this.ctx.config.runsDir;
    if (!existsSync(root)) return;
    const days = Number(process.env.WORKBENCH_RUN_RETENTION_DAYS ?? 30);
    const limit = Number(process.env.WORKBENCH_RUNS_DISK_LIMIT_MB ?? 5000) * 1024 * 1024;
    const protectedIds = new Set([
      ...db
        .all<{ id: string }>("SELECT id FROM runs WHERE state NOT IN ('succeeded','failed','cancelled','interrupted')")
        .map((r) => r.id),
      ...db
        .all<{ id: string }>("SELECT id FROM process_sessions WHERE state IN ('starting','running')")
        .map((r) => r.id),
      ...db.all<{ id: string }>("SELECT DISTINCT run_id id FROM artifacts WHERE pinned = 1").map((r) => r.id),
    ]);
    const entries = readdirSync(root)
      .map((id) => {
        const path = join(root, id);
        return { id, path, mtime: statSync(path).mtimeMs, size: dirSize(path) };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let total = entries.reduce((s, e) => s + e.size, 0);
    const cutoff = Date.now() - days * 86_400_000;
    let removed = 0;
    for (const e of entries) {
      if (protectedIds.has(e.id)) continue;
      if (e.mtime >= cutoff && total <= limit) continue;
      rmSync(e.path, { recursive: true, force: true });
      db.run("DELETE FROM artifacts WHERE run_id = :r AND pinned = 0", { r: e.id });
      total -= e.size;
      removed++;
    }
    if (removed) this.ctx.log.info("run retention removed directories", { removed, totalBytes: total });
  }

  // ------------------------------------------------------------ lifecycle

  start() {
    this.started = true;
    const tick = () => {
      try {
        this.reconcileExpired();
        this.schedule();
        this.dispatch();
        // Enforce deadlines even if a timer was lost.
        for (const [id, a] of this.active) {
          const d = getJobRunRow(this.ctx.db, id)?.deadlineAt;
          if (d && Date.parse(d) + 5000 < Date.now()) a.timeout();
        }
      } catch (e) {
        this.ctx.log.error("job tick failed", { err: e });
      }
    };
    tick();
    this.timers.push(setInterval(tick, 1000));
    this.timers.push(setInterval(() => this.renewLeases(), 10_000));
    this.timers.push(setInterval(() => this.retention(), 3600_000));
    this.retention();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (s.isFile()) out.push(p);
  }
  return out;
}

function dirSize(p: string): number {
  const s = statSync(p);
  if (!s.isDirectory()) return s.size;
  return readdirSync(p).reduce((sum, n) => sum + dirSize(join(p, n)), 0);
}
