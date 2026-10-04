import type { Run, Workspace } from "@workbench/contracts";
import clsx from "clsx";
import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sendCommand } from "../lib/api.ts";
import { useStore } from "../lib/store.ts";

const draftKey = (id: string) => `wb:draft:${id}`;
const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches;

export function Composer({
  conversationId,
  workspace,
  activeRun,
}: {
  conversationId: string;
  workspace: Workspace;
  activeRun: Run | null;
}) {
  const [text, setText] = useState(() => localStorage.getItem(draftKey(conversationId)) ?? "");
  const [plan, setPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const codex = useStore((s) => s.worker?.codex);

  useEffect(() => {
    setText(localStorage.getItem(draftKey(conversationId)) ?? "");
    setError(null);
  }, [conversationId]);
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

  const running = activeRun !== null;
  const ready = workspace.state === "ready";
  const unavailable = codex?.state === "unavailable";

  const send = async () => {
    const body = text.trim();
    if (!body || running || busy) return;
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
      ? `Codex is unavailable: ${codex?.error ?? ""}`
      : null;

  return (
    <div className="shrink-0 border-t border-wb-border bg-wb-panel px-3 pb-safe pt-2 md:px-6">
      <div className="mx-auto max-w-3xl pb-2">
        {(error || disabledReason) && (
          <p role="alert" className="mb-2 text-[12px] text-red-300">
            {error ?? disabledReason}
          </p>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-wb-border-strong bg-wb-bg p-1.5 focus-within:border-neutral-500">
          <textarea
            ref={ref}
            value={text}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends on desktop; on touch keyboards Enter inserts a newline.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarsePointer()) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              running ? "Codex is working…" : plan ? "Describe what to plan…" : "Ask Codex to make a change…"
            }
            aria-label="Message"
            disabled={!ready}
            className="max-h-60 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[16px] leading-snug text-neutral-100 placeholder:text-neutral-600 focus:outline-none md:text-[14px]"
          />
          {running ? (
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
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              disabled={!text.trim() || busy || !!disabledReason}
              aria-label="Send"
              title="Send"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-wb-accent text-neutral-950 disabled:opacity-30"
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-3 px-1 text-[12px] text-neutral-500">
          <label className="inline-flex min-h-7 items-center gap-1.5">
            <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} />
            <span className={clsx(plan && "text-sky-300")}>Plan mode</span>
          </label>
          <span className="hidden md:inline">Enter to send · Shift+Enter for a newline</span>
        </div>
      </div>
    </div>
  );
}
