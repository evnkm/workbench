// Codex conversations through one app-server child process. See
// docs/decisions/0002-codex-app-server.md for the observed protocol behavior
// this module relies on.
import {
  type CommandPayload,
  type Conversation,
  type ConversationItem,
  isTerminalRunState,
  nowIso,
  type PendingInput,
  type Run,
  uuidv7,
  type Workspace,
} from "@workbench/contracts";
import {
  appendItemDelta,
  cancelOpenInputsForRun,
  createInput,
  deleteConversation,
  getConversation,
  getInput,
  getItem,
  getItemByProviderId,
  getRun,
  getWorkspace,
  latestSeq,
  listActiveRuns,
  resolveInput,
  saveConversation,
  saveItem,
  saveRun,
  updateConversation,
  updateRun,
} from "@workbench/db";
import { markdownImages, retainImages } from "@workbench/runtime";
import { claimQueuedTurn, conversationBusy } from "../agent-queue.ts";
import { CommandError, type Handlers } from "../commands.ts";
import type { WorkerContext } from "../context.ts";
import { saveFork } from "../fork.ts";
import { sessionInstructions } from "../session-context.ts";
import { exec, sleep } from "../util.ts";
import { AppServer, RpcError } from "./appserver.ts";
import { MAX_OUTPUT_CHARS, mapItem, mapServerRequest, replyFor, runStateForTurn } from "./mapping.ts";
import { readMenu, readModels } from "./menu.ts";
import type { RequestId } from "./protocol/RequestId.ts";
import type { ReviewStartResponse } from "./protocol/v2/ReviewStartResponse.ts";
import type { ThreadForkResponse } from "./protocol/v2/ThreadForkResponse.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { Turn } from "./protocol/v2/Turn.ts";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.ts";
import { CODEX_PROTOCOL_VERSION } from "./protocol/version.ts";

const DELTA_FLUSH_MS = 100;
const TOOL_KINDS = new Set(["command", "file_change", "tool_call", "web_search", "image", "other"]);
const isToolItem = (item: ThreadItem) => TOOL_KINDS.has(mapItem(item, true).kind);
const ACTIVE_AGENT_STATES = new Set(["starting", "running", "waiting_for_input", "stopping"]);

type CodexState = { state: "starting" | "ready" | "unavailable"; version: string | null; error: string | null };
type DeltaBuffer = { item: ConversationItem; field: "text" | "output"; chunks: string[] };

export class CodexProvider {
  private readonly ctx: WorkerContext;
  private server: AppServer | null = null;
  private starting: Promise<AppServer> | null = null;
  private generation = 0;
  private restartDelay = 1000;
  /** App-server exits since the worker started, for health reporting. */
  restarts = 0;
  private stopped = false;
  status: CodexState = { state: "starting", version: null, error: null };
  onStatusChange: () => void = () => {};

  /** Threads resumed or started in the current app-server process. */
  private loadedThreads = new Set<string>();
  /** Provider turn id → run id for turns started by this worker. */
  private turnRuns = new Map<string, string>();
  /** Thread id → run id for a turn/start whose response has not arrived. */
  private pendingStarts = new Map<string, string>();
  private interruptRequested = new Set<string>();
  private steering = new Map<string, string>();
  /** Pending input id → the app-server request it answers. */
  private inputRoutes = new Map<string, { generation: number; rpcId: RequestId }>();
  /** In-progress items, keyed by `${conversationId}:${providerItemId}`. */
  private liveItems = new Map<string, ConversationItem>();
  private deltas = new Map<string, DeltaBuffer>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(ctx: WorkerContext) {
    this.ctx = ctx;
  }

  handlers(): Handlers {
    return {
      "conversation.create": { key: (p) => `workspace:${p.workspaceId}`, run: (p) => this.createConversation(p) },
      "conversation.rename": {
        key: (p) => `conversation:${p.conversationId}`,
        run: async (p) => {
          this.requireConversation(p.conversationId);
          updateConversation(this.ctx.db, p.conversationId, { title: p.title });
          this.ctx.published();
          return { conversationId: p.conversationId };
        },
      },
      "conversation.delete": {
        key: (p) => `conversation:${p.conversationId}`,
        run: (p) => this.deleteConversation(p),
      },
      "conversation.configure": {
        key: (p) => `conversation:${p.conversationId}`,
        run: (p) => this.configureConversation(p),
      },
      "conversation.inspect": {
        key: (p) => `conversation:${p.conversationId}`,
        run: async (p) => {
          const conv = this.requireConversation(p.conversationId);
          return readMenu(await this.ensureServer(), conv, getWorkspace(this.ctx.db, conv.workspaceId)!, p.view);
        },
      },
      "conversation.action": { key: (p) => `conversation:${p.conversationId}`, run: (p) => this.conversationAction(p) },
      "turn.start": { key: (p) => `conversation:${p.conversationId}`, run: (p) => this.submitTurn(p) },
      "turn.interrupt": { key: (p) => `conversation:${p.conversationId}`, run: (p) => this.interrupt(p) },
      "input.respond": { key: (p) => `input:${p.inputId}`, run: (p) => this.respond(p) },
    };
  }

