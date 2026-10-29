// Each turn owns an SDK subprocess. Only explicit SDK results confirm success;
// a disconnected process is interrupted, and its durable session can be resumed.
// A turn lasts until Claude is idle with no live background tasks, so subagents,
// background shells, and monitors outlive the reply that started them, and
// their completion notifications continue the same turn as in the terminal.
import {
  type CanUseTool,
  type EffortLevel,
  forkSession,
  type Options,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentModel,
  type AgentTask,
  type CommandPayload,
  type Conversation,
  type ConversationItem,
  type InputRequest,
  type InspectResult,
  isTerminalRunState,
  nowIso,
  type PendingInput,
  type Run,
  uuidv7,
  type WorkerStatus,
} from "@workbench/contracts";
import {
  cancelOpenInputsForRun,
  createInput,
  deleteConversation,
  getConversation,
  getInput,
  getItem,
  getItemByProviderId,
  getRun,
  getWorkspace,
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
import { CommandError } from "../commands.ts";
import type { WorkerContext } from "../context.ts";
import { saveFork } from "../fork.ts";
import { sessionInstructions } from "../session-context.ts";
import { subscriptionEnv, subscriptionStatus } from "./auth.ts";

export type ClaudeQuery = AsyncIterable<SDKMessage> &
  Pick<Query, "close" | "stopTask" | "supportedModels" | "supportedCommands">;
export type QueryFactory = (args: { prompt: string | null; options: Options }) => ClaudeQuery;

// One-shot string prompts close the CLI's input when it first goes idle, which
// kills background tasks. Keep input open; the turn closes the query itself.
// A null prompt starts the CLI without a turn so its control requests can be read.
const openQuery: QueryFactory = ({ prompt, options }) =>
  query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      if (prompt !== null) yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
      await new Promise(() => {});
    })(),
    options,
  });

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];
// Claude's fast mode, presented with Codex's service tiers.
const FAST_TIER = {
  id: "fast",
  name: "Fast",
  description: "Faster output from the same model, billed at a higher rate.",
};
const isEffort = (value: string): value is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(value);

const TASK_STATUS = {
  running: "in_progress",
  completed: "completed",
  failed: "failed",
  stopped: "declined",
} as const satisfies Record<AgentTask["state"], ConversationItem["status"]>;
type Active = { query: ClaudeQuery | null; cancelled: boolean; task: Promise<void> };
type InputRoute = { runId: string; answer: (response: PendingInput["response"]) => void };

export class ClaudeProvider {
  status: WorkerStatus["claude"] = { state: "starting", reason: null };
  onStatusChange: () => void = () => {};
  private active = new Map<string, Active>();
  private routes = new Map<string, InputRoute>();
  private modelList: Promise<{ resolvedModel?: string; model: AgentModel }[]> | null = null;
  private stopped = false;
  private readonly ctx: WorkerContext;
  private readonly queryFactory: QueryFactory;

  constructor(ctx: WorkerContext, queryFactory: QueryFactory = openQuery) {
    this.ctx = ctx;
    this.queryFactory = queryFactory;
  }

  async start() {
    const status = await subscriptionStatus(this.ctx.config.claudeBin);
    if (this.stopped) return;
    this.status = status;
    // SDK sessions survive the worker; active process outcomes do not. Never
    // replay an interrupted prompt automatically because tools may have run.
    for (const run of listActiveRuns(this.ctx.db)) {
      if (
        run.kind !== "agent_turn" ||
        run.state === "queued" ||
        getConversation(this.ctx.db, run.conversationId!)?.provider !== "claude"
      )
        continue;
      updateRun(this.ctx.db, run.id, {
        state: "interrupted",
        endedAt: nowIso(),
        stopReason: "worker restart",
        error: "The worker restarted during this Claude turn. Review the workspace before continuing.",
      });
      cancelOpenInputsForRun(this.ctx.db, run.id);
    }
    this.ctx.published();
    this.onStatusChange();
    const queued = new Set(
      listActiveRuns(this.ctx.db)
        .filter(
          (run) =>
            run.state === "queued" &&
            run.conversationId &&
            getConversation(this.ctx.db, run.conversationId)?.provider === "claude",
        )
        .map((run) => run.conversationId!),
    );
    for (const id of queued) this.drainQueue(id);
  }

