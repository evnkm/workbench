# 0007 Background jobs, schedules, and notifications

Status: accepted, October 4, 2026 (Phases 7 and 8).

## Execution model

- A job is a definition. Each execution is a `runs` row (kind `job`) plus a `job_runs` row holding the trigger, occurrence, process ids, lease, deadline, log, final message, and unread flag.
- **Shell jobs** run `bash -lc <command>` in their own process group. **Codex jobs** reuse the conversation provider: the job creates a conversation with approvals set to `never`, submits the prompt as a turn, and mirrors the turn's state. There is no separate agent execution path. A Codex job that waits for input shows as `waiting_for_input` and is marked unread, so it is never silently stuck.
- **Isolation:** a job runs in an existing workspace, or in a new disposable worktree workspace. The disposable worktree and its branch are removed only if the run left no uncommitted changes and no new commits. Otherwise the workspace is kept and the result names it.
- **Queue:** `queued` runs are claimed by a single conditional `UPDATE … RETURNING`, so two workers can never claim the same attempt (tested with two connections). Concurrency is `WORKBENCH_JOB_CONCURRENCY` (default 2).
- **Leases:** the executing worker renews a 30-second lease every 10 seconds. When an active run's lease expires, the run is reconciled:
  - any leftover process group is killed;
  - the run is marked `interrupted` (outcome unknown);
  - it is retried only if the job enabled "retry unknown outcome" and attempts remain.

  Under systemd, the worker's children die with it. In development, the reconciler kills them.
- **Retries:** a failed run with a known outcome (non-zero exit or timeout) retries automatically until `maxAttempts`. Every attempt is its own run, linked by `retry_of`. A manual retry always creates a new attempt.
- **Cancellation and timeouts:** a queued run is cancelled directly. An active run gets SIGTERM to its process group, then SIGKILL after 10 seconds. A Codex job is interrupted through the provider instead. Deadlines are also enforced by the 1-second tick, in case a timer is lost.
- **Output and artifacts:** output goes to `runs/<runId>/output.log`, capped at `WORKBENCH_RUN_OUTPUT_LIMIT_MB` per run, and partial output is kept after a failure. Files written to `$WORKBENCH_ARTIFACTS_DIR` are registered as downloadable artifacts.
- **Retention:** run directories older than `WORKBENCH_RUN_RETENTION_DAYS` are deleted hourly. When the total exceeds `WORKBENCH_RUNS_DISK_LIMIT_MB`, the oldest are deleted first. Active runs and runs with pinned artifacts are never deleted.

## Schedules

- Five-field cron with an explicit IANA timezone (default UTC), using `cron-parser` 5.10.1. The UI previews the next five occurrences.
- **One run per occurrence:** the due occurrence's run is inserted with `UNIQUE (job_id, occurrence_at)` in the same transaction that advances `next_run_at`, and only if `next_run_at` still equals the occurrence. Repeated ticks and two schedulers therefore produce one run (tested). This is one *enqueue* per occurrence, not exactly-once external side effects: a run can still fail after partially changing files.
- **Missed occurrences:** an occurrence found more than 90 seconds late, because the worker was down, is recorded once as a `cancelled` run ("missed") and not executed. Later occurrences continue normally; there is no backlog.
- **Overlap:** per job. `skip` (the default) records the occurrence as a `cancelled` run ("skipped: the previous run was still active"). `queue` enqueues it behind the active run.
- **Pause and resume:** pause clears `next_run_at`, so nothing triggers, and runs already in progress continue. Resume, or any change to the schedule or timezone, recomputes the next occurrence from the current time.
- **Daylight saving (verified):** a local time skipped by spring-forward runs one hour later (02:30 runs at 03:30). A local time repeated by fall-back runs once, at its first occurrence.

## Notifications

There are in-app notifications only. A job run is unread when it finishes or starts waiting for input. The sidebar's Jobs button shows the unread count, the phone menu button shows a dot, and the Jobs view has an Unread filter. Opening a finished run marks it read.

Browser push and external channels (Slack, email) are not implemented, as the plan requires them to be explicitly requested and configured.
