// Background jobs and schedules: run history with filters, run details
// (log, final message, artifacts), and job definitions.
import type { Artifact, Job, JobRunDetail, Run, Workspace } from "@workbench/contracts";
import { isTerminalRunState } from "@workbench/contracts";
import clsx from "clsx";
import { ArrowLeft, Download, Pause, Pencil, Pin, Play, Plus, RotateCcw, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, sendCommand } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { useStore } from "../lib/store.ts";
import { Markdown } from "./Markdown.tsx";
import { LogView } from "./RunPanel.tsx";
import {
  Button,
  Dialog,
  ErrorText,
  Field,
  IconButton,
  inputClass,
  PaneHeader,
  relativeTime,
  StatusIndicator,
} from "./ui.tsx";

type RunRow = { run: Run; detail: JobRunDetail; jobName: string };
const FILTERS = [
  { id: "", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "running", label: "Running" },
  { id: "waiting", label: "Waiting" },
  { id: "failed", label: "Failed" },
  { id: "finished", label: "Finished" },
] as const;

export function JobsView({ runId }: { runId: string | null }) {
  if (runId) return <RunDetail runId={runId} />;
  return <JobsHome />;
}

function JobsHome() {
  const jobs = useStore((s) => s.jobs);
  const version = useStore((s) => s.jobsVersion);
  const [filter, setFilter] = useState<string>("");
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when job runs change.
  useEffect(() => {
    api<{ runs: RunRow[] }>(`/api/job-runs?limit=100${filter ? `&filter=${filter}` : ""}`).then(
      (r) => setRuns(r.runs),
      (e) => setError((e as Error).message),
    );
  }, [filter, version]);

  const act = (fn: () => Promise<unknown>) => fn().catch((e) => setError((e as Error).message));
  const list = useMemo(() => (Object.values(jobs) as Job[]).sort((a, b) => a.name.localeCompare(b.name)), [jobs]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader title="Jobs">
        <Button size="xs" variant="primary" onClick={() => setEditing("new")}>
          <Plus size={13} /> New job
        </Button>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-3 md:p-6">
          <ErrorText>{error}</ErrorText>
          <section aria-labelledby="runs-h">
            <h2 id="runs-h" className="mb-2 text-[13px] font-semibold text-neutral-300">
              Runs
            </h2>
            <div className="mb-2 flex gap-1 overflow-x-auto" role="tablist">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={clsx(
                    "h-8 shrink-0 rounded-md px-3 text-[13px]",
                    filter === f.id ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {runs.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-neutral-500">No runs.</p>
            ) : (
              <ul className="divide-y divide-wb-border overflow-hidden rounded-lg border border-wb-border">
                {runs.map((r) => (
                  <li key={r.run.id}>
                    <button
                      type="button"
                      onClick={() => navigate({ name: "jobs", runId: r.run.id })}
                      className="flex min-h-12 w-full items-center gap-3 bg-wb-panel px-3 py-2 text-left hover:bg-neutral-900"
                    >
                      <StatusIndicator state={r.run.state} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] text-neutral-100">
                          {r.detail.unread && isTerminalRunState(r.run.state) && (
                            <span
                              className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-wb-accent align-middle"
                              role="img"
                              aria-label="unread"
                            />
                          )}
                          {r.jobName}
                        </span>
                        <span className="block truncate text-[12px] text-neutral-500">
                          {r.run.state.replace(/_/g, " ")}
                          {r.run.attempt > 1 ? ` · attempt ${r.run.attempt}` : ""} · {r.detail.trigger}
                          {r.run.stopReason && r.run.state === "cancelled" ? ` · ${r.run.stopReason}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-[12px] text-neutral-500">{relativeTime(r.run.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="defs-h">
            <h2 id="defs-h" className="mb-2 text-[13px] font-semibold text-neutral-300">
              Job definitions
            </h2>
            {list.length === 0 && <p className="text-[13px] text-neutral-500">No jobs yet.</p>}
            <ul className="space-y-2">
              {list.map((j) => (
                <li key={j.id} className="rounded-lg border border-wb-border bg-wb-panel p-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-neutral-100">{j.name}</p>
                      <p className="truncate font-mono text-[12px] text-neutral-500">
                        {j.kind === "codex" ? "Codex: " : "$ "}
                        {j.command}
                      </p>
                      <p className="mt-1 text-[12px] text-neutral-400">
                        {j.schedule
                          ? `${j.schedule.cron} (${j.schedule.timezone})${j.paused ? " · paused" : j.nextRunAt ? ` · next ${new Date(j.nextRunAt).toLocaleString()}` : ""}`
                          : "Manual only"}
                      </p>
                    </div>
                    <IconButton
                      label="Run now"
                      onClick={() => void act(() => sendCommand("job.launch", { jobId: j.id }))}
                    >
                      <Play size={15} />
                    </IconButton>
                    {j.schedule && (
                      <IconButton
                        label={j.paused ? "Resume schedule" : "Pause schedule"}
                        onClick={() => void act(() => sendCommand("job.update", { jobId: j.id, paused: !j.paused }))}
                      >
                        {j.paused ? <Play size={15} className="text-amber-300" /> : <Pause size={15} />}
                      </IconButton>
                    )}
                    <IconButton label="Edit job" onClick={() => setEditing(j)}>
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton
                      label="Delete job"
                      onClick={() =>
                        confirm(`Delete job "${j.name}"? Its run history is kept.`) &&
                        void act(() => sendCommand("job.delete", { jobId: j.id }))
                      }
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
      {editing && <JobDialog job={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const version = useStore((s) => s.jobsVersion);
  const liveRun = useStore((s) => s.runs[runId]);
  const [data, setData] = useState<{ detail: JobRunDetail; run: Run; artifacts: Artifact[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ detail: JobRunDetail; run: Run; artifacts: Artifact[] }>(`/api/runs/${runId}/job`).then(setData, (e) =>
      setError((e as Error).message),
    );
  }, [runId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on changes.
  useEffect(load, [load, version, liveRun?.state]);
  const run = liveRun ?? data?.run;
  const finished = run ? isTerminalRunState(run.state) : false;
  useEffect(() => {
    if (data?.detail.unread && finished) void sendCommand("notification.markRead", { runIds: [runId] }).catch(() => {});
  }, [data?.detail.unread, finished, runId]);
  const act = (fn: () => Promise<unknown>) => fn().then(load, (e) => setError((e as Error).message));
  if (!run || !data) return <p className="p-6 text-[13px] text-neutral-500">{error ?? "Loading…"}</p>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        leading={
          <IconButton label="Back to jobs" onClick={() => navigate({ name: "jobs", runId: null })}>
            <ArrowLeft size={16} />
          </IconButton>
        }
        title={run.summary}
      >
        {!finished && (
          <Button size="xs" variant="danger" onClick={() => act(() => sendCommand("job.cancel", { runId }))}>
            <Square size={11} fill="currentColor" /> Cancel
          </Button>
        )}
        {finished && (
          <Button size="xs" onClick={() => act(() => sendCommand("job.retry", { runId }))}>
            <RotateCcw size={12} /> Retry
          </Button>
        )}
      </PaneHeader>
      <div className="shrink-0 space-y-1.5 border-b border-wb-border px-3 py-2 text-[13px] md:px-6">
        <p className="flex items-center gap-2">
          <StatusIndicator state={run.state} />
          <span className="text-neutral-200">{run.state.replace(/_/g, " ")}</span>
          <span className="text-neutral-500">
            · attempt {run.attempt} · {data.detail.trigger}
            {data.detail.occurrenceAt ? ` for ${new Date(data.detail.occurrenceAt).toLocaleString()}` : ""}
            {data.detail.exitCode != null ? ` · exit ${data.detail.exitCode}` : ""}
          </span>
        </p>
        {run.error && <p className="text-red-300">{run.error}</p>}
        {run.stopReason && run.state === "cancelled" && <p className="text-neutral-400">{run.stopReason}</p>}
        {run.state === "waiting_for_input" && (
          <p className="text-amber-300">The agent is waiting for input in its conversation.</p>
        )}
        {run.conversationId && run.workspaceId && (
          <button
            type="button"
            className="text-wb-accent underline"
            onClick={() =>
              navigate({
                name: "workspace",
                workspaceId: run.workspaceId!,
                conversationId: run.conversationId,
                pane: "conversation",
              })
            }
          >
            Open the agent conversation
          </button>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.detail.finalMessage && (
          <section className="border-b border-wb-border px-3 py-3 md:px-6">
            <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">Result</h3>
            <Markdown text={data.detail.finalMessage} />
          </section>
        )}
        {data.artifacts.length > 0 && (
          <section className="border-b border-wb-border px-3 py-3 md:px-6">
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">Artifacts</h3>
            <ul className="space-y-1">
              {data.artifacts.map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-[13px]">
                  <a
                    href={`/api/artifacts/${a.id}/download`}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-neutral-200 underline"
                  >
                    <Download size={13} className="shrink-0" />
                    <span className="truncate font-mono">{a.name}</span>
                  </a>
                  <span className="text-[12px] text-neutral-500">{(a.bytes / 1024).toFixed(1)} KiB</span>
                  <IconButton
                    label={a.pinned ? "Unpin artifact" : "Pin artifact (exempt from retention)"}
                    onClick={() => act(() => sendCommand("artifact.pin", { artifactId: a.id, pinned: !a.pinned }))}
                  >
                    <Pin size={14} className={a.pinned ? "text-wb-accent" : ""} />
                  </IconButton>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="h-[60dvh] min-h-64">
          <LogView runId={runId} live={!finished} />
        </section>
      </div>
    </div>
  );
}

function JobDialog({ job, onClose }: { job: Job | null; onClose: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const projects = useStore((s) => s.projects);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [name, setName] = useState(job?.name ?? "");
  const [kind, setKind] = useState<"shell" | "codex">(job?.kind ?? "shell");
  const [command, setCommand] = useState(job?.command ?? "");
  const [isolation, setIsolation] = useState<"workspace" | "worktree">(job?.isolation ?? "workspace");
  const [workspaceId, setWorkspaceId] = useState(job?.workspaceId ?? "");
  const [projectId, setProjectId] = useState(job?.projectId ?? "");
  const [timeout, setTimeoutS] = useState(String(job?.timeoutSeconds ?? 3600));
  const [attempts, setAttempts] = useState(String(job?.maxAttempts ?? 1));
  const [retryUnknown, setRetryUnknown] = useState(job?.retryUnknownOutcome ?? false);
  const [scheduled, setScheduled] = useState(Boolean(job?.schedule));
  const [cron, setCron] = useState(job?.schedule?.cron ?? "0 9 * * *");
  const [tz, setTz] = useState(job?.schedule?.timezone ?? "UTC");
  const [overlap, setOverlap] = useState<"skip" | "queue">(job?.schedule?.overlap ?? "skip");
  const [preview, setPreview] = useState<{ next?: string[]; error?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!scheduled) return;
    const t = setTimeout(() => {
      fetch(`/api/schedule/preview?cron=${encodeURIComponent(cron)}&tz=${encodeURIComponent(tz)}`)
        .then((r) => r.json())
        .then(setPreview, () => {});
    }, 300);
    return () => clearTimeout(t);
  }, [cron, tz, scheduled]);

  const ws = (Object.values(workspaces) as Workspace[]).filter((w) => w.state !== "archived");
  const schedule = scheduled ? { cron: cron.trim(), timezone: tz.trim(), overlap } : null;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (job) {
        await sendCommand("job.update", { jobId: job.id, name, command, timeoutSeconds: Number(timeout), schedule });
      } else {
        await sendCommand("job.create", {
          name,
          kind,
          command,
          isolation,
          workspaceId: isolation === "workspace" ? workspaceId || null : null,
          projectId: isolation === "worktree" ? projectId || null : null,
          timeoutSeconds: Number(timeout),
          maxAttempts: Number(attempts),
          retryUnknownOutcome: retryUnknown,
          schedule,
        });
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={job ? "Edit job" : "New job"} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        {!job && (
          <Field label="Type">
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as "shell" | "codex")}>
              <option value="shell">Shell command</option>
              <option value="codex">Codex task (runs without approvals)</option>
            </select>
          </Field>
        )}
        <Field
          label={kind === "codex" ? "Prompt" : "Command"}
          hint={
            kind === "shell"
              ? "Runs with bash -lc. Files written to $WORKBENCH_ARTIFACTS_DIR become downloadable artifacts."
              : undefined
          }
        >
          <textarea
            className={`${inputClass} min-h-24 font-mono`}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            required
          />
        </Field>
        {!job && (
          <>
            <Field label="Where it runs">
              <select
                className={inputClass}
                value={isolation}
                onChange={(e) => setIsolation(e.target.value as "workspace" | "worktree")}
              >
                <option value="workspace">In an existing workspace</option>
                <option value="worktree">In a new disposable worktree (removed afterwards if unchanged)</option>
              </select>
            </Field>
            {isolation === "workspace" ? (
              <Field label="Workspace">
                <select
                  className={inputClass}
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  required
                >
                  <option value="">Choose…</option>
                  {ws.map((w) => (
                    <option key={w.id} value={w.id}>
                      {projects[w.projectId]?.name} / {w.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Project">
                <select
                  className={inputClass}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  required
                >
                  <option value="">Choose…</option>
                  {Object.values(projects).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Timeout (seconds)">
            <input
              className={inputClass}
              type="number"
              min={10}
              max={86400}
              value={timeout}
              onChange={(e) => setTimeoutS(e.target.value)}
            />
          </Field>
          {!job && (
            <Field label="Max attempts" hint="Failed runs retry automatically.">
              <input
                className={inputClass}
                type="number"
                min={1}
                max={5}
                value={attempts}
                onChange={(e) => setAttempts(e.target.value)}
              />
            </Field>
          )}
        </div>
        {!job && (
          <label className="flex items-start gap-2 text-[13px] text-neutral-300">
            <input
              type="checkbox"
              className="mt-1"
              checked={retryUnknown}
              onChange={(e) => setRetryUnknown(e.target.checked)}
            />
            <span>
              Also retry when the outcome is unknown (the worker stopped mid-run). Only enable this for jobs that are
              safe to repeat.
            </span>
          </label>
        )}
        <fieldset className="space-y-3 rounded-lg border border-wb-border p-3">
          <label className="flex items-center gap-2 text-[13px] text-neutral-200">
            <input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} />
            Run on a schedule
          </label>
          {scheduled && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cron (minute hour day month weekday)">
                  <input className={`${inputClass} font-mono`} value={cron} onChange={(e) => setCron(e.target.value)} />
                </Field>
                <Field
                  label="Timezone"
                  hint={
                    tz !== browserTz ? (
                      <button type="button" className="underline" onClick={() => setTz(browserTz)}>
                        Use {browserTz}
                      </button>
                    ) : undefined
                  }
                >
                  <input className={inputClass} value={tz} onChange={(e) => setTz(e.target.value)} />
                </Field>
              </div>
              <Field label="If the previous run is still active">
                <select
                  className={inputClass}
                  value={overlap}
                  onChange={(e) => setOverlap(e.target.value as "skip" | "queue")}
                >
                  <option value="skip">Skip this occurrence (recorded in history)</option>
                  <option value="queue">Queue it</option>
                </select>
              </Field>
              <div className="text-[12px] text-neutral-400">
                {preview.error ? (
                  <span className="text-red-300">{preview.error}</span>
                ) : (
                  <>
                    Next: {(preview.next ?? []).map((d) => new Date(d).toLocaleString()).join(" · ")}
                    <span className="block text-neutral-500">
                      Occurrences missed while Workbench is down are skipped, not replayed.
                    </span>
                  </>
                )}
              </div>
            </>
          )}
        </fieldset>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || !command.trim()}>
            {job ? "Save" : "Create job"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
