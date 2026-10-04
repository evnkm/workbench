import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Run } from "@workbench/contracts";
import {
  claimJobRun,
  Database,
  getJob,
  getJobRunRow,
  getRun,
  listArtifacts,
  listJobRuns,
  saveJob,
} from "@workbench/db";
import { nextOccurrences } from "@workbench/runtime";
import { CodexProvider } from "../src/codex/provider.ts";
import { Jobs } from "../src/jobs.ts";
import { Workspaces } from "../src/workspaces.ts";
import { makeContext, makeRepo, waitFor } from "./helpers.ts";

const running: Jobs[] = [];
after(() => {
  for (const j of running) j.stop();
});

async function setup(env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const ctx = makeContext();
  const ws = new Workspaces(ctx);
  const jobs = new Jobs(ctx, ws, new CodexProvider(ctx));
  running.push(jobs);
  const { projectId } = await ws.registerProject({ path: makeRepo() });
  const { workspaceId } = await ws.createWorkspace({ projectId, name: "J" });
  const create = (command: string, extra: Record<string, unknown> = {}) =>
    jobs.create({
      name: "job",
      workspaceId,
      projectId: null,
      kind: "shell",
      command,
      isolation: "workspace",
      timeoutSeconds: 60,
      maxAttempts: 1,
      retryUnknownOutcome: false,
      schedule: null,
      ...extra,
    });
  return { ctx, jobs, workspaceId, projectId, create };
}

const state = (ctx: ReturnType<typeof makeContext>, id: string) => getRun(ctx.db, id)!.state;

test("a shell job runs to completion with its log and artifacts", async () => {
  const { ctx, jobs, create } = await setup();
  const { jobId } = await create(
    'echo hello; mkdir -p "$WORKBENCH_ARTIFACTS_DIR/sub"; echo data > "$WORKBENCH_ARTIFACTS_DIR/sub/out.txt"',
  );
  const { runId } = (await jobs.handlers()["job.launch"]!.run({ jobId }, {} as never)) as { runId: string };
  jobs.start();
  await waitFor(() => state(ctx, runId) === "succeeded");
  const detail = getJobRunRow(ctx.db, runId)!;
  assert.equal(detail.exitCode, 0);
  assert.equal(detail.unread, true);
  assert.match(readFileSync(detail.logPath!, "utf8"), /hello/);
  assert.deepEqual(
    listArtifacts(ctx.db, runId).map((a) => a.name),
    ["sub/out.txt"],
  );
});

test("a failing job keeps its log, retries up to maxAttempts, and a manual retry is a new attempt", async () => {
  const { ctx, jobs, create } = await setup();
  const { jobId } = await create("echo partial-output; exit 7", { maxAttempts: 2 });
  jobs.start();
  const { runId } = (await jobs.handlers()["job.launch"]!.run({ jobId }, {} as never)) as { runId: string };
  await waitFor(() => listJobRuns(ctx.db, { jobId }).filter((r) => r.run.state === "failed").length === 2);
  const runs = listJobRuns(ctx.db, { jobId });
  assert.deepEqual(runs.map((r) => r.run.attempt).sort(), [1, 2]);
  assert.equal(getJobRunRow(ctx.db, runId)!.exitCode, 7);
  assert.match(readFileSync(getJobRunRow(ctx.db, runId)!.logPath!, "utf8"), /partial-output/);
  const retry = (await jobs.retry(runId)) as { runId: string };
  await waitFor(() => isDone(state(ctx, retry.runId)));
  assert.equal(getRun(ctx.db, retry.runId)!.attempt, 3);
  assert.equal(getJobRunRow(ctx.db, retry.runId)!.retryOf, runId);
});

const isDone = (s: string) => ["succeeded", "failed", "cancelled", "interrupted"].includes(s);

test("cancel and timeout stop the process group", async () => {
  const { ctx, jobs, create } = await setup();
  jobs.start();
  const a = await create("sleep 300 & sleep 300");
  const { runId } = (await jobs.handlers()["job.launch"]!.run({ jobId: a.jobId }, {} as never)) as { runId: string };
  await waitFor(() => state(ctx, runId) === "running");
  const pgid = getJobRunRow(ctx.db, runId)!.pgid!;
  await jobs.cancel(runId);
  await waitFor(() => state(ctx, runId) === "cancelled");
  assert.throws(() => process.kill(-pgid, 0));

  const b = await create("sleep 300", { timeoutSeconds: 10 });
  const job = getJob(ctx.db, b.jobId)!;
  saveJob(ctx.db, { ...job, timeoutSeconds: 1 }); // below the API minimum, for the test
  const t = (await jobs.handlers()["job.launch"]!.run({ jobId: b.jobId }, {} as never)) as { runId: string };
  await waitFor(() => state(ctx, t.runId) === "failed", 8000);
  assert.match(getRun(ctx.db, t.runId)!.error!, /Timed out/);
});

