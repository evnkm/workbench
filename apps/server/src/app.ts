// HTTP API. Reads come straight from SQLite; mutations become durable
// commands for the worker. Event delivery is snapshot + cursor replay.
import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { type AppEvent, commandRequestSchema, commandSchemas } from "@workbench/contracts";
import {
  type Config,
  countUnread,
  type Database,
  eventsAfter,
  getArtifact,
  getCommand,
  getConversation,
  getItem,
  getJobRunRow,
  getProcess,
  getProject,
  getRun,
  getWorkerStatus,
  getWorkspace,
  insertCommand,
  type Logger,
  latestSeq,
  listActiveRuns,
  listArtifacts,
  listConversationInputs,
  listConversationRuns,
  listConversations,
  listItems,
  listJobRuns,
  listJobs,
  listOpenInputs,
  listProcesses,
  listProjects,
  listWorkspaces,
  oldestSeq,
  saveItem,
} from "@workbench/db";
import {
  fileDiff,
  status as gitStatus,
  markdownImages,
  nextOccurrences,
  portFor,
  readProjectConfig,
  readRetainedImage,
  retainImages,
} from "@workbench/runtime";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Auth } from "./auth.ts";
import type { Previews } from "./previews.ts";
import { captureHistory } from "./terminals.ts";
import type { WorkerLink } from "./worker-link.ts";

export type AppDeps = {
  db: Database;
  config: Config;
  auth: Auth;
  link: WorkerLink;
  log: Logger;
  previews?: Previews;
  /** Extra routers mounted under /api (processes, jobs, previews). */
  extend?: (app: Hono) => void;
};

const HEARTBEAT_MS = 15_000;
const STALE_WORKER_MS = 20_000;

