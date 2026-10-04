import type { ConversationItem, PendingInput, Run, Workspace } from "@workbench/contracts";
import { isTerminalRunState } from "@workbench/contracts";
import clsx from "clsx";
import {
  AlertTriangle,
  ArrowDown,
  Brain,
  ChevronRight,
  CircleCheck,
  CircleX,
  FileDiff,
  ListTodo,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadOlder, sortedItems, useStore } from "../lib/store.ts";
import { Composer } from "./Composer.tsx";
import { ConversationImages } from "./ConversationImages.tsx";
import { DiffText } from "./DiffText.tsx";
import { InputPanel } from "./InputPanel.tsx";
import { Markdown } from "./Markdown.tsx";
import { Button, StatusIndicator } from "./ui.tsx";

export function ConversationView({ workspace }: { workspace: Workspace }) {
  const conv = useStore((s) => s.conversation);
  const conversation = useStore((s) => (s.conversation ? s.conversations[s.conversation.id] : undefined));
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const items = useMemo(() => (conv ? sortedItems(conv) : []), [conv]);
  const runs = useMemo(() => (conv ? Object.values(conv.runs) : []), [conv]);
  const openInputs = useMemo(
    () => (conv ? Object.values(conv.inputs).filter((i) => i.state === "open") : []) as PendingInput[],
    [conv],
  );
  const activeRun = runs.find((r) => !isTerminalRunState(r.state));
  const runEnds = useMemo(() => endMarkers(items, runs), [items, runs]);

  // Follow new output only when the reader is already at the bottom.
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when content changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [items, openInputs.length, runEnds]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on conversation switch.
  useEffect(() => {
    setAtBottom(true);
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [conv?.id, conv?.loading]);

  // Images and lazy diagram rendering can resize a message after its item arrives.
  useEffect(() => {
    if (!conv?.id || !content.current) return;
    const observer = new ResizeObserver(() => {
      const el = scroller.current;
      if (el && atBottom) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [atBottom, conv?.id]);

  const jump = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  if (!conv || !conversation) return null;

  const older = async () => {
    const el = scroller.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    setLoadingOlder(true);
    try {
      await loadOlder();
    } finally {
      setLoadingOlder(false);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          className="h-full overflow-y-auto overscroll-contain px-3 py-4 md:px-6"
          aria-live="polite"
          aria-busy={conv.loading}
        >
          <div ref={content} className="mx-auto max-w-3xl space-y-3">
            {conv.hasMore && (
              <div className="flex justify-center">
                <Button size="xs" onClick={() => void older()} disabled={loadingOlder}>
                  {loadingOlder ? "Loading…" : "Load older messages"}
                </Button>
              </div>
            )}
            {conv.loading && <p className="text-center text-[13px] text-neutral-500">Loading conversation…</p>}
            {conv.error && <p className="text-center text-[13px] text-red-400">{conv.error}</p>}
            {!conv.loading && items.length === 0 && (
              <div className="py-16 text-center text-[13px] text-neutral-500">
                <p className="text-neutral-300">Codex in {workspace.name}</p>
                <p className="mt-1 font-mono text-[12px]">{workspace.worktreePath}</p>
                <p className="mt-3">Describe the change you want. Codex works in this workspace's worktree.</p>
              </div>
            )}
            {items.map((item) => (
              <div key={item.id}>
                <ItemView item={item} />
                {runEnds[item.id]?.map((r) => (
                  <RunOutcome key={r.id} run={r} />
                ))}
              </div>
            ))}
            {activeRun && <ActiveRunLine run={activeRun} />}
          </div>
        </div>
        {!atBottom && (
          <button
            type="button"
            onClick={jump}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-wb-border-strong bg-wb-panel-2 px-3 py-1.5 text-[12px] text-neutral-200 shadow-lg"
          >
            <ArrowDown size={13} /> Jump to latest
          </button>
        )}
      </div>
      {openInputs.length > 0 && <InputPanel inputs={openInputs} />}
      <Composer conversationId={conv.id} workspace={workspace} activeRun={activeRun ?? null} />
    </div>
  );
}

/** Attach each finished run's outcome after its last item. */
function endMarkers(items: ConversationItem[], runs: Run[]): Record<string, Run[]> {
  const last: Record<string, string> = {};
  for (const i of items) if (i.runId) last[i.runId] = i.id;
  const out: Record<string, Run[]> = {};
  for (const r of runs) {
    if (!isTerminalRunState(r.state) || r.state === "succeeded") continue;
    const at = last[r.id];
    if (!at) continue;
    out[at] ??= [];
    out[at].push(r);
  }
  return out;
}

function RunOutcome({ run }: { run: Run }) {
  const label = { failed: "Turn failed", cancelled: "Turn cancelled", interrupted: "Turn interrupted" }[
    run.state as "failed" | "cancelled" | "interrupted"
  ];
  return (
    <div
      className={clsx(
        "mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-[13px]",
        run.state === "cancelled"
          ? "border-wb-border text-neutral-400"
          : "border-orange-900/60 bg-orange-950/30 text-orange-200",
      )}
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span>
        {label}
        {run.error ? `: ${run.error}` : "."}
      </span>
    </div>
  );
}

function ActiveRunLine({ run }: { run: Run }) {
  const text: Record<string, string> = {
    queued: "Queued — another turn is running in this workspace.",
    starting: "Starting…",
    running: "Working…",
    waiting_for_input: "Waiting for your answer.",
    stopping: "Stopping…",
  };
  return (
    <div className="flex items-center gap-2 py-1 text-[13px] text-neutral-400">
      <StatusIndicator state={run.state} />
      {text[run.state] ?? run.state}
    </div>
  );
}

const ItemView = memo(function ItemView({ item }: { item: ConversationItem }) {
  const d = item.data;
  switch (item.kind) {
    case "user_message":
      return (
        <div className="flex justify-end">
          <div className="max-w-[92%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-neutral-800/80 px-3.5 py-2.5 text-[14px] leading-relaxed text-neutral-100">
            {d.phase === "plan" && (
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-sky-300">
                Plan mode
              </span>
            )}
            {d.text}
            <ConversationImages item={item} />
          </div>
        </div>
      );
    case "agent_message":
      if (!d.text) return item.status === "in_progress" ? <div className="h-5" /> : null;
      return (
        <Markdown
          itemId={item.id}
          text={d.text}
          className={clsx(d.phase === "commentary" ? "text-neutral-400" : "text-neutral-200")}
        />
      );
    case "reasoning":
      if (!d.text?.trim()) return null;
      return (
        <Card icon={<Brain size={13} />} title="Thinking" tone="quiet">
          <Markdown itemId={item.id} text={d.text} className="text-[13px] text-neutral-400" />
        </Card>
      );
    case "plan":
      return (
        <Card icon={<ListTodo size={13} />} title="Plan" defaultOpen>
          <Markdown itemId={item.id} text={d.text ?? ""} className="text-[13px]" />
        </Card>
      );
    case "command":
      return <CommandCard item={item} />;
    case "file_change":
      return <FileChangeCard item={item} />;
    case "tool_call":
      return (
        <>
          <Card
            icon={<Wrench size={13} />}
            title={<span className="font-mono">{[d.server, d.tool].filter(Boolean).join(" · ")}</span>}
            status={item.status}
          >
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[12px] text-neutral-400">
              {JSON.stringify(d.arguments, null, 2)}
              {d.error ? `\n\nError: ${d.error}` : d.result ? `\n\n${JSON.stringify(d.result, null, 2)}` : ""}
            </pre>
          </Card>
          <ConversationImages item={item} />
        </>
      );
    case "web_search":
      return (
        <div className="flex items-center gap-2 text-[13px] text-neutral-400">
          <Search size={13} /> Searched the web{d.query ? `: ${d.query}` : ""}
        </div>
      );
    case "image":
      return <ConversationImages item={item} />;
    case "notice":
      return (
        <p className={clsx("text-[13px] italic", item.status === "failed" ? "text-red-300" : "text-neutral-500")}>
          {d.text}
        </p>
      );
    default:
      return <p className="text-[12px] text-neutral-600">Unsupported activity: {d.providerType ?? item.kind}</p>;
  }
});

function StatusIcon({ status }: { status: ConversationItem["status"] }) {
  if (status === "in_progress") return <StatusIndicator state="running" />;
  if (status === "failed") return <CircleX size={13} className="text-red-400" aria-label="failed" />;
  if (status === "declined") return <CircleX size={13} className="text-amber-400" aria-label="declined" />;
  return <CircleCheck size={13} className="text-neutral-600" aria-label="completed" />;
}

function Card({
  icon,
  title,
  meta,
  status,
  children,
  defaultOpen = false,
  tone,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  status?: ConversationItem["status"];
  children?: React.ReactNode;
  defaultOpen?: boolean;
  tone?: "quiet";
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={clsx("rounded-lg border", tone === "quiet" ? "border-transparent" : "border-wb-border bg-wb-panel")}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          size={13}
          className={clsx("shrink-0 text-neutral-500 transition-transform", open && "rotate-90")}
        />
        <span className="shrink-0 text-neutral-500">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-300">{title}</span>
        {meta && <span className="shrink-0 text-[11px] text-neutral-500">{meta}</span>}
        {status !== undefined && <StatusIcon status={status} />}
      </button>
      {open && children && <div className="border-t border-wb-border px-3 py-2">{children}</div>}
    </div>
  );
}

function CommandCard({ item }: { item: ConversationItem }) {
  const d = item.data;
  const meta = [
    d.exitCode != null && d.exitCode !== 0 ? `exit ${d.exitCode}` : null,
    d.durationMs != null ? `${(d.durationMs / 1000).toFixed(1)}s` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card
      icon={<SquareTerminal size={13} />}
      title={<span className="font-mono text-[12.5px]">{d.command}</span>}
      meta={meta}
      status={item.status}
    >
      {d.cwd && <p className="mb-1 truncate font-mono text-[11px] text-neutral-600">{d.cwd}</p>}
      {item.status === "declined" && <p className="text-[12px] text-amber-300">Declined.</p>}
      {d.outputTruncated && <p className="mb-1 text-[11px] text-amber-300">Output truncated to the last 64 KiB.</p>}
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-[1.5] text-neutral-300">
        {d.output || (item.status === "in_progress" ? "…" : "(no output)")}
      </pre>
    </Card>
  );
}

function FileChangeCard({ item }: { item: ConversationItem }) {
  const changes = item.data.changes ?? [];
  const count = (diff: string, c: string) =>
    diff.split("\n").filter((l) => l.startsWith(c) && !l.startsWith(c.repeat(3))).length;
  const title =
    changes.length === 1 ? (
      <span className="font-mono text-[12.5px]">{changes[0]!.path.split("/").slice(-2).join("/")}</span>
    ) : (
      `${changes.length} files`
    );
  return (
    <Card icon={<FileDiff size={13} />} title={<>Edited {title}</>} status={item.status}>
      <p className="mb-2 text-[11px] text-neutral-500">
        The agent's patch. Use Changes for the authoritative Git diff.
      </p>
      <div className="space-y-3">
        {changes.map((c) => (
          <div key={c.path} className="overflow-hidden rounded border border-wb-border">
            <div className="flex items-center gap-2 border-b border-wb-border bg-wb-panel-2 px-2 py-1 font-mono text-[11.5px]">
              <span className="min-w-0 flex-1 truncate text-neutral-300">{c.movePath ?? c.path}</span>
              <span className="text-emerald-400">+{count(c.diff, "+")}</span>
              <span className="text-red-400">-{count(c.diff, "-")}</span>
            </div>
            <DiffText diff={c.diff} />
          </div>
        ))}
      </div>
    </Card>
  );
}
