import {
  type Conversation,
  type InspectResult,
  type NativeCommand,
  PROVIDER_LABELS,
  type Run,
  type Workspace,
} from "@workbench/contracts";
import clsx from "clsx";
import { ArrowUp, ListPlus, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sendCommand } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { type MenuCommand, parseSlash, slashCommands } from "../lib/slash-commands.ts";
import { useStore } from "../lib/store.ts";
import { SlashCommandDialog, type SlashPanel } from "./SlashCommandDialog.tsx";
import { Dialog } from "./ui.tsx";

const draftKey = (id: string) => `wb:draft:${id}`;
const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches;

export function Composer({
  conversation,
  workspace,
  activeRun,
}: {
  conversation: Conversation;
  workspace: Workspace;
  activeRun: Run | null;
}) {
  const conversationId = conversation.id;
  const [text, setText] = useState(() => localStorage.getItem(draftKey(conversationId)) ?? "");
  const [plan, setPlan] = useState(() => localStorage.getItem(`wb:plan:${conversationId}`) === "1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const worker = useStore((s) => s.worker);
  const providerStatus = worker?.[conversation.provider];
  const agent = PROVIDER_LABELS[conversation.provider];
  const [native, setNative] = useState<NativeCommand[]>([]);
  const commands = slashCommands(conversation.provider, native);
  const detail = useStore((s) => s.conversation);
  const runs = useStore((s) => s.runs);
  const otherSessions = Object.values(runs).filter(
    (run) =>
      run.kind === "agent_turn" &&
      run.workspaceId === workspace.id &&
      run.conversationId !== conversationId &&
      ["starting", "running", "waiting_for_input", "stopping"].includes(run.state),
  );
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [panel, setPanel] = useState<SlashPanel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const slash = parseSlash(text);
  const matches = slash ? commands.filter((c) => c.name.startsWith(slash.query)) : [];
  // The menu closes once the command name is followed by a space, so arguments can be typed.
  const menuOpen = focused && slash !== null && !/\s/.test(text.trimStart()) && !dismissed;
  const listId = `slash-${conversationId}`;

  useEffect(() => {
    localStorage.setItem(`wb:plan:${conversationId}`, plan ? "1" : "0");
  }, [conversationId, plan]);
  // Claude's own commands depend on the worktree's skills and settings.
  const listNative = conversation.provider === "claude" && providerStatus?.state === "ready";
  useEffect(() => {
    setNative([]);
    if (!listNative) return;
    let stopped = false;
    sendCommand("conversation.inspect", { conversationId, view: "commands" }).then(
      (result) => {
        const data = result as InspectResult;
        if (!stopped && data.kind === "commands") setNative(data.commands);
      },
      (e) => {
        if (!stopped) setError(`Claude's commands could not be listed: ${(e as Error).message}`);
      },
    );
    return () => {
      stopped = true;
    };
  }, [conversationId, listNative]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset completion when the text changes.
  useEffect(() => {
    setSelected(0);
    setDismissed(false);
  }, [text]);
  useEffect(() => {
    if (menuOpen) document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, listId, selected]);

  useEffect(() => {
    if (text) localStorage.setItem(draftKey(conversationId), text);
    else localStorage.removeItem(draftKey(conversationId));
  }, [text, conversationId]);
  // Grow with content up to a cap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize on text change.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const queued = Object.values(detail?.runs ?? {})
    .filter((r) => r.state === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const delivering = new Set(
    Object.values(detail?.items ?? {})
      .filter((i) => i.data.steering)
      .map((i) => i.runId),
  );
  const running = activeRun !== null || queued.length > 0;
  const [removing, setRemoving] = useState<string | null>(null);
  const removeQueued = async (run: Run) => {
    setRemoving(run.id);
    setError(null);
    try {
      await sendCommand("turn.interrupt", { conversationId, runId: run.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRemoving(null);
    }
  };
  const ready = workspace.state === "ready";
  const unavailable = providerStatus?.state === "unavailable";

  const focus = () => requestAnimationFrame(() => ref.current?.focus());
  const submit = async (body: string) => {
    setBusy(true);
    setError(null);
    try {
      await sendCommand("turn.start", { conversationId, text: body, mode: plan ? "plan" : "default" });
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Choosing a native command that takes arguments fills it in for them to be typed.
  const choose = (command: MenuCommand) => {
    if ("native" in command && command.argumentHint) {
      setText(`/${command.name} `);
      focus();
    } else void execute(command);
  };
  const execute = async (command: MenuCommand, args = "") => {
    if (busy) return;
    if ("native" in command) return submit(`/${command.name}${args ? ` ${args}` : ""}`);
    setError(null);
    setConfirmation(null);
    setBusy(true);
    try {
      if ("unavailable" in command) {
        setNotice(command.unavailable);
      } else {
        switch (command.name) {
          case "model":
            if (args) {
              const [model, reasoningEffort, extra] = args.split(/\s+/);
              if (extra) throw new Error("Use /model <model> [reasoning effort], or /model for the picker.");
              await sendCommand("conversation.configure", { conversationId, model, reasoningEffort });
              setConfirmation("Model saved for the next turn.");
            } else setPanel("model");
            break;
          case "reasoning":
          case "effort":
            if (args) {
              await sendCommand("conversation.configure", { conversationId, reasoningEffort: args });
              setConfirmation("Reasoning effort saved for the next turn.");
            } else setPanel("reasoning");
            break;
          case "fast":
            if (args) {
              if (args !== "on" && args !== "off")
                throw new Error("Use /fast on, /fast off, or /fast for the speed picker.");
              const data = (await sendCommand("conversation.inspect", {
                conversationId,
                view: "models",
              })) as InspectResult;
              if (data.kind !== "models") throw new Error(`${agent} did not return its model choices.`);
              const model =
                data.models.find((m) => m.model === conversation.model) ??
                (conversation.model == null ? data.models.find((m) => m.isDefault) : undefined);
              const fast = model?.serviceTiers.find((tier) => /^fast$/i.test(tier.name) || tier.id === "fast");
              if (args === "on" && !fast) throw new Error("This model does not offer a Fast tier in your account.");
              await sendCommand("conversation.configure", {
                conversationId,
                serviceTier: args === "on" ? fast!.id : null,
              });
              setConfirmation(`Speed saved: ${args === "on" ? "Fast" : "Standard"}.`);
            } else setPanel("fast");
            break;
          case "permissions":
            setPanel("permissions");
            break;
          case "plan":
            if (running) throw new Error("Wait for the current turn to finish before switching Plan mode.");
            if (args) await sendCommand("turn.start", { conversationId, text: args, mode: "plan" });
            setPlan(args ? true : !plan);
            break;
          case "review":
            if (running) throw new Error("Wait for the current turn to finish or stop it before starting a review.");
            if (args)
              await sendCommand("turn.start", {
                conversationId,
                text: `Review changes against ${args}`,
                mode: "review",
                reviewTarget: { type: "baseBranch", branch: args },
              });
            else setPanel("review");
            break;
          case "status":
          case "usage":
          case "skills":
          case "apps":
          case "plugins":
          case "hooks":
          case "mcp":
            setPanel(command.name);
            break;
          case "compact":
          case "fork":
          case "stop": {
            const result = (await sendCommand("conversation.action", {
              conversationId,
              action: command.name === "stop" ? "stop-background" : command.name,
            })) as { conversationId: string };
            if (command.name === "fork")
              navigate({
                name: "workspace",
                workspaceId: workspace.id,
                conversationId: result.conversationId,
                pane: "conversation",
              });
            else
              setConfirmation(
                command.name === "compact" ? "Codex context compaction started." : "Background terminals stopped.",
              );
            break;
          }
          case "new":
          case "clear": {
            const result = (await sendCommand("conversation.create", {
              workspaceId: workspace.id,
              provider: conversation.provider,
              approvalPolicy: conversation.approvalPolicy,
              model: conversation.model ?? undefined,
              title: args || undefined,
            })) as { conversationId: string };
            navigate({
              name: "workspace",
              workspaceId: workspace.id,
              conversationId: result.conversationId,
              pane: "conversation",
            });
            break;
          }
          case "resume":
            setPanel("resume");
            break;
          case "rename":
            if (args) await sendCommand("conversation.rename", { conversationId, title: args });
            else setPanel("rename");
            break;
          case "delete":
            if (running) throw new Error("Stop the active or queued run before deleting this conversation.");
            if (!confirm(`Delete "${conversation.title}" and its conversation history? This cannot be undone.`)) return;
            await sendCommand("conversation.delete", { conversationId });
            break;
          case "diff":
            navigate({ name: "workspace", workspaceId: workspace.id, conversationId, pane: "changes" });
            break;
          case "ps":
            navigate({ name: "workspace", workspaceId: workspace.id, conversationId, pane: "shell" });
            break;
          case "copy": {
            const latest = Object.values(detail?.items ?? {})
              .filter((i) => i.kind === "agent_message" && i.status === "completed" && i.data.phase !== "commentary")
              .sort((a, b) => b.position - a.position)[0];
            if (!latest?.data.text) throw new Error("There is no completed assistant response to copy yet.");
            await navigator.clipboard.writeText(latest.data.text);
            setConfirmation("Latest response copied.");
            break;
          }
          case "init":
            setText(
              "Inspect the existing project instructions and create or update AGENTS.md with concise guidance for working in this repository. Preserve relevant existing instructions.",
            );
            focus();
            return;
          case "mention":
            if (args) {
              setText(`Please inspect ${args} `);
              focus();
              return;
            }
            setPanel("mention");
            break;
          case "theme":
            setPanel("theme");
            break;
          case "help":
            setNotice(
              conversation.provider === "claude"
                ? "Type / at the start of the message to browse commands, then keep typing to filter. Use ↑/↓ and Enter or Tab, or tap an option. Escape closes the menu. Model, effort, speed, and approval changes are saved for subsequent turns. Commands marked ‘Claude’ and any other /text are sent to Claude, which runs its own commands and skills."
                : "Type / at the start of the message to browse commands, then keep typing to filter. Use ↑/↓ and Enter or Tab, or tap an option. Escape closes the menu. Model, reasoning, speed, and approval changes are saved for subsequent turns. Commands marked ‘Other surface’ explain where they are available. Paths such as /home/ubuntu are sent as ordinary message text.",
            );
            break;
          case "exit":
          case "quit":
            navigate({ name: "home" });
            break;
          default: {
            const never: never = command;
            throw new Error(`Unsupported command: ${never}`);
          }
        }
      }
      setText("");
      setDismissed(true);
      focus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    const command = parseSlash(body);
    const match = command && commands.find((c) => c.name === command.query);
    if (match) await execute(match, command.args);
    // Claude resolves unlisted /text itself, for example a skill added during this session.
    else if (command && conversation.provider === "codex")
      setError(`Unknown command /${command.query}. Type / to see available commands.`);
    else await submit(body);
  };

  const interrupt = async () => {
    if (!activeRun) return;
    setError(null);
    try {
      await sendCommand("turn.interrupt", { conversationId, runId: activeRun.id });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const disabledReason = !ready
    ? `Workspace is ${workspace.state.replace("_", " ")}.`
    : unavailable
      ? `${agent} is unavailable: ${conversation.provider === "claude" ? (worker?.claude.reason ?? "") : (worker?.codex.error ?? "")}`
      : null;

  return (
    <div className="shrink-0 border-t border-wb-border bg-wb-panel px-3 pb-safe pt-2 md:px-6">
      <div className="mx-auto max-w-3xl pb-2">
        {(error || disabledReason) && (
          <p role="alert" className="mb-2 text-[12px] text-red-300">
            {error ?? disabledReason}
          </p>
        )}
        {confirmation && (
          <p role="status" className="mb-2 text-[12px] text-neutral-400">
            {confirmation}
          </p>
        )}
        {otherSessions.length > 0 && (
          <p
            role="status"
            className="mb-2 text-[12px] text-amber-200/80"
            title={otherSessions.map((run) => run.summary).join("\n")}
          >
            {otherSessions.length} other {otherSessions.length === 1 ? "session shares" : "sessions share"} this
            worktree. Coordinate overlapping edits.
          </p>
        )}
        {queued.length > 0 && (
          <section aria-label="Queued messages" className="mb-2 rounded-lg border border-wb-border px-3 py-2">
            <p className="text-[12px] text-neutral-400">
              {queued.length} queued ·{" "}
              {conversation.provider === "claude" ? "Next turn" : "Next tool boundary, or next turn for mode changes"}
            </p>
            <ol className="max-h-32 overflow-y-auto">
              {queued.map((run, index) => (
                <li key={run.id} className="flex items-center gap-2 text-[13px] text-neutral-300">
                  <span className="text-neutral-500">{index + 1}.</span>
                  <span className="min-w-0 flex-1 truncate" title={run.summary}>
                    {run.summary}
                    {delivering.has(run.id) && <span className="ml-2 text-neutral-500">Delivering…</span>}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove queued message ${index + 1}`}
                    title="Remove queued message"
                    disabled={removing !== null || delivering.has(run.id)}
                    onClick={() => void removeQueued(run)}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-neutral-800 disabled:opacity-40"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
        <div className="relative flex items-end gap-2 rounded-xl border border-wb-border-strong bg-wb-bg p-1.5 focus-within:border-neutral-500">
          {menuOpen && (
            <div
              data-slash-menu
              className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-lg border border-wb-border-strong bg-wb-panel shadow-xl"
            >
              <div className="border-b border-wb-border px-3 py-2 text-[12px] text-neutral-500">
                Slash commands
                <span className="hidden md:inline"> · ↑/↓ to browse · Enter or Tab to choose</span>
                <span className="md:hidden"> · Tap to choose</span>
              </div>
              <div
                id={listId}
                role="listbox"
                aria-label="Slash commands"
                className="max-h-[min(45dvh,22rem)] overflow-y-auto overscroll-contain p-1"
              >
                {matches.map((command, index) => (
                  <button
                    key={command.name}
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === selected}
                    disabled={busy}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(command)}
                    className={clsx(
                      "flex min-h-12 w-full items-start gap-3 rounded-md px-3 py-2 text-left disabled:opacity-40",
                      index === selected ? "bg-neutral-800" : "hover:bg-neutral-900",
                    )}
                  >
                    <span className="w-24 shrink-0 break-words font-mono text-[13px] text-neutral-200">
                      /{command.name}
                    </span>
                    <span className="min-w-0 text-[12px] text-neutral-400">
                      <span className="line-clamp-2">{command.description}</span>
                      {"unavailable" in command && (
                        <span className="block text-[11px] text-neutral-500">Other surface</span>
                      )}
                      {"native" in command && (
                        <span className="block text-[11px] text-neutral-500">
                          Claude{command.argumentHint && ` · ${command.argumentHint}`}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
                {matches.length === 0 && (
                  <p className="px-3 py-3 text-[13px] text-neutral-500">No matching commands.</p>
                )}
              </div>
            </div>
          )}
          <textarea
            ref={ref}
            value={text}
            rows={1}
            onChange={(e) => {
              setText(e.target.value);
              setConfirmation(null);
            }}
            onFocus={() => setFocused(true)}
            onBlur={(e) => {
              if (!(e.relatedTarget instanceof Element) || !e.relatedTarget.closest("[data-slash-menu]"))
                setFocused(false);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (menuOpen) {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDismissed(true);
                  return;
                }
                if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length) {
                  e.preventDefault();
                  setSelected((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
                  return;
                }
                if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && matches[selected]) {
                  e.preventDefault();
                  choose(matches[selected]);
                  return;
                }
              }
              // Enter sends on desktop; on touch keyboards Enter inserts a newline.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarsePointer()) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              running
                ? conversation.provider === "claude"
                  ? "Queue a message for Claude's next turn…"
                  : "Steer Codex at the next tool boundary…"
                : plan
                  ? "Describe what to plan…"
                  : `Ask ${agent} to make a change…`
            }
            aria-label="Message"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? listId : undefined}
            aria-activedescendant={menuOpen && matches[selected] ? `${listId}-${selected}` : undefined}
            disabled={!ready}
            className="max-h-60 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[16px] leading-snug text-neutral-100 placeholder:text-neutral-600 focus:outline-none md:text-[14px]"
          />
          {activeRun && (
            <button
              type="button"
              onClick={() => void interrupt()}
              disabled={activeRun.state === "stopping"}
              aria-label="Interrupt turn"
              title="Interrupt turn"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-200 text-neutral-950 disabled:opacity-40"
            >
              <Square size={14} fill="currentColor" />
            </button>
          )}
          <button
            type="button"
            onClick={() => void send()}
            disabled={!text.trim() || busy || !!disabledReason}
            aria-label={running ? "Queue message" : "Send"}
            title={running ? "Queue message" : "Send"}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-wb-accent text-neutral-950 disabled:opacity-30"
          >
            {running ? <ListPlus size={18} /> : <ArrowUp size={18} />}
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[12px] text-neutral-500">
          <label className="inline-flex min-h-7 items-center gap-1.5">
            <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} />
            <span className={clsx(plan && "text-sky-300")}>Plan mode</span>
          </label>
          {conversation.model && (
            <span className="max-w-40 truncate" title={conversation.model}>
              {conversation.model}
              {conversation.serviceTier ? ` · ${conversation.serviceTier}` : ""}
            </span>
          )}
          <span className="hidden md:inline">Enter to send · Shift+Enter for a newline · / for commands</span>
          <span className="md:hidden">/ for commands</span>
        </div>
      </div>
      {panel && (
        <SlashCommandDialog
          panel={panel}
          conversation={conversation}
          workspace={workspace}
          onClose={() => {
            setPanel(null);
            focus();
          }}
          onDraft={(draft) => setText(draft)}
        />
      )}
      {notice && (
        <Dialog
          title="Slash commands"
          onClose={() => {
            setNotice(null);
            focus();
          }}
        >
          <p className="text-[13px] leading-relaxed text-neutral-300">{notice}</p>
        </Dialog>
      )}
    </div>
  );
}