test("output beyond the limit is truncated", async () => {
  const { ctx, jobs, create } = await setup({ WORKBENCH_RUN_OUTPUT_LIMIT_MB: "1" });
  delete process.env.WORKBENCH_RUN_OUTPUT_LIMIT_MB;
  jobs.start();
  const { jobId } = await create("head -c 3000000 /dev/zero | tr '\\0' x");
  const { runId } = (await jobs.handlers()["job.launch"]!.run({ jobId }, {} as never)) as { runId: string };
  await waitFor(() => state(ctx, runId) === "succeeded", 10_000);
  const log = readFileSync(getJobRunRow(ctx.db, runId)!.logPath!, "utf8");
  assert.ok(log.length < 1.1 * 1024 * 1024);
  assert.match(log, /output truncated/);
});

test("two workers never claim the same queued run", async () => {
  const { ctx, jobs, create } = await setup();
  const { jobId } = await create("true");
  for (let i = 0; i < 30; i++) await jobs.handlers()["job.launch"]!.run({ jobId }, {} as never);
  const other = new Database(ctx.db.path);
  const claimed: Run[] = [];
  for (;;) {
    const a = claimJobRun(ctx.db, "worker-a", 30_000);
    const b = claimJobRun(other, "worker-b", 30_000);
    if (a) claimed.push(a);
    if (b) claimed.push(b);
    if (!a && !b) break;
  }
  assert.equal(claimed.length, 30);
  assert.equal(new Set(claimed.map((r) => r.id)).size, 30);
});

test("a run whose worker died is reconciled as interrupted, never succeeded, and retried only if allowed", async () => {
  const { ctx, jobs, create } = await setup();
  const noRetry = await create("sleep 300", { maxAttempts: 3 });
  const withRetry = await create("sleep 300", { maxAttempts: 3, retryUnknownOutcome: true });
  const ids: string[] = [];
  for (const j of [noRetry, withRetry]) {
    ids.push(((await jobs.handlers()["job.launch"]!.run({ jobId: j.jobId }, {} as never)) as { runId: string }).runId);
  }
  // A "dead" worker claimed both and its leases have expired.
  for (const _ of ids) claimJobRun(ctx.db, "dead-worker", -1000);
  jobs.reconcileExpired();
  for (const id of ids) assert.equal(state(ctx, id), "interrupted");
  assert.equal(listJobRuns(ctx.db, { jobId: noRetry.jobId }).length, 1);
  const retried = listJobRuns(ctx.db, { jobId: withRetry.jobId });
  assert.equal(retried.length, 2);
  assert.equal(retried.find((r) => r.run.attempt === 2)?.run.state, "queued");
});

test("a scheduled occurrence enqueues exactly one run, even with two schedulers", async () => {
  const { ctx, jobs, create } = await setup();
  const { jobId } = await create("true", { schedule: { cron: "*/5 * * * *", timezone: "UTC", overlap: "queue" } });
  const job = getJob(ctx.db, jobId)!;
  const due = new Date(Date.parse(job.nextRunAt!) + 1000);
  const second = new Jobs(ctx, new Workspaces(ctx), new CodexProvider(ctx));
  jobs.schedule(due);
  second.schedule(due);
  jobs.schedule(due);
  const runs = listJobRuns(ctx.db, { jobId });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.detail.occurrenceAt, job.nextRunAt);
  assert.ok(Date.parse(getJob(ctx.db, jobId)!.nextRunAt!) > Date.parse(job.nextRunAt!));
});

test("missed occurrences after downtime are skipped visibly; overlapping ones follow the job policy", async () => {
  const { ctx, jobs, create } = await setup();
  const { jobId } = await create("sleep 300", { schedule: { cron: "* * * * *", timezone: "UTC", overlap: "skip" } });
  const job = getJob(ctx.db, jobId)!;
  // Downtime: the worker comes back 10 minutes after the due time.
  jobs.schedule(new Date(Date.parse(job.nextRunAt!) + 10 * 60_000));
  let runs = listJobRuns(ctx.db, { jobId });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.run.state, "cancelled");
  assert.match(runs[0]!.run.stopReason!, /missed/);
  // Overlap: an occurrence while a run is active is recorded as skipped.
  await jobs.handlers()["job.launch"]!.run({ jobId }, {} as never);
  const next = getJob(ctx.db, jobId)!.nextRunAt!;
  jobs.schedule(new Date(Date.parse(next) + 1000));
  runs = listJobRuns(ctx.db, { jobId });
  assert.ok(runs.some((r) => r.run.stopReason?.includes("previous run was still active")));
});