  // ------------------------------------------------------------ process lifecycle

  async start() {
    const r = await exec(this.ctx.config.codexBin, ["--version"]);
    const version = r.code === 0 ? r.stdout.trim().replace(/^codex-cli\s+/, "") : null;
    this.status.version = version;
    if (!version) return this.setUnavailable(`Codex CLI not found (${this.ctx.config.codexBin}).`);
    if (version !== CODEX_PROTOCOL_VERSION && process.env.WORKBENCH_CODEX_ALLOW_UNTESTED !== "1") {
      return this.setUnavailable(
        `Codex ${version} is installed, but Workbench was tested against ${CODEX_PROTOCOL_VERSION}. ` +
          "Rerun probes/codex, regenerate the protocol types, and run the tests before using it.",
      );
    }
    try {
      await this.ensureServer();
    } catch (e) {
      this.ctx.log.error("codex app-server failed to start", { err: e });
    }
    await this.reconcile();
  }

  private setUnavailable(error: string) {
    this.status = { ...this.status, state: "unavailable", error };
    this.ctx.log.warn("codex unavailable", { error });
    this.onStatusChange();
  }

  private ensureServer(): Promise<AppServer> {
    if (this.status.state === "unavailable" && this.status.error?.includes("tested against")) {
      return Promise.reject(new CommandError(this.status.error));
    }
    if (this.server?.alive) return Promise.resolve(this.server);
    this.starting ??= (async () => {
      const gen = ++this.generation;
      const server = new AppServer(this.ctx.config.codexBin, gen, this.ctx.log);
      server.on("notification", (m, p) => this.safely(() => this.onNotification(m, p as Record<string, unknown>)));
      server.on("request", (id, m, p) =>
        this.safely(() => this.onRequest(server, id, m, p as Record<string, unknown>)),
      );
      server.on("exit", (code, signal) => this.onExit(server, code, signal));
      try {
        const init = await server.start();
        this.server = server;
        this.loadedThreads.clear();
        this.restartDelay = 1000;
        this.status = { state: "ready", version: this.status.version, error: null };
        this.ctx.log.info("codex app-server ready", { generation: gen, userAgent: init.userAgent });
        this.onStatusChange();
        return server;
      } catch (e) {
        server.stop("SIGKILL");
        this.status = { ...this.status, state: "unavailable", error: (e as Error).message };
        this.onStatusChange();
        throw e;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  private safely(fn: () => unknown) {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch((e) => this.ctx.log.error("codex event handling failed", { err: e }));
    } catch (e) {
      this.ctx.log.error("codex event handling failed", { err: e });
    }
  }

  private onExit(server: AppServer, code: number | null, signal: string | null) {
    if (this.server !== server) return;
    this.server = null;
    this.loadedThreads.clear();
    this.pendingStarts.clear();
    // Every turn belonged to the dead process; reconcile decides their outcome.
    this.turnRuns.clear();
    this.liveItems.clear();
    this.deltas.clear();
    if (this.stopped) return;
    this.restarts++;
    this.ctx.log.error("codex app-server exited", { code, signal, generation: server.generation });
    this.status = { ...this.status, state: "unavailable", error: `Codex app-server exited (${code ?? signal}).` };
    this.onStatusChange();
    // Answers can no longer reach the requests that process issued.
    for (const [inputId, route] of this.inputRoutes) {
      if (route.generation === server.generation) {
        this.inputRoutes.delete(inputId);
        resolveInput(this.ctx.db, inputId, "cancelled", null);
      }
    }
    this.ctx.published();
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
    void sleep(delay).then(async () => {
      if (this.stopped) return;
      try {
        await this.ensureServer();
      } catch (e) {
        this.ctx.log.error("codex restart failed", { err: e });
      }
      await this.reconcile();
    });
  }

  /**
   * Bring runs that this process is not tracking to a confirmed state: read
   * the provider's record of each turn and never assume success.
   */
  async reconcile() {
    const db = this.ctx.db;
    const stale = listActiveRuns(db).filter(
      (r) =>
        r.kind === "agent_turn" &&
        ACTIVE_AGENT_STATES.has(r.state) &&
        !(r.providerTurnId && this.turnRuns.get(r.providerTurnId) === r.id && this.server?.alive) &&
        ![...this.pendingStarts.values()].includes(r.id),
    );
    for (const run of stale) {
      const conv = run.conversationId ? getConversation(db, run.conversationId) : undefined;
      let turn: Turn | undefined;
      if (conv?.providerThreadId && run.providerTurnId && this.server?.alive) {
        try {
          await this.loadThread(conv, getWorkspace(db, conv.workspaceId)!);
          const page = await this.server.request<{ data: Turn[] }>("thread/turns/list", {
            threadId: conv.providerThreadId,
            limit: 20,
            itemsView: "full",
          });
          turn = page.data.find((t) => t.id === run.providerTurnId);
        } catch (e) {
          this.ctx.log.warn("could not read provider turn during reconcile", { runId: run.id, err: e });
        }
      }
      if (turn && conv) for (const item of turn.items) this.upsertItem(conv, run.id, item, true);
      const providerState = turn ? runStateForTurn(turn.status, this.interruptRequested.has(run.id)) : null;
      const final = providerState && providerState !== "running" ? providerState : "interrupted";
      updateRun(db, run.id, {
        state: final,
        endedAt: nowIso(),
        stopReason:
          providerState && providerState !== "running" ? "reconciled from provider" : "worker or provider restart",
        error:
          final === "interrupted"
            ? "The worker or Codex restarted during this turn. Its final outcome could not be confirmed; review the workspace before continuing."
            : (turn?.error?.message ?? null),
      });
      cancelOpenInputsForRun(db, run.id);
      if (run.providerTurnId) this.turnRuns.delete(run.providerTurnId);
    }
    // Replayed provider user items above confirm delivery. Anything still marked
    // in-flight is ambiguous: preserve the text visibly, but never send it twice.
    for (const row of db.all<{ id: string }>(`SELECT r.id FROM runs r JOIN items i ON i.run_id = r.id
      WHERE r.state = 'queued' AND json_extract(i.data, '$.steering') IS NOT NULL`)) {
      updateRun(db, row.id, {
        state: "failed",
        endedAt: nowIso(),
        error: "Live message delivery could not be confirmed after restart. Check the conversation before resending.",
      });
    }
    this.ctx.published();
    const conversations = new Set(
      listActiveRuns(db)
        .filter((r) => r.state === "queued" && r.conversationId)
        .map((r) => r.conversationId!),
    );
    for (const id of conversations) this.drainQueue(id);
  }

  async stop() {
    this.stopped = true;
    this.flushDeltas();
    this.server?.stop();
  }

  // ------------------------------------------------------------ commands

  private requireConversation(id: string): Conversation {
    const c = getConversation(this.ctx.db, id);
    if (!c) throw new CommandError("Conversation not found.");
    return c;
  }

  async createConversation(p: {
    workspaceId: string;
    provider: "codex" | "claude";
    title?: string;
    approvalPolicy: Conversation["approvalPolicy"];
    model?: string;
  }) {
    if (p.provider === "claude") {
      throw new CommandError("Claude is not configured. Add ANTHROPIC_API_KEY to enable it (see docs/decisions/0003).");
    }
    const w = getWorkspace(this.ctx.db, p.workspaceId);
    if (!w) throw new CommandError("Workspace not found.");
    if (w.state === "archived") throw new CommandError("Restore the workspace before starting a conversation.");
    const now = nowIso();
    const c = saveConversation(this.ctx.db, {
      id: uuidv7(),
      workspaceId: w.id,
      provider: "codex",
      providerThreadId: null,
      title: p.title || "New conversation",
      model: p.model ?? null,
      reasoningEffort: null,
      serviceTier: null,
      approvalPolicy: p.approvalPolicy,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    });
    this.ctx.published();
    return { conversationId: c.id };
  }

  async deleteConversation(p: { conversationId: string }) {
    const db = this.ctx.db;
    const conv = getConversation(db, p.conversationId);
    // Concurrent deletes from different browsers are harmless.
    if (!conv) return { conversationId: p.conversationId };
    if (listActiveRuns(db).some((run) => run.conversationId === conv.id)) {
      throw new CommandError("Stop the active or queued run before deleting this conversation.");
    }
    deleteConversation(db, conv.id);
    if (conv.providerThreadId) this.loadedThreads.delete(conv.providerThreadId);
    for (const [key, item] of this.liveItems) {
      if (item.conversationId === conv.id) this.liveItems.delete(key);
    }
    for (const [key, buffer] of this.deltas) {
      if (buffer.item.conversationId === conv.id) this.deltas.delete(key);
    }
    this.ctx.published();
    return { conversationId: conv.id };
  }

  async configureConversation(p: CommandPayload<"conversation.configure">) {
    const conv = this.requireConversation(p.conversationId);
    const { conversationId: _id, ...patch } = p;
    if (p.model !== undefined || p.reasoningEffort !== undefined || p.serviceTier !== undefined) {
      const models = await readModels(await this.ensureServer());
      const model =
        models.find((m) => m.model === (p.model ?? conv.model)) ??
        (p.model === undefined && conv.model === null ? models.find((m) => m.isDefault) : undefined);
      if (!model) throw new CommandError("This model is not available in the connected Codex account.");
      if (p.model !== undefined && p.model !== conv.model) {
        patch.reasoningEffort = p.reasoningEffort ?? (model.efforts.length ? model.defaultEffort : null);
        patch.serviceTier = p.serviceTier ?? null;
      }
      if (patch.reasoningEffort != null && !model.efforts.some((e) => e.effort === patch.reasoningEffort)) {
        throw new CommandError("This model does not support that reasoning effort.");
      }
      if (patch.serviceTier && !model.serviceTiers.some((tier) => tier.id === patch.serviceTier)) {
        throw new CommandError("This model does not offer that service tier.");
      }
    }
    // Workbench owns defaults. Apply them at the next turn boundary without disturbing an active turn.
    updateConversation(this.ctx.db, conv.id, patch);
    this.ctx.published();
    return { conversationId: conv.id };
  }

  async conversationAction(p: CommandPayload<"conversation.action">) {
    const db = this.ctx.db;
    const conv = this.requireConversation(p.conversationId);
    if (p.action !== "stop-background" && listActiveRuns(db).some((r) => r.conversationId === conv.id)) {
      throw new CommandError("Wait for the current turn to finish or stop it first.");
    }
    const threadId = await this.loadThread(conv, getWorkspace(db, conv.workspaceId)!);
    const server = await this.ensureServer();
    if (p.action === "stop-background") {
      await server.request("thread/backgroundTerminals/clean", { threadId });
    } else if (p.action === "compact") {
      await server.request("thread/compact/start", { threadId });
    } else {
      const fork = await server.request<ThreadForkResponse>("thread/fork", {
        threadId,
        excludeTurns: true,
        deferGoalContinuation: true,
      });
      this.loadedThreads.add(fork.thread.id);
      return saveFork(this.ctx, conv, { providerThreadId: fork.thread.id, model: fork.model });
    }
    this.ctx.published();
    return { conversationId: conv.id };
  }

  async submitTurn(p: CommandPayload<"turn.start">) {
    const db = this.ctx.db;
    const conv = this.requireConversation(p.conversationId);
    const w = getWorkspace(db, conv.workspaceId)!;
    if (w.state !== "ready") throw new CommandError(`The workspace is ${w.state.replace("_", " ")}; it must be ready.`);
    if (this.status.state === "unavailable" && !this.server?.alive) {
      throw new CommandError(`Codex is unavailable: ${this.status.error ?? "unknown error"}`);
    }
    const queued = conversationBusy(this.ctx, conv.id);
    const now = nowIso();
    const run: Run = {
      id: uuidv7(),
      kind: "agent_turn",
      workspaceId: w.id,
      conversationId: conv.id,
      jobId: null,
      state: queued ? "queued" : "starting",
      providerTurnId: null,
      summary: p.text.split("\n")[0]!.slice(0, 160),
      stopReason: null,
      error: null,
      attempt: 1,
      createdAt: now,
      startedAt: null,
      endedAt: null,
    };
    db.tx(() => {
      saveRun(db, run, this.ctx.instanceId);
      saveItem(db, {
        id: uuidv7(),
        conversationId: conv.id,
        runId: run.id,
        providerItemId: null,
        kind: "user_message",
        status: "completed",
        data: {
          text: p.text,
          phase: p.mode === "plan" ? "plan" : null,
          reviewTarget: p.reviewTarget,
        },
        createdAt: now,
        updatedAt: now,
      });
      updateConversation(db, conv.id, {
        lastActivityAt: now,
        title: conv.title === "New conversation" ? p.text.replace(/\s+/g, " ").slice(0, 60) : conv.title,
      });
    });
    this.ctx.published();
    if (!queued) void this.startTurn(run.id);
    else void this.steerQueue(conv.id);
    return { runId: run.id, queued };
  }

  private async loadThread(conv: Conversation, w: Workspace): Promise<string> {
    const server = await this.ensureServer();
    const common = {
      cwd: w.worktreePath,
      model: conv.model ?? undefined,
      serviceTier: conv.serviceTier,
      config: conv.reasoningEffort ? { model_reasoning_effort: conv.reasoningEffort } : undefined,
      approvalPolicy: conv.approvalPolicy,
      sandbox: "danger-full-access" as const,
      developerInstructions: sessionInstructions(this.ctx, w.id, conv.id),
    };
    if (!conv.providerThreadId) {
      const r = await server.request<ThreadStartResponse>("thread/start", {
        ...common,
        serviceName: "workbench",
      });
      updateConversation(this.ctx.db, conv.id, {
        providerThreadId: r.thread.id,
        model: getConversation(this.ctx.db, conv.id)!.model ?? r.model,
      });
      this.ctx.published();
      this.loadedThreads.add(r.thread.id);
      return r.thread.id;
    }
    if (!this.loadedThreads.has(conv.providerThreadId)) {
      await server.request("thread/resume", { threadId: conv.providerThreadId, ...common, excludeTurns: true });
      this.loadedThreads.add(conv.providerThreadId);
    }
    return conv.providerThreadId;
  }

  private async startTurn(runId: string) {
    const db = this.ctx.db;
    const run = getRun(db, runId)!;
    const conv = getConversation(db, run.conversationId!)!;
    const w = getWorkspace(db, conv.workspaceId)!;
    const userItem = db.get<{ id: string }>(
      "SELECT id FROM items WHERE run_id = :r AND kind = 'user_message' ORDER BY position LIMIT 1",
      { r: runId },
    );
    const item = userItem ? getItem(db, userItem.id) : undefined;
    let threadId: string | null = null;
    try {
      threadId = await this.loadThread(conv, w);
      const fresh = getConversation(db, conv.id)!;
      this.pendingStarts.set(threadId, runId);
      const params: Record<string, unknown> = {
        threadId,
        input: [{ type: "text", text: item?.data.text ?? run.summary, text_elements: [] }],
        clientUserMessageId: item?.id ?? null,
        approvalPolicy: fresh.approvalPolicy,
        model: fresh.model,
        effort: fresh.reasoningEffort ?? undefined,
        serviceTier: fresh.serviceTier,
        collaborationMode: {
          // Codex modes are sticky; explicitly leave Plan for an ordinary turn.
          mode: item?.data.phase === "plan" ? "plan" : "default",
          settings: {
            model: fresh.model,
            reasoning_effort: fresh.reasoningEffort,
            developer_instructions: sessionInstructions(this.ctx, w.id, conv.id),
          },
        },
      };
      if (item?.data.reviewTarget) {
        await this.server!.request("thread/settings/update", {
          threadId,
          model: fresh.model,
          effort: fresh.reasoningEffort ?? undefined,
          serviceTier: fresh.serviceTier,
          approvalPolicy: fresh.approvalPolicy,
        });
      }
      const res = item?.data.reviewTarget
        ? await this.server!.request<ReviewStartResponse>("review/start", {
            threadId,
            target: item.data.reviewTarget,
            delivery: "inline",
          })
        : await this.server!.request<TurnStartResponse>("turn/start", params);
      this.bindTurn(runId, res.turn.id);
      const cur = getRun(db, runId)!;
      if (this.interruptRequested.has(runId) && !isTerminalRunState(cur.state)) {
        await this.sendInterrupt(threadId, res.turn.id);
      }
    } catch (e) {
      const cur = getRun(db, runId)!;
      if (!isTerminalRunState(cur.state)) {
        updateRun(db, runId, {
          state: "failed",
          endedAt: nowIso(),
          error: `Could not start the turn: ${(e as Error).message}`,
        });
        this.ctx.published();
      }
      this.drainQueue(conv.id);
    } finally {
      if (threadId && this.pendingStarts.get(threadId) === runId) this.pendingStarts.delete(threadId);
    }
  }

  private bindTurn(runId: string, turnId: string) {
    if (this.turnRuns.get(turnId) === runId) return;
    this.turnRuns.set(turnId, runId);
    const run = getRun(this.ctx.db, runId)!;
    if (run.state === "starting") {
      updateRun(this.ctx.db, runId, { state: "running", providerTurnId: turnId, startedAt: nowIso() });
    } else if (!run.providerTurnId) {
      updateRun(this.ctx.db, runId, { providerTurnId: turnId, startedAt: run.startedAt ?? nowIso() });
    }
    this.ctx.published();
  }

  private drainQueue(conversationId: string) {
    if (this.stopped || this.steering.has(conversationId)) return;
    const next = claimQueuedTurn(this.ctx, conversationId);
    if (!next) return;
    this.ctx.published();
    void this.startTurn(next);
  }

  private consumeSteer(queuedId: string, activeId: string, itemId: string) {
    const db = this.ctx.db;
    if (queuedId === activeId) return;
    const pending = getRun(db, queuedId);
    if (!pending || (pending.state !== "queued" && pending.state !== "failed")) return;
    db.tx(() => {
      db.run("UPDATE items SET run_id = :active, position = :position WHERE id = :id", {
        active: activeId,
        position: latestSeq(db) + 1,
        id: itemId,
      });
      saveItem(db, getItem(db, itemId)!);
      updateRun(db, queuedId, {
        state: "succeeded",
        endedAt: nowIso(),
        error: null,
        stopReason: "delivered to live turn",
      });
    });
    this.ctx.published();
  }

  private async steerQueue(conversationId: string, atBoundary = false) {
    const db = this.ctx.db;
    const conv = getConversation(db, conversationId);
    if (!conv?.providerThreadId || !this.server?.alive || this.stopped || this.steering.has(conv.id)) return;
    const active = listActiveRuns(db).find((r) => r.conversationId === conv.id && r.state === "running");
    if (!active?.providerTurnId) return;
    // While a tool is running, keep messages cancellable in the durable queue.
    if (!atBoundary && [...this.liveItems.values()].some((i) => i.runId === active.id && TOOL_KINDS.has(i.kind)))
      return;
    const next = db.get<{ id: string }>(
      `SELECT id FROM runs WHERE conversation_id = :id
      AND kind = 'agent_turn' AND state = 'queued' ORDER BY created_at, rowid LIMIT 1`,
      { id: conv.id },
    );
    if (!next) return;
    const user = db.get<{ id: string }>("SELECT id FROM items WHERE run_id = :id AND kind = 'user_message'", {
      id: next.id,
    });
    const item = user ? getItem(db, user.id) : undefined;
    const original = db.get<{ id: string }>(
      "SELECT id FROM items WHERE run_id = :id AND kind = 'user_message' ORDER BY position LIMIT 1",
      { id: active.id },
    );
    const initial = original ? getItem(db, original.id) : undefined;
    if (!item || !initial) throw new Error("Agent turn is missing its user message");
    // Plan and review settings cannot be changed through turn/steer.
    if (item.data.reviewTarget || initial.data.reviewTarget || item.data.phase !== initial.data.phase) return;
    this.steering.set(conv.id, next.id);
    saveItem(db, { ...item, data: { ...item.data, steering: { runId: active.id, turnId: active.providerTurnId } } });
    this.ctx.published();
    try {
      const result = await this.server.request<{ turnId: string }>(
        "turn/steer",
        {
          threadId: conv.providerThreadId,
          expectedTurnId: active.providerTurnId,
          clientUserMessageId: item.id,
          input: [{ type: "text", text: item.data.text!, text_elements: [] }],
        },
        15_000,
      );
      if (result.turnId !== active.providerTurnId) throw new Error("Codex acknowledged a different turn");
      this.consumeSteer(next.id, active.id, item.id);
    } catch (error) {
      if (getRun(db, next.id)?.state === "queued") {
        if (error instanceof RpcError) {
          const { steering: _target, ...data } = getItem(db, item.id)!.data;
          saveItem(db, { ...getItem(db, item.id)!, data });
          if (!isTerminalRunState(getRun(db, active.id)!.state))
            this.notice(
              conv,
              active.id,
              `Live delivery was rejected; your message is still queued: ${error.message}`,
              true,
            );
        } else {
          updateRun(db, next.id, {
            state: "failed",
            endedAt: nowIso(),
            error: "Live message delivery could not be confirmed. Check the conversation before resending.",
          });
        }
        this.ctx.published();
      }
    } finally {
      this.steering.delete(conv.id);
      this.drainQueue(conv.id);
    }
    // Drain accepted messages in submission order without waiting for another tool.
    if (getRun(db, next.id)?.state === "succeeded") void this.steerQueue(conv.id, true);
  }

  async interrupt(p: { conversationId: string; runId: string }) {
    const run = getRun(this.ctx.db, p.runId);
    if (!run || run.conversationId !== p.conversationId) throw new CommandError("Run not found in this conversation.");
    if (isTerminalRunState(run.state)) throw new CommandError(`This turn already ended (${run.state}).`);
    if (run.state === "queued") {
      if ([...this.steering.values()].includes(run.id))
        throw new CommandError("This message is being delivered to the live turn. Wait for delivery to finish.");
      updateRun(this.ctx.db, run.id, { state: "cancelled", endedAt: nowIso(), stopReason: "cancelled while queued" });
      this.ctx.published();
      return { runId: run.id, state: "cancelled" };
    }
    this.interruptRequested.add(run.id);
    updateRun(this.ctx.db, run.id, { state: "stopping" });
    this.ctx.published();
    const conv = getConversation(this.ctx.db, run.conversationId!)!;
    if (run.providerTurnId && conv.providerThreadId)
      await this.sendInterrupt(conv.providerThreadId, run.providerTurnId);
    return { runId: run.id, state: "stopping" };
  }

  private async sendInterrupt(threadId: string, turnId: string) {
    try {
      await this.server?.request("turn/interrupt", { threadId, turnId }, 15_000);
    } catch (e) {
      // turn/completed decides the outcome; a missing reply is not an error by itself.
      this.ctx.log.warn("turn/interrupt did not confirm", { turnId, err: e });
    }
  }

  async respond(p: { inputId: string; response: PendingInput["response"] & {} }) {
    const db = this.ctx.db;
    const input = getInput(db, p.inputId);
    if (!input) throw new CommandError("Request not found.");
    if (input.state !== "open") throw new CommandError(`This request was already ${input.state}.`);
    let reply: unknown;
    try {
      reply = replyFor(input.kind, p.response);
    } catch (e) {
      throw new CommandError((e as Error).message);
    }
    const route = this.inputRoutes.get(input.id);
    if (!route || !this.server?.alive || route.generation !== this.server.generation) {
      resolveInput(db, input.id, "cancelled", null);
      this.ctx.published();
      throw new CommandError("Codex is no longer waiting for this request.");
    }
    // First response wins: the conditional update fails for every later one.
    const resolved = resolveInput(db, input.id, "answered", p.response);
    if (!resolved) throw new CommandError("This request was already answered from another device.");
    this.inputRoutes.delete(input.id);
    this.server.respond(route.rpcId, reply);
    const run = getRun(db, input.runId);
    const stillWaiting = db.get("SELECT 1 FROM pending_inputs WHERE run_id = :r AND state = 'open'", {
      r: input.runId,
    });
    if (run && run.state === "waiting_for_input" && !stillWaiting) updateRun(db, run.id, { state: "running" });
    this.ctx.published();
    return { inputId: input.id };
  }

  // ------------------------------------------------------------ notifications

  private conversationForThread(threadId: unknown): Conversation | undefined {
    if (typeof threadId !== "string") return undefined;
    const r = this.ctx.db.get<{ id: string }>("SELECT id FROM conversations WHERE provider_thread_id = :t", {
      t: threadId,
    });
    return r ? getConversation(this.ctx.db, r.id) : undefined;
  }

  /** Map a provider turn to its run, binding a just-started turn if needed. */
  private runForTurn(threadId: string, turnId: unknown): string | null {
    if (typeof turnId !== "string") return null;
    const known = this.turnRuns.get(turnId);
    if (known) return known;
    const pending = this.pendingStarts.get(threadId);
    if (pending) {
      this.bindTurn(pending, turnId);
      return pending;
    }
    const r = this.ctx.db.get<{ id: string }>("SELECT id FROM runs WHERE provider_turn_id = :t", { t: turnId });
    return r?.id ?? null;
  }

  private onNotification(method: string, params: Record<string, unknown>) {
    const conv = this.conversationForThread(params.threadId);
    if (!conv) {
      if (method === "warning" || method === "configWarning" || method === "deprecationNotice") {
        this.ctx.log.warn(`codex ${method}`, { params });
      }
      return;
    }
    const threadId = conv.providerThreadId!;
    const turn = params.turn as Turn | undefined;
    const runId = this.runForTurn(threadId, params.turnId ?? turn?.id);

    switch (method) {
      case "item/started":
      case "item/completed":
        this.upsertItem(conv, runId, params.item as ThreadItem, method === "item/completed");
        if (method === "item/completed" && isToolItem(params.item as ThreadItem)) void this.steerQueue(conv.id, true);
        break;
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/plan/delta":
        this.bufferDelta(conv.id, String(params.itemId), "text", String(params.delta));
        break;
      case "item/commandExecution/outputDelta":
        this.bufferDelta(conv.id, String(params.itemId), "output", String(params.delta));
        break;
      case "turn/completed":
        if (runId && turn) this.completeTurn(conv, runId, turn);
        break;
      case "thread/status/changed": {
        const status = params.status as { type: string; activeFlags?: string[] };
        const active = this.ctx.db.get<{ id: string; state: string }>(
          `SELECT id, state FROM runs WHERE conversation_id = :c AND state IN ('running','waiting_for_input')`,
          { c: conv.id },
        );
        if (!active) break;
        const waiting = status.type === "active" && (status.activeFlags?.length ?? 0) > 0;
        if (waiting && active.state === "running") updateRun(this.ctx.db, active.id, { state: "waiting_for_input" });
        if (!waiting && status.type === "active" && active.state === "waiting_for_input") {
          updateRun(this.ctx.db, active.id, { state: "running" });
        }
        this.ctx.published();
        break;
      }
      case "error": {
        const err = params.error as { message: string };
        this.notice(conv, runId, `${params.willRetry ? "Retrying after error" : "Error"}: ${err.message}`, true);
        break;
      }
      case "serverRequest/resolved": {
        // The provider withdrew a request (for example after an interrupt).
        const gen = this.server?.generation;
        const row = this.ctx.db.get<{ id: string }>(
          "SELECT id FROM pending_inputs WHERE provider_request_id = :p AND state = 'open'",
          { p: `${gen}:${String(params.requestId)}` },
        );
        if (row) {
          this.inputRoutes.delete(row.id);
          resolveInput(this.ctx.db, row.id, "cancelled", null);
          this.ctx.published();
        }
        break;
      }
      case "model/rerouted":
        this.notice(conv, runId, `Codex rerouted the model: ${JSON.stringify(params).slice(0, 300)}`, false);
        break;
      default:
        break;
    }
  }

  private notice(conv: Conversation, runId: string | null, text: string, failed: boolean) {
    const now = nowIso();
    saveItem(this.ctx.db, {
      id: uuidv7(),
      conversationId: conv.id,
      runId,
      providerItemId: null,
      kind: "notice",
      status: failed ? "failed" : "completed",
      data: { text },
      createdAt: now,
      updatedAt: now,
    });
    this.ctx.published();
  }

  private upsertItem(conv: Conversation, runId: string | null, item: ThreadItem, completed: boolean) {
    const db = this.ctx.db;
    const mapped = mapItem(item, completed);
    const key = `${conv.id}:${item.id}`;
    const now = nowIso();
    let existing = getItemByProviderId(db, conv.id, item.id);
    // The user message we stored at submission comes back with our id as clientId.
    if (!existing && mapped.clientId) {
      const mine = getItem(db, mapped.clientId);
      if (mine && mine.conversationId === conv.id) {
        if (runId && mine.data.steering?.runId === runId && mine.runId) this.consumeSteer(mine.runId, runId, mine.id);
        existing = getItem(db, mine.id);
      }
    }
    if (completed) {
      const images = [...(mapped.data.images ?? []), ...markdownImages(mapped.data.text ?? "")].map((image) => {
        const retained = existing?.data.images?.find((saved) => saved.source === image.source && saved.mediaId);
        return retained ? { ...image, mediaId: retained.mediaId } : image;
      });
      if (images.length) {
        mapped.data.images = retainImages(
          this.ctx.config.stateDir,
          getWorkspace(db, conv.workspaceId)!.worktreePath,
          images,
        );
      }
    }
    if (completed) this.deltas.delete(existing?.id ?? "");
    // Keep Workbench's own fields (such as the plan-mode marker) on the user message.
    const data =
      existing?.kind === "user_message"
        ? { ...existing.data, ...mapped.data, phase: existing.data.phase }
        : mapped.data;
    const saved = saveItem(db, {
      id: existing?.id ?? uuidv7(),
      conversationId: conv.id,
      runId: existing?.runId ?? runId,
      providerItemId: item.id,
      kind: mapped.kind,
      status: mapped.status,
      data,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (completed) this.liveItems.delete(key);
    else this.liveItems.set(key, saved);
    this.ctx.published();
  }

  private bufferDelta(conversationId: string, providerItemId: string, field: "text" | "output", delta: string) {
    const item = this.liveItems.get(`${conversationId}:${providerItemId}`);
    if (!item) return;
    const buf = this.deltas.get(item.id);
    if (buf) buf.chunks.push(delta);
    else this.deltas.set(item.id, { item, field, chunks: [delta] });
    this.flushTimer ??= setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS);
  }

  /**
   * Streaming text is persisted in batches; a crash can lose at most one
   * batch window of deltas, and item/completed carries the full text anyway.
   */
  private flushDeltas() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.deltas.size) return;
    const db = this.ctx.db;
    db.tx(() => {
      for (const buf of this.deltas.values()) {
        appendItemDelta(
          db,
          buf.item,
          buf.field,
          buf.chunks.join(""),
          buf.field === "output" ? MAX_OUTPUT_CHARS : 1_000_000,
        );
      }
    });
    this.deltas.clear();
    this.ctx.published();
  }

  private completeTurn(conv: Conversation, runId: string, turn: Turn) {
    this.flushDeltas();
    const db = this.ctx.db;
    const run = getRun(db, runId);
    if (!run || isTerminalRunState(run.state)) return;
    const state = runStateForTurn(turn.status, this.interruptRequested.has(runId));
    db.tx(() => {
      updateRun(db, runId, {
        state,
        providerTurnId: turn.id,
        endedAt: nowIso(),
        stopReason: turn.status,
        error: turn.error?.message ?? (state === "interrupted" ? "Codex interrupted the turn." : null),
      });
      cancelOpenInputsForRun(db, runId);
      updateConversation(db, conv.id, { lastActivityAt: nowIso() });
    });
    this.interruptRequested.delete(runId);
    this.turnRuns.delete(turn.id);
    for (const [k, v] of this.liveItems) if (v.runId === runId && v.kind !== "command") this.liveItems.delete(k);
    this.ctx.published();
    this.drainQueue(conv.id);
  }

  // ------------------------------------------------------------ server requests

  private onRequest(server: AppServer, rpcId: RequestId, method: string, params: Record<string, unknown>) {
    const conv = this.conversationForThread(params.threadId);
    const runId = conv ? this.runForTurn(conv.providerThreadId!, params.turnId) : null;
    if (
      method === "item/tool/call" ||
      method === "account/chatgptAuthTokens/refresh" ||
      method === "attestation/generate"
    ) {
      server.respondError(rpcId, -32601, `Workbench does not handle ${method}`);
      return;
    }
    const mapped = mapServerRequest(method, params);
    if (!mapped.supported || !conv || !runId) {
      if (mapped.supported) server.respondError(rpcId, -32602, "No active Workbench run for this request");
      else if (mapped.reply === null) server.respondError(rpcId, -32601, mapped.reason);
      else server.respond(rpcId, mapped.reply);
      if (conv)
        this.notice(
          conv,
          runId,
          mapped.supported ? "A Codex request arrived without an active run and was rejected." : mapped.reason,
          false,
        );
      return;
    }
    const input: PendingInput = {
      id: uuidv7(),
      conversationId: conv.id,
      runId,
      kind: mapped.kind,
      state: "open",
      request: mapped.request,
      response: null,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    this.ctx.db.tx(() => {
      createInput(this.ctx.db, input, `${server.generation}:${String(rpcId)}`);
      const run = getRun(this.ctx.db, runId);
      if (run?.state === "running") updateRun(this.ctx.db, runId, { state: "waiting_for_input" });
    });
    this.inputRoutes.set(input.id, { generation: server.generation, rpcId });
    this.ctx.published();
  }
}