export function createApp({ db, config, auth, link, log, previews, extend }: AppDeps) {
  const app = new Hono();

  app.onError((err, c) => {
    log.error("request failed", { path: c.req.path, err });
    return c.json({ error: "Internal error." }, 500);
  });

  app.use("/api/*", auth.middleware());

  app.get("/api/health", (c) => {
    const worker = getWorkerStatus(db);
    const fresh = worker ? Date.now() - Date.parse(worker.heartbeatAt) < STALE_WORKER_MS : false;
    return c.json(
      { ok: fresh, workerConnected: link.connected, workerFresh: fresh, health: worker?.health ?? null },
      fresh ? 200 : 503,
    );
  });

  // ---------------------------------------------------------------- auth

  app.post("/api/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    const r = auth.login(c, typeof body.password === "string" ? body.password : "");
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
  });
  app.post("/api/auth/logout", (c) => {
    auth.logout(c);
    return c.json({ ok: true });
  });
  app.get("/api/auth/session", (c) => c.json({ ok: true }));

  // ---------------------------------------------------------------- state

  app.get("/api/state", (c) =>
    c.json(
      db.read(() => {
        const worker = getWorkerStatus(db);
        return {
          cursor: latestSeq(db),
          projects: listProjects(db),
          workspaces: listWorkspaces(db),
          conversations: listConversations(db),
          activeRuns: listActiveRuns(db),
          openInputs: listOpenInputs(db),
          processes: listProcesses(db),
          jobs: listJobs(db),
          unread: countUnread(db),
          worker: worker && {
            ...worker,
            connected: link.connected,
            stale: Date.now() - Date.parse(worker.heartbeatAt) > STALE_WORKER_MS,
          },
        };
      }),
    ),
  );

  app.get("/api/conversations/:id/snapshot", (c) => {
    const id = c.req.param("id");
    const before = c.req.query("before");
    const limit = Math.min(Number(c.req.query("limit") ?? 80), 300);
    const snap = db.read(() => {
      const conversation = getConversation(db, id);
      if (!conversation) return null;
      const page = listItems(db, id, before ? Number(before) : null, limit);
      return {
        cursor: latestSeq(db),
        conversation,
        items: page.items,
        hasMore: page.hasMore,
        runs: listConversationRuns(db, id),
        inputs: listConversationInputs(db, id),
      };
    });
    return snap ? c.json(snap) : c.json({ error: "Conversation not found." }, 404);
  });

  app.get("/api/runs/:id", (c) => {
    const run = getRun(db, c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "Run not found." }, 404);
  });

  // Only serve image sources actually attached to this stored conversation item.
  app.get("/api/items/:id/image", (c) => {
    const item = getItem(db, c.req.param("id"));
    const source = c.req.query("source");
    if (!item || !source) return c.json({ error: "Image not found." }, 404);
    const images = item.data.images ?? [];
    const referenced =
      images.find((image) => image.source === source) ??
      markdownImages(item.data.text ?? "").find((image) => image.source === source);
    if (!referenced) return c.json({ error: "Image not found." }, 404);
    const conv = getConversation(db, item.conversationId)!;
    const workspace = getWorkspace(db, conv.workspaceId)!;
    const retained = retainImages(config.stateDir, workspace.worktreePath, [referenced])[0]!;
    if (!retained.mediaId) return c.json({ error: retained.error ?? "Image is unavailable." }, 404);
    if (!referenced.mediaId && item.status === "completed") {
      saveItem(db, {
        ...item,
        data: { ...item.data, images: [...images.filter((image) => image.source !== source), retained] },
      });
    }
    try {
      const image = readRetainedImage(config.stateDir, retained.mediaId);
      c.header("Content-Type", image.contentType);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cache-Control", "private, no-cache");
      return c.body(new Uint8Array(image.bytes));
    } catch {
      return c.json({ error: "Retained image is unavailable." }, 404);
    }
  });

  /** Bounded read of a run's output log, from `offset` (or the last 64 KiB). */
  app.get("/api/runs/:id/log", (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: "Invalid run id." }, 400);
    const path = join(config.runsDir, id, "output.log");
    if (!existsSync(path)) return c.json({ text: "", offset: 0, size: 0 });
    const size = statSync(path).size;
    const max = 64 * 1024;
    const requested = c.req.query("offset");
    const start = requested === undefined ? Math.max(0, size - max) : Math.min(Number(requested), size);
    const len = Math.min(max, size - start);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    return c.json({ text: buf.toString("utf8"), offset: start + len, size, start });
  });

  // ---------------------------------------------------------------- git

  app.get("/api/workspaces/:id/changes", async (c) => {
    const w = getWorkspace(db, c.req.param("id"));
    if (!w) return c.json({ error: "Workspace not found." }, 404);
    if (!existsSync(w.worktreePath)) return c.json({ error: "The worktree does not exist." }, 409);
    return c.json(await gitStatus(w.worktreePath, w.baseRef));
  });

  app.get("/api/workspaces/:id/diff", async (c) => {
    const w = getWorkspace(db, c.req.param("id"));
    const path = c.req.query("path");
    if (!w || !path) return c.json({ error: "Workspace or path missing." }, 400);
    if (path.startsWith("/") || path.split("/").includes("..")) return c.json({ error: "Invalid path." }, 400);
    const untracked = c.req.query("untracked") === "1";
    return c.json(await fileDiff(w.worktreePath, path, untracked, 256 * 1024));
  });

  app.get("/api/workspaces/:id/setup-run", (c) => {
    const r = db.get<{ id: string }>(
      "SELECT id FROM runs WHERE workspace_id = :w AND kind = 'workspace_setup' ORDER BY created_at DESC LIMIT 1",
      { w: c.req.param("id") },
    );
    return c.json({ runId: r?.id ?? null });
  });

  app.get("/api/workspaces/:id/editor", (c) => {
    const w = getWorkspace(db, c.req.param("id"));
    if (!w) return c.json({ error: "Workspace not found." }, 404);
    const host = process.env.WORKBENCH_SSH_HOST ?? null;
    return c.json({
      path: w.worktreePath,
      sshHost: host,
      cursorUrl: host ? `cursor://vscode-remote/ssh-remote+${host}${w.worktreePath}?windowId=_blank` : null,
      vscodeUrl: host ? `vscode://vscode-remote/ssh-remote+${host}${w.worktreePath}?windowId=_blank` : null,
      project: getProject(db, w.projectId)?.name ?? null,
    });
  });

  // ---------------------------------------------------------------- processes

  app.get("/api/processes/:id/history", async (c) => {
    const proc = getProcess(db, c.req.param("id"));
    if (!proc) return c.json({ error: "Process not found." }, 404);
    const lines = Math.min(Number(c.req.query("lines") ?? 2000), 10_000);
    return c.json({ text: await captureHistory(config, proc.tmuxSession, lines) });
  });

  /** Run configuration, reserved ports, and the latest app process for a workspace. */
  app.get("/api/workspaces/:id/run", (c) => {
    const w = getWorkspace(db, c.req.param("id"));
    if (!w) return c.json({ error: "Workspace not found." }, 404);
    const project = getProject(db, w.projectId)!;
    const cfg = existsSync(w.worktreePath) ? readProjectConfig(project, w.worktreePath) : null;
    return c.json({
      config: cfg && {
        source: cfg.source,
        error: cfg.error,
        setupCommand: cfg.setupCommand,
        runCommand: cfg.runCommand,
        ports: cfg.ports.map((name) => ({ name, port: portFor(cfg, w, name) })),
        previews: cfg.previews.map((p) => ({ ...p, port: portFor(cfg, w, p.port) })),
      },
      previewHost: previews?.urlHost ?? null,
    });
  });

  app.post("/api/workspaces/:id/preview", async (c) => {
    const w = getWorkspace(db, c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    if (!w || !previews) return c.json({ error: "Previews are unavailable." }, 404);
    const cfg = readProjectConfig(getProject(db, w.projectId)!, w.worktreePath);
    const target = cfg.previews.find((p) => p.name === body.name) ?? cfg.previews[0];
    const port = target ? portFor(cfg, w, target.port) : null;
    const running = listProcesses(db).some((p) => p.workspaceId === w.id && p.kind === "app" && p.state === "running");
    if (!target || port == null || !running) return c.json({ error: "Start the app before opening a preview." }, 409);
    try {
      return c.json({ url: await previews.link(port, target.path) });
    } catch (e) {
      return c.json({ error: `Could not open a preview listener: ${(e as Error).message}` }, 500);
    }
  });

  // ---------------------------------------------------------------- jobs

  app.get("/api/job-runs", (c) => {
    const filter = c.req.query("filter") as Parameters<typeof listJobRuns>[1]["filter"];
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
    return c.json({
      runs: listJobRuns(db, { jobId: c.req.query("job") || undefined, filter, limit }),
      unread: countUnread(db),
    });
  });

  app.get("/api/runs/:id/job", (c) => {
    const detail = getJobRunRow(db, c.req.param("id"));
    if (!detail) return c.json({ error: "Job run not found." }, 404);
    return c.json({ detail, run: getRun(db, detail.runId), artifacts: listArtifacts(db, detail.runId) });
  });

  app.get("/api/artifacts/:id/download", (c) => {
    const a = getArtifact(db, c.req.param("id"));
    // Only files inside the runs directory are ever served.
    if (!a || !resolve(a.path).startsWith(`${resolve(config.runsDir)}/`) || !existsSync(a.path)) {
      return c.json({ error: "Artifact not found." }, 404);
    }
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${basename(a.name).replace(/"/g, "")}"`);
    c.header("Content-Length", String(statSync(a.path).size));
    return c.body(Readable.toWeb(createReadStream(a.path)) as ReadableStream);
  });

  app.get("/api/schedule/preview", (c) => {
    try {
      const next = nextOccurrences(c.req.query("cron") ?? "", c.req.query("tz") ?? "UTC", new Date(), 5);
      return c.json({ next: next.map((d) => d.toISOString()) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ---------------------------------------------------------------- commands

  app.post("/api/commands", async (c) => {
    const parsed = commandRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid command request." }, 400);
    const { requestId, type, payload } = parsed.data;
    const valid = commandSchemas[type].safeParse(payload);
    if (!valid.success) {
      return c.json({ error: valid.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    }
    const r = insertCommand(db, requestId, type, valid.data);
    if (r.conflict) return c.json({ error: "This request id was already used for a different command." }, 409);
    if (r.created) link.wake();
    const waitMs = Math.min(Number(c.req.query("wait") ?? 10_000), 30_000);
    const command = await waitForCommand(db, r.command.id, waitMs);
    return c.json({ command });
  });

  app.get("/api/commands/:id", (c) => {
    const command = getCommand(db, c.req.param("id"));
    return command ? c.json({ command }) : c.json({ error: "Command not found." }, 404);
  });

  // ---------------------------------------------------------------- events

  app.get("/api/events", (c) => {
    const conversationId = c.req.query("conversation") || null;
    const lastId = c.req.header("last-event-id");
    let cursor = Number(lastId ?? c.req.query("after") ?? 0);
    return streamSSE(c, async (stream) => {
      let wake: (() => void) | null = null;
      const onEvents = () => wake?.();
      link.on("events", onEvents);
      stream.onAbort(() => {
        link.off("events", onEvents);
        wake?.();
      });
      const latest = latestSeq(db);
      // A cursor older than retained history, or newer than the log (after a
      // restore), cannot be replayed: tell the client to reload a snapshot.
      if (cursor > latest || (cursor > 0 && cursor < oldestSeq(db) - 1)) {
        await stream.writeSSE({ event: "reset", data: JSON.stringify({ reason: "cursor not retained" }) });
        return;
      }
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ cursor, workerConnected: link.connected }) });
      let lastBeat = Date.now();
      while (!stream.aborted) {
        let batch: AppEvent[];
        do {
          batch = eventsAfter(db, cursor, conversationId, 500);
          for (const e of batch) {
            await stream.writeSSE({ id: String(e.seq), event: "event", data: JSON.stringify(e) });
            cursor = e.seq;
          }
        } while (batch.length === 500 && !stream.aborted);
        if (Date.now() - lastBeat > HEARTBEAT_MS) {
          const heartbeatAt = getWorkerStatus(db)?.heartbeatAt ?? null;
          await stream.writeSSE({
            event: "heartbeat",
            data: JSON.stringify({ workerConnected: link.connected, heartbeatAt }),
          });
          lastBeat = Date.now();
        }
        // Woken by the worker's notification; the timeout is the fallback poll.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, link.connected ? 5000 : 1000);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = null;
      }
    });
  });

  extend?.(app);
  return app;
}

async function waitForCommand(db: Database, id: string, waitMs: number) {
  const deadline = Date.now() + waitMs;
  let command = getCommand(db, id)!;
  while ((command.state === "accepted" || command.state === "claimed") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 40));
    command = getCommand(db, id)!;
  }
  return command;
}