  private conversation(id: string): Conversation {
    const conv = getConversation(this.ctx.db, id);
    if (conv?.provider !== "claude") throw new CommandError("Claude conversation not found.");
    return conv;
  }

  private requireReady() {
    if (this.stopped || this.status.state !== "ready")
      throw new CommandError(this.status.reason ?? "Claude is not ready.");
  }

  async createConversation(p: CommandPayload<"conversation.create">) {
    this.requireReady();
    const w = getWorkspace(this.ctx.db, p.workspaceId);
    if (!w) throw new CommandError("Workspace not found.");
    if (w.state === "archived") throw new CommandError("Restore the workspace before starting a conversation.");
    const now = nowIso();
    const conv = saveConversation(this.ctx.db, {
      id: uuidv7(),
      workspaceId: w.id,
      provider: "claude",
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
    return { conversationId: conv.id };
  }

  async configureConversation(p: CommandPayload<"conversation.configure">) {
    const conv = this.conversation(p.conversationId);
    if (p.serviceTier != null && p.serviceTier !== FAST_TIER.id)
      throw new CommandError(`Claude's only service tier is "${FAST_TIER.id}".`);
    if (p.reasoningEffort != null && !isEffort(p.reasoningEffort))
      throw new CommandError(`Claude reasoning effort must be one of: ${EFFORT_LEVELS.join(", ")}.`);
    const { conversationId: _id, ...patch } = p;
    updateConversation(this.ctx.db, conv.id, patch);
    this.ctx.published();
    return { conversationId: conv.id };
  }

  async inspect(p: CommandPayload<"conversation.inspect">): Promise<InspectResult> {
    const conv = this.conversation(p.conversationId);
    this.requireReady();
    switch (p.view) {
      case "models":
        return this.models(conv);
      case "commands": {
        // Skills and project commands depend on the worktree, so this is read on every request.
        const q = this.idleQuery(getWorkspace(this.ctx.db, conv.workspaceId)!.worktreePath);
        try {
          const commands = await q.supportedCommands();
          return {
            kind: "commands",
            commands: commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
          };
        } finally {
          q.close();
        }
      }
      default:
        throw new CommandError(`Claude provides /${p.view} as its own command; choose it from the slash menu.`);
    }
  }

  // The account's model list comes from the installed CLI. Read it once per
  // worker; a failed read is retried on the next request. Turns record the
  // resolved model ID, so the alias row that resolves to it carries that ID
  // for the picker to select.
  private async models(conv: Conversation): Promise<InspectResult> {
    this.modelList ??= this.readModels().catch((e) => {
      this.modelList = null;
      throw e;
    });
    const models = await this.modelList;
    const current =
      models.find((m) => m.model.model === conv.model) ??
      models.find((m) => !m.model.isDefault && m.resolvedModel === conv.model);
    return {
      kind: "models",
      models: models.map((m) => (m === current ? { ...m.model, model: conv.model! } : m.model)),
    };
  }

  private async readModels() {
    const q = this.idleQuery();
    try {
      return (await q.supportedModels()).map((m) => ({
        resolvedModel: m.resolvedModel,
        model: {
          model: m.value,
          name: m.displayName,
          description: m.description,
          isDefault: m.value === "default",
          efforts: (m.supportedEffortLevels ?? []).map((effort) => ({ effort, description: "" })),
          defaultEffort: "",
          serviceTiers: m.supportsFastMode ? [FAST_TIER] : [],
        } satisfies AgentModel,
      }));
    } finally {
      q.close();
    }
  }

  // A CLI process without a turn, for reading what the account and worktree offer.
  private idleQuery(cwd?: string) {
    return this.queryFactory({
      prompt: null,
      options: {
        cwd,
        settingSources: cwd ? ["user", "project", "local"] : undefined,
        pathToClaudeCodeExecutable: this.ctx.config.claudeBin,
        settings: { forceLoginMethod: "claudeai" },
        env: subscriptionEnv(),
        persistSession: false,
      },
    });
  }

  async conversationAction(p: CommandPayload<"conversation.action">) {
    const conv = this.conversation(p.conversationId);
    if (p.action !== "fork")
      throw new CommandError(
        p.action === "compact"
          ? "Use Claude's own /compact from the slash menu."
          : "Stop Claude background tasks from the task panel.",
      );
    if (listActiveRuns(this.ctx.db).some((r) => r.conversationId === conv.id))
      throw new CommandError("Wait for the current turn to finish or stop it first.");
    if (!conv.providerThreadId) throw new CommandError("Send a message before forking this conversation.");
    const fork = await forkSession(conv.providerThreadId, {
      dir: getWorkspace(this.ctx.db, conv.workspaceId)!.worktreePath,
    });
    return saveFork(this.ctx, conv, { providerThreadId: fork.sessionId, model: conv.model });
  }

  async deleteConversation(p: CommandPayload<"conversation.delete">) {
    const conv = getConversation(this.ctx.db, p.conversationId);
    if (!conv) return { conversationId: p.conversationId };
    this.conversation(conv.id);
    if (listActiveRuns(this.ctx.db).some((r) => r.conversationId === conv.id))
      throw new CommandError("Stop the active or queued run before deleting this conversation.");
    deleteConversation(this.ctx.db, conv.id);
    this.ctx.published();
    return { conversationId: conv.id };
  }

  async submitTurn(p: CommandPayload<"turn.start">) {
    this.requireReady();
    const db = this.ctx.db;
    const conv = this.conversation(p.conversationId);
    const w = getWorkspace(db, conv.workspaceId)!;
    if (w.state !== "ready") throw new CommandError(`The workspace is ${w.state.replace("_", " ")}; it must be ready.`);
    if (p.mode === "review") throw new CommandError("For Claude, ask for a review in an ordinary message.");
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
          images: retainImages(this.ctx.config.stateDir, w.worktreePath, markdownImages(p.text)),
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
    if (!queued) this.startRun(run.id);
    return { runId: run.id, queued };
  }

  private drainQueue(conversationId: string) {
    if (this.stopped) return;
    const next = claimQueuedTurn(this.ctx, conversationId);
    if (next) {
      this.ctx.published();
      this.startRun(next);
    }
  }

  private startRun(runId: string) {
    const active: Active = { query: null, cancelled: false, task: Promise.resolve() };
    this.active.set(runId, active);
    active.task = this.execute(runId, active);
  }

  private async execute(runId: string, active: Active) {
    const db = this.ctx.db;
    const run = getRun(db, runId)!;
    const conv = this.conversation(run.conversationId!);
    const w = getWorkspace(db, conv.workspaceId)!;
    const row = db.get<{ id: string }>(
      "SELECT id FROM items WHERE run_id = :r AND kind = 'user_message' ORDER BY position LIMIT 1",
      { r: runId },
    );
    const user = row ? getItem(db, row.id) : undefined;
    let outcome: "succeeded" | "failed" | "cancelled" | "interrupted" = "interrupted";
    let error: string | null = "Claude disconnected without a final result. Review the workspace before continuing.";
    const blocks = new Map<string, { key: string; kind: ConversationItem["kind"]; data: ConversationItem["data"] }>();
    const dirty = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    let messageId = "";
    let resulted = false;
    let sessionStates = false;
    let liveTasks = new Set<string>();
    const persist = (
      key: string,
      kind: ConversationItem["kind"],
      data: ConversationItem["data"],
      status: ConversationItem["status"],
    ) => {
      const existing = getItemByProviderId(db, conv.id, key);
      const now = nowIso();
      if (status === "completed" && kind === "agent_message") {
        const images = markdownImages(data.text ?? "");
        if (images.length) data.images = retainImages(this.ctx.config.stateDir, w.worktreePath, images);
      }
      saveItem(db, {
        id: existing?.id ?? uuidv7(),
        conversationId: conv.id,
        runId,
        providerItemId: key,
        kind,
        status,
        data,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      this.ctx.published();
    };
    const updateTask = (taskId: string, patch: (task: AgentTask) => Partial<AgentTask>) => {
      const key = `task:${taskId}`;
      const item = getItemByProviderId(db, conv.id, key);
      if (!item?.data.task) return;
      const task = { ...item.data.task, ...patch(item.data.task) };
      persist(key, "task", { ...item.data, task }, TASK_STATUS[task.state]);
    };
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const key of dirty) {
        const block = blocks.get(key)!;
        persist(block.key, block.kind, block.data, "in_progress");
      }
      dirty.clear();
    };
    try {
      this.requireReady();
      if (w.state !== "ready") throw new CommandError("The workspace must be ready.");
      const plan = user?.data.phase === "plan";
      const options: Options = {
        cwd: w.worktreePath,
        resume: conv.providerThreadId ?? undefined,
        model: conv.model ?? undefined,
        effort: (conv.reasoningEffort as EffortLevel | null) ?? undefined,
        systemPrompt: { type: "preset", preset: "claude_code", append: sessionInstructions(this.ctx, w.id, conv.id) },
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
        persistSession: true,
        permissionMode: plan ? "plan" : "default",
        // Use the same installed CLI and local login checked at startup. This
        // login pin fails closed if project settings try to select API auth.
        pathToClaudeCodeExecutable: this.ctx.config.claudeBin,
        settings: { forceLoginMethod: "claudeai", ...(conv.serviceTier === FAST_TIER.id && { fastMode: true }) },
        env: { ...subscriptionEnv(), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
        canUseTool: (tool, input, opts) => this.canUseTool(conv, runId, tool, input, opts, plan),
        ...(conv.approvalPolicy === "untrusted" && !plan
          ? {
              hooks: {
                PreToolUse: [
                  {
                    matcher: "Bash|Edit|Write|NotebookEdit",
                    hooks: [
                      async () => ({
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse" as const,
                          permissionDecision: "ask" as const,
                          permissionDecisionReason: "Workbench requires approval for this tool.",
                        },
                      }),
                    ],
                  },
                ],
              },
            }
          : {}),
      };
      const stream = this.queryFactory({ prompt: user?.data.text ?? run.summary, options });
      active.query = stream;
      if (active.cancelled) stream.close();
      updateRun(db, runId, { state: active.cancelled ? "stopping" : "running", startedAt: nowIso() });
      this.ctx.published();
      for await (const msg of stream) {
        if (msg.type === "system" && msg.subtype === "init") {
          updateConversation(db, conv.id, {
            providerThreadId: msg.session_id,
            model: getConversation(db, conv.id)!.model ?? msg.model,
          });
          updateRun(db, runId, { providerTurnId: msg.uuid });
          this.ctx.published();
        } else if (msg.type === "system" && msg.subtype === "session_state_changed") {
          sessionStates = true;
          if (msg.state === "idle" && resulted && !liveTasks.size) break;
          // A task notification started another model turn; its result decides the outcome.
          if (msg.state === "running" && resulted) {
            outcome = "interrupted";
            error = "Claude disconnected without a final result. Review the workspace before continuing.";
          }
        } else if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
          liveTasks = new Set(msg.tasks.filter((t) => !t.ambient).map((t) => t.task_id));
        } else if (msg.type === "system" && msg.subtype === "task_started") {
          if (!msg.skip_transcript)
            persist(
              `task:${msg.task_id}`,
              "task",
              {
                task: {
                  id: msg.task_id,
                  type: msg.task_type ?? null,
                  description: msg.description,
                  state: "running",
                  backgrounded: msg.is_backgrounded ?? false,
                  summary: null,
                  lastTool: null,
                  usage: null,
                  outputFile: null,
                  error: null,
                },
              },
              "in_progress",
            );
        } else if (msg.type === "system" && msg.subtype === "task_progress") {
          updateTask(msg.task_id, (task) => ({
            description: msg.description,
            summary: msg.summary ?? task.summary,
            lastTool: msg.last_tool_name ?? task.lastTool,
            usage: {
              totalTokens: msg.usage.total_tokens,
              toolUses: msg.usage.tool_uses,
              durationMs: msg.usage.duration_ms,
            },
          }));
        } else if (msg.type === "system" && msg.subtype === "task_updated") {
          const { status, description, error, is_backgrounded } = msg.patch;
          updateTask(msg.task_id, (task) => ({
            state:
              status === "completed" || status === "failed"
                ? status
                : status === "killed"
                  ? "stopped"
                  : status
                    ? "running"
                    : task.state,
            description: description ?? task.description,
            error: error ?? task.error,
            backgrounded: is_backgrounded ?? task.backgrounded,
          }));
        } else if (msg.type === "system" && msg.subtype === "task_notification") {
          updateTask(msg.task_id, (task) => ({
            state: msg.status,
            summary: msg.summary || task.summary,
            outputFile: msg.output_file,
            usage: msg.usage
              ? {
                  totalTokens: msg.usage.total_tokens,
                  toolUses: msg.usage.tool_uses,
                  durationMs: msg.usage.duration_ms,
                }
              : task.usage,
          }));
        } else if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
          const e = msg.event;
          if (e.type === "message_start") messageId = e.message.id;
          if (
            e.type === "content_block_start" &&
            (e.content_block.type === "text" || e.content_block.type === "thinking")
          ) {
            const key = `${messageId}:${e.index}`;
            const block = {
              key,
              kind: e.content_block.type === "text" ? ("agent_message" as const) : ("reasoning" as const),
              data: { text: e.content_block.type === "text" ? e.content_block.text : e.content_block.thinking },
            };
            blocks.set(key, block);
            persist(key, block.kind, block.data, "in_progress");
          } else if (
            e.type === "content_block_delta" &&
            (e.delta.type === "text_delta" || e.delta.type === "thinking_delta")
          ) {
            const key = `${messageId}:${e.index}`;
            const block = blocks.get(key);
            if (block) {
              block.data.text =
                (block.data.text ?? "") + (e.delta.type === "text_delta" ? e.delta.text : e.delta.thinking);
              dirty.add(key);
              timer ??= setTimeout(flush, 100);
            }
          } else if (e.type === "content_block_stop") {
            flush();
            const block = blocks.get(`${messageId}:${e.index}`);
            if (block) persist(block.key, block.kind, block.data, "completed");
          }
        } else if (msg.type === "assistant" && !msg.parent_tool_use_id) {
          flush();
          for (const [index, block] of msg.message.content.entries()) {
            if (block.type === "text" || block.type === "thinking") {
              const text = block.type === "text" ? block.text : block.thinking;
              const kind = block.type === "text" ? "agent_message" : "reasoning";
              const streamed = [...blocks.values()].find(
                (b) => b.key.startsWith(`${msg.message.id}:`) && b.kind === kind && b.data.text === text,
              );
              persist(streamed?.key ?? `${msg.uuid}:${index}`, kind, { text }, "completed");
            } else if (block.type === "tool_use") {
              const input = block.input as Record<string, unknown>;
              persist(
                block.id,
                block.name === "Bash" ? "command" : "tool_call",
                block.name === "Bash"
                  ? { command: String(input.command ?? ""), cwd: w.worktreePath, tool: block.name, arguments: input }
                  : { tool: block.name, arguments: input },
                "in_progress",
              );
            }
          }
        } else if (msg.type === "user" && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type !== "tool_result") continue;
            const item = getItemByProviderId(db, conv.id, block.tool_use_id);
            if (!item) continue;
            const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
            const limit = 100_000;
            persist(
              block.tool_use_id,
              item.kind,
              {
                ...item.data,
                result: item.kind === "command" ? undefined : output.slice(0, limit),
                output: item.kind === "command" ? output.slice(0, limit) : undefined,
                outputTruncated: output.length > limit,
                error: block.is_error ? output.slice(0, limit) : null,
              },
              block.is_error ? "failed" : "completed",
            );
          }
        } else if (msg.type === "result") {
          flush();
          outcome = msg.subtype === "success" && !msg.is_error ? "succeeded" : "failed";
          error = msg.subtype === "success" ? (msg.is_error ? msg.result : null) : msg.errors.join("\n");
          resulted = true;
          // Without session states (older CLIs), the first result ends the turn.
          if (!sessionStates) break;
        }
      }
    } catch (e) {
      outcome = "failed";
      error = (e as Error).message;
    } finally {
      flush();
      active.query?.close();
      if (active.cancelled) {
        outcome = "cancelled";
        error = null;
      }
      if (this.stopped) {
        outcome = "interrupted";
        error = "The worker stopped during this Claude turn.";
      }
      for (const [id, route] of this.routes)
        if (route.runId === runId) {
          this.routes.delete(id);
          route.answer(null);
        }
      db.tx(() => {
        updateRun(db, runId, { state: outcome, endedAt: nowIso(), error, stopReason: outcome });
        cancelOpenInputsForRun(db, runId);
        updateConversation(db, conv.id, { lastActivityAt: nowIso() });
        for (const row of db.all<{ id: string }>("SELECT id FROM items WHERE run_id = :r AND status = 'in_progress'", {
          r: runId,
        })) {
          const item = getItem(db, row.id)!;
          // Ending the process kills tasks that are still running.
          const task = item.data.task && { ...item.data.task, state: "stopped" as const };
          saveItem(db, {
            ...item,
            data: task ? { ...item.data, task } : item.data,
            status: task ? TASK_STATUS.stopped : outcome === "succeeded" ? "completed" : "failed",
            updatedAt: nowIso(),
          });
        }
      });
      this.active.delete(runId);
      this.ctx.published();
      if (!this.stopped) this.drainQueue(conv.id);
    }
  }

  private async canUseTool(
    conv: Conversation,
    runId: string,
    tool: string,
    input: Record<string, unknown>,
    opts: Parameters<CanUseTool>[2],
    plan: boolean,
  ): Promise<PermissionResult> {
    if (opts.signal.aborted || this.active.get(runId)?.cancelled || this.stopped)
      return { behavior: "deny", message: "Turn stopped.", interrupt: true };
    const question = tool === "AskUserQuestion";
    if (plan && !question && !["Read", "Glob", "Grep", "WebSearch", "WebFetch"].includes(tool)) {
      return {
        behavior: "deny",
        message: "Plan mode permits inspection only. Submit an ordinary turn to make changes.",
      };
    }
    if (!question && conv.approvalPolicy === "never") return { behavior: "allow", updatedInput: input };
    let request: InputRequest;
    if (question) {
      const questions = input.questions as {
        question: string;
        header: string;
        options?: { label: string; description: string }[];
        multiSelect?: boolean;
      }[];
      if (
        !Array.isArray(questions) ||
        !questions.length ||
        questions.some((q) => typeof q.question !== "string" || typeof q.header !== "string")
      )
        return { behavior: "deny", message: "Invalid AskUserQuestion input." };
      request = {
        title: "Claude needs your input",
        questions: questions.map((q, i) => ({
          id: String(i),
          header: q.header,
          question: q.question,
          options: q.options ?? null,
          multiSelect: q.multiSelect ?? false,
          allowOther: true,
          secret: false,
        })),
      };
    } else {
      request = {
        title: `Claude wants to use ${tool}`,
        command: typeof input.command === "string" ? input.command : JSON.stringify(input),
        cwd: getWorkspace(this.ctx.db, conv.workspaceId)!.worktreePath,
        reason: opts.decisionReason ?? null,
        decisions: [
          { id: "accept", label: "Allow once" },
          { id: "decline", label: "Deny" },
        ],
      };
    }
    const id = uuidv7();
    const pending: PendingInput = {
      id,
      conversationId: conv.id,
      runId,
      kind: question ? "question" : tool === "Bash" ? "command_approval" : "permissions",
      state: "open",
      request,
      response: null,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    const response = await new Promise<PendingInput["response"]>((resolve) => {
      const answer = (response: PendingInput["response"]) => {
        opts.signal.removeEventListener("abort", abort);
        resolve(response);
      };
      const abort = () => {
        this.routes.delete(id);
        resolveInput(this.ctx.db, id, "cancelled", null);
        answer(null);
        this.resumeAfterInput(runId);
      };
      this.routes.set(id, { runId, answer });
      this.ctx.db.tx(() => {
        createInput(this.ctx.db, pending, `${runId}:${id}`);
        updateRun(this.ctx.db, runId, { state: "waiting_for_input" });
      });
      opts.signal.addEventListener("abort", abort, { once: true });
      if (opts.signal.aborted) abort();
      this.ctx.published();
    });
    if (response?.kind === "answers") {
      const questions = request.questions!;
      return {
        behavior: "allow",
        updatedInput: {
          ...input,
          answers: Object.fromEntries(questions.map((q) => [q.question, response.answers[q.id]!.join(", ")])),
        },
      };
    }
    return response?.kind === "decision" && response.decision === "accept"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "The user denied this tool call." };
  }

  private resumeAfterInput(runId: string) {
    const run = getRun(this.ctx.db, runId);
    if (
      run?.state === "waiting_for_input" &&
      !this.ctx.db.get("SELECT 1 FROM pending_inputs WHERE run_id = :r AND state = 'open'", { r: runId })
    )
      updateRun(this.ctx.db, runId, { state: "running" });
    this.ctx.published();
  }

  async respond(p: CommandPayload<"input.respond">) {
    const input = getInput(this.ctx.db, p.inputId);
    if (!input) throw new CommandError("Request not found.");
    if (input.state !== "open") throw new CommandError(`This request was already ${input.state}.`);
    this.conversation(input.conversationId);
    const route = this.routes.get(input.id);
    if (!route) throw new CommandError("Claude is no longer waiting for this request.");
    const response = p.response;
    if (input.kind === "question") {
      if (response.kind !== "answers" || input.request.questions!.some((q) => !response.answers[q.id]?.length))
        throw new CommandError("Answer every question before submitting.");
    } else if (response.kind !== "decision" || !input.request.decisions?.some((d) => d.id === response.decision))
      throw new CommandError("Choose one of the offered decisions.");
    if (!resolveInput(this.ctx.db, input.id, "answered", p.response))
      throw new CommandError("This request was already answered from another device.");
    this.routes.delete(input.id);
    route.answer(p.response);
    this.resumeAfterInput(input.runId);
    return { inputId: input.id };
  }

  async interrupt(p: CommandPayload<"turn.interrupt">) {
    const run = getRun(this.ctx.db, p.runId);
    if (!run || run.conversationId !== p.conversationId) throw new CommandError("Run not found in this conversation.");
    this.conversation(p.conversationId);
    if (isTerminalRunState(run.state)) throw new CommandError(`This turn already ended (${run.state}).`);
    if (run.state === "queued") {
      updateRun(this.ctx.db, run.id, { state: "cancelled", endedAt: nowIso(), stopReason: "cancelled while queued" });
    } else {
      const active = this.active.get(run.id);
      if (!active) throw new CommandError("Claude is no longer running this turn.");
      active.cancelled = true;
      updateRun(this.ctx.db, run.id, { state: "stopping" });
      for (const [id, route] of this.routes)
        if (route.runId === run.id) {
          this.routes.delete(id);
          resolveInput(this.ctx.db, id, "cancelled", null);
          route.answer(null);
        }
      active.query?.close();
    }
    this.ctx.published();
    return { runId: run.id, state: getRun(this.ctx.db, run.id)!.state };
  }

  async stopTask(p: CommandPayload<"task.stop">) {
    const run = getRun(this.ctx.db, p.runId);
    if (!run || run.conversationId !== p.conversationId) throw new CommandError("Run not found in this conversation.");
    this.conversation(p.conversationId);
    const query = this.active.get(run.id)?.query;
    if (!query) throw new CommandError("Claude is no longer running this turn.");
    await query.stopTask(p.taskId);
    return { taskId: p.taskId };
  }

  async stop() {
    this.stopped = true;
    for (const active of this.active.values()) active.query?.close();
    for (const route of this.routes.values()) route.answer(null);
    this.routes.clear();
    await Promise.all([...this.active.values()].map((active) => active.task));
  }
}
