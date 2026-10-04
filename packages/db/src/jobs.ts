// Jobs, job runs, and artifacts. A job run is a `runs` row (kind 'job')
// plus a `job_runs` row with execution details.
import { type Artifact, type Job, type JobRunDetail, nowIso, type Run } from "@workbench/contracts";
import type { Database } from "./database.ts";
import { appendEvent, toRun } from "./store.ts";

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

export const toJob = (r: Row): Job => ({
  id: String(r.id),
  name: String(r.name),
  kind: r.kind as Job["kind"],
  command: String(r.command),
  projectId: str(r.project_id),
  workspaceId: str(r.workspace_id),
  isolation: r.isolation as Job["isolation"],
  timeoutSeconds: Number(r.timeout_seconds),
  maxAttempts: Number(r.max_attempts),
  retryUnknownOutcome: Boolean(r.retry_unknown_outcome),
  schedule: r.schedule_cron
    ? {
        cron: String(r.schedule_cron),
        timezone: String(r.schedule_timezone),
        overlap: r.schedule_overlap as "skip" | "queue",
      }
    : null,
  paused: Boolean(r.paused),
  nextRunAt: str(r.next_run_at),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

export const toJobRun = (r: Row): JobRunDetail => ({
  runId: String(r.run_id),
  jobId: String(r.job_id),
  occurrenceAt: str(r.occurrence_at),
  trigger: r.trigger as JobRunDetail["trigger"],
  exitCode: num(r.exit_code),
  logPath: str(r.log_path),
  logBytes: Number(r.log_bytes ?? 0),
  finalMessage: str(r.final_message),
  unread: Boolean(r.unread),
});

export const toArtifact = (r: Row): Artifact => ({
  id: String(r.id),
  runId: String(r.run_id),
  name: String(r.name),
  path: String(r.path),
  bytes: Number(r.bytes),
  pinned: Boolean(r.pinned),
  createdAt: String(r.created_at),
});

export const listJobs = (db: Database) =>
  db.all<Row>("SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY name").map(toJob);

export const getJob = (db: Database, id: string) => {
  const r = db.get<Row>("SELECT * FROM jobs WHERE id = :id AND deleted_at IS NULL", { id });
  return r ? toJob(r) : undefined;
};

export function saveJob(db: Database, j: Job): Job {
  db.tx(() => {
    db.run(
      `INSERT INTO jobs (id, name, kind, command, project_id, workspace_id, isolation, timeout_seconds, max_attempts,
         retry_unknown_outcome, schedule_cron, schedule_timezone, schedule_overlap, paused, next_run_at, created_at, updated_at)
       VALUES (:id, :name, :kind, :command, :project, :ws, :isolation, :timeout, :attempts, :retryUnknown, :cron, :tz,
         :overlap, :paused, :next, :created, :updated)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, command = excluded.command,
         timeout_seconds = excluded.timeout_seconds, max_attempts = excluded.max_attempts,
         retry_unknown_outcome = excluded.retry_unknown_outcome, schedule_cron = excluded.schedule_cron,
         schedule_timezone = excluded.schedule_timezone, schedule_overlap = excluded.schedule_overlap,
         paused = excluded.paused, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`,
      {
        id: j.id,
        name: j.name,
        kind: j.kind,
        command: j.command,
        project: j.projectId,
        ws: j.workspaceId,
        isolation: j.isolation,
        timeout: j.timeoutSeconds,
        attempts: j.maxAttempts,
        retryUnknown: j.retryUnknownOutcome ? 1 : 0,
        cron: j.schedule?.cron ?? null,
        tz: j.schedule?.timezone ?? null,
        overlap: j.schedule?.overlap ?? null,
        paused: j.paused ? 1 : 0,
        next: j.nextRunAt,
        created: j.createdAt,
        updated: j.updatedAt,
      },
    );
    appendEvent(db, { type: "job.upserted", job: j });
  });
  return j;
}

export function deleteJob(db: Database, id: string) {
  db.tx(() => {
    db.run("UPDATE jobs SET deleted_at = :now, next_run_at = NULL WHERE id = :id", { id, now: nowIso() });
    appendEvent(db, { type: "job.deleted", jobId: id });
  });
}

export type JobRunInsert = {
  run: Run;
  jobId: string;
  occurrenceAt: string | null;
  trigger: JobRunDetail["trigger"];
  retryOf: string | null;
};

/**
 * Insert a job run. A scheduled occurrence is unique per job, so a second
 * insert for the same occurrence returns false and changes nothing.
 */
export function insertJobRun(db: Database, x: JobRunInsert): boolean {
  try {
    db.tx(() => {
      db.run(
        `INSERT INTO runs (id, kind, workspace_id, conversation_id, job_id, state, summary, stop_reason, error, attempt,
           created_at, started_at, ended_at)
         VALUES (:id, 'job', :ws, NULL, :job, :state, :summary, :stop, :error, :attempt, :created, :started, :ended)`,
        {
          id: x.run.id,
          ws: x.run.workspaceId,
          job: x.jobId,
          state: x.run.state,
          summary: x.run.summary,
          stop: x.run.stopReason,
          error: x.run.error,
          attempt: x.run.attempt,
          created: x.run.createdAt,
          started: x.run.startedAt,
          ended: x.run.endedAt,
        },
      );
      db.run(
        `INSERT INTO job_runs (run_id, job_id, occurrence_at, trigger, retry_of, unread)
         VALUES (:run, :job, :occ, :trigger, :retryOf, :unread)`,
        {
          run: x.run.id,
          job: x.jobId,
          occ: x.occurrenceAt,
          trigger: x.trigger,
          retryOf: x.retryOf,
          unread: x.run.state === "cancelled" ? 0 : 1,
        },
      );
      appendEvent(db, { type: "run.upserted", run: x.run });
    });
    return true;
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE constraint failed: job_runs.job_id, job_runs.occurrence_at"))
      return false;
    throw e;
  }
}

export const getJobRun = (db: Database, runId: string) => {
  const r = db.get<Row>("SELECT * FROM job_runs WHERE run_id = :id", { id: runId });
  return r ? toJobRun(r) : undefined;
};

export type JobRunRow = JobRunDetail & {
  pid: number | null;
  pgid: number | null;
  leaseExpiresAt: string | null;
  deadlineAt: string | null;
  cancelRequested: boolean;
  worktreePath: string | null;
  retryOf: string | null;
};

export const getJobRunRow = (db: Database, runId: string): JobRunRow | undefined => {
  const r = db.get<Row>("SELECT * FROM job_runs WHERE run_id = :id", { id: runId });
  return r
    ? {
        ...toJobRun(r),
        pid: num(r.pid),
        pgid: num(r.pgid),
        leaseExpiresAt: str(r.lease_expires_at),
        deadlineAt: str(r.deadline_at),
        cancelRequested: Boolean(r.cancel_requested),
        worktreePath: str(r.worktree_path),
        retryOf: str(r.retry_of),
      }
    : undefined;
};

const JOB_RUN_COLUMNS: Record<string, string> = {
  exitCode: "exit_code",
  pid: "pid",
  pgid: "pgid",
  leaseExpiresAt: "lease_expires_at",
  deadlineAt: "deadline_at",
  cancelRequested: "cancel_requested",
  logPath: "log_path",
  logBytes: "log_bytes",
  worktreePath: "worktree_path",
  finalMessage: "final_message",
  unread: "unread",
};

export function updateJobRun(db: Database, runId: string, patch: Partial<JobRunRow>) {
  const sets: string[] = [];
  const params: Record<string, string | number | null> = { id: runId };
  for (const [k, v] of Object.entries(patch)) {
    const col = JOB_RUN_COLUMNS[k];
    if (!col) continue;
    sets.push(`${col} = :${k}`);
    params[k] = typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null);
  }
  if (sets.length) db.run(`UPDATE job_runs SET ${sets.join(", ")} WHERE run_id = :id`, params);
}

/** Atomically claim the oldest queued job run for this worker. */
export function claimJobRun(db: Database, owner: string, leaseMs: number): Run | undefined {
  return db.tx(() => {
    const r = db.get<Row>(
      `UPDATE runs SET state = 'starting', owner = :owner, started_at = :now
       WHERE id = (SELECT id FROM runs WHERE kind = 'job' AND state = 'queued' ORDER BY created_at LIMIT 1)
       RETURNING *`,
      { owner, now: nowIso() },
    );
    if (!r) return undefined;
    const run = toRun(r);
    db.run("UPDATE job_runs SET lease_expires_at = :lease WHERE run_id = :id", {
      id: run.id,
      lease: new Date(Date.now() + leaseMs).toISOString(),
    });
    appendEvent(db, { type: "run.upserted", run });
    return run;
  });
}

export type JobRunListItem = { run: Run; detail: JobRunDetail; jobName: string };

export function listJobRuns(
  db: Database,
  opts: { jobId?: string; filter?: "running" | "waiting" | "finished" | "failed" | "unread"; limit?: number },
): JobRunListItem[] {
  const where = ["r.kind = 'job'"];
  const params: Record<string, string | number> = { limit: opts.limit ?? 100 };
  if (opts.jobId) {
    where.push("jr.job_id = :job");
    params.job = opts.jobId;
  }
  switch (opts.filter) {
    case "running":
      where.push("r.state IN ('queued','starting','running','stopping')");
      break;
    case "waiting":
      where.push("r.state = 'waiting_for_input'");
      break;
    case "finished":
      where.push("r.state IN ('succeeded','failed','cancelled','interrupted')");
      break;
    case "failed":
      where.push("r.state IN ('failed','interrupted')");
      break;
    case "unread":
      where.push("jr.unread = 1 AND r.state IN ('succeeded','failed','cancelled','interrupted','waiting_for_input')");
      break;
  }
  return db
    .all<Row>(
      `SELECT r.*, jr.*, j.name AS job_name FROM runs r JOIN job_runs jr ON jr.run_id = r.id JOIN jobs j ON j.id = jr.job_id
       WHERE ${where.join(" AND ")} ORDER BY r.created_at DESC LIMIT :limit`,
      params,
    )
    .map((r) => ({ run: toRun(r), detail: toJobRun(r), jobName: String(r.job_name) }));
}

export function markRunsRead(db: Database, runIds: string[]) {
  db.tx(() => {
    for (const id of runIds) db.run("UPDATE job_runs SET unread = 0 WHERE run_id = :id", { id });
  });
}

export const countUnread = (db: Database) =>
  db.get<{ n: number }>(
    `SELECT count(*) n FROM job_runs jr JOIN runs r ON r.id = jr.run_id
     WHERE jr.unread = 1 AND r.state IN ('succeeded','failed','cancelled','interrupted','waiting_for_input')`,
  )!.n;

export function saveArtifact(db: Database, a: Artifact): Artifact {
  db.tx(() => {
    db.run(
      `INSERT INTO artifacts (id, run_id, name, path, bytes, pinned, created_at) VALUES (:id, :run, :name, :path, :bytes, :pinned, :created)
       ON CONFLICT(id) DO UPDATE SET pinned = excluded.pinned`,
      {
        id: a.id,
        run: a.runId,
        name: a.name,
        path: a.path,
        bytes: a.bytes,
        pinned: a.pinned ? 1 : 0,
        created: a.createdAt,
      },
    );
    appendEvent(db, { type: "artifact.upserted", artifact: a });
  });
  return a;
}

export const listArtifacts = (db: Database, runId: string) =>
  db.all<Row>("SELECT * FROM artifacts WHERE run_id = :r ORDER BY name", { r: runId }).map(toArtifact);

export const getArtifact = (db: Database, id: string) => {
  const r = db.get<Row>("SELECT * FROM artifacts WHERE id = :id", { id });
  return r ? toArtifact(r) : undefined;
};