test("pause stops future triggers; resume recomputes the next occurrence", async () => {
  const { ctx, jobs, create } = await setup();
  const { jobId } = await create("true", { schedule: { cron: "* * * * *", timezone: "UTC", overlap: "queue" } });
  await jobs.update({ jobId, paused: true });
  assert.equal(getJob(ctx.db, jobId)!.nextRunAt, null);
  jobs.schedule(new Date(Date.now() + 3600_000));
  assert.equal(listJobRuns(ctx.db, { jobId }).length, 0);
  await jobs.update({ jobId, paused: false });
  assert.ok(getJob(ctx.db, jobId)!.nextRunAt);
});

test("schedules use their timezone, including daylight saving transitions", () => {
  // 02:30 does not exist on 2026-03-08 in New York: it runs at 03:30 EDT (07:30Z).
  assert.deepEqual(
    nextOccurrences("30 2 * * *", "America/New_York", new Date("2026-03-07T12:00:00Z"), 2).map((d) => d.toISOString()),
    ["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"],
  );
  // 01:30 happens twice on 2026-11-01: it runs once, at the first (EDT) one.
  assert.deepEqual(
    nextOccurrences("30 1 * * *", "America/New_York", new Date("2026-10-31T12:00:00Z"), 2).map((d) => d.toISOString()),
    ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"],
  );
  assert.throws(() => nextOccurrences("* * * * *", "Mars/Olympus", new Date(), 1), /Unknown timezone/);
  assert.throws(() => nextOccurrences("not a cron", "UTC", new Date(), 1));
});

test("retention removes old run directories but keeps pinned artifacts and active runs", async () => {
  const { ctx, jobs, create } = await setup({ WORKBENCH_RUN_RETENTION_DAYS: "0" });
  jobs.start();
  const { jobId } = await create('echo x > "$WORKBENCH_ARTIFACTS_DIR/a.txt"');
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { runId } = (await jobs.handlers()["job.launch"]!.run({ jobId }, {} as never)) as { runId: string };
    await waitFor(() => state(ctx, runId) === "succeeded");
    ids.push(runId);
  }
  const pinned = listArtifacts(ctx.db, ids[0]!)[0]!;
  await jobs.handlers()["artifact.pin"]!.run({ artifactId: pinned.id, pinned: true }, {} as never);
  await new Promise((r) => setTimeout(r, 20));
  jobs.retention();
  delete process.env.WORKBENCH_RUN_RETENTION_DAYS;
  assert.equal(existsSync(join(ctx.config.runsDir, ids[0]!)), true);
  assert.equal(existsSync(join(ctx.config.runsDir, ids[1]!)), false);
});

test("an agent job runs a Codex turn in its own conversation and records the final message", async () => {
  const ctx = makeContext();
  const ws = new Workspaces(ctx);
  const codex = new CodexProvider(ctx);
  await codex.start();
  const jobs = new Jobs(ctx, ws, codex);
  running.push(jobs);
  const { projectId } = await ws.registerProject({ path: makeRepo() });
  const { jobId } = await jobs.create({
    name: "agent",
    workspaceId: null,
    projectId,
    kind: "codex",
    command: "hello",
    isolation: "worktree",
    timeoutSeconds: 60,
    maxAttempts: 1,
    retryUnknownOutcome: false,
    schedule: null,
  });
  jobs.start();
  const { runId } = (await jobs.handlers()["job.launch"]!.run({ jobId }, {} as never)) as { runId: string };
  await waitFor(() => state(ctx, runId) === "succeeded", 10_000);
  const run = getRun(ctx.db, runId)!;
  assert.ok(run.conversationId);
  assert.equal(getJobRunRow(ctx.db, runId)!.finalMessage?.split("\n")[0], "Done.");
  // The disposable worktree made no changes, so it was removed.
  await waitFor(() => !existsSync(getJobRunRow(ctx.db, runId)!.worktreePath!), 5000);
  await codex.stop();
});
