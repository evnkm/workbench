// Persistent shells for a workspace: tabs, a terminal, and phone-friendly
// key and command input. Shells run in tmux on the server; closing the
// browser detaches without stopping them.
import type { ProcessSession, Workspace } from "@workbench/contracts";
import clsx from "clsx";
import { History, Plus, Send, X } from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { api, sendCommand } from "../lib/api.ts";
import { useStore } from "../lib/store.ts";
import type { TerminalHandle } from "./Terminal.tsx";
import { Button, Dialog, IconButton, PaneHeader } from "./ui.tsx";

const Terminal = lazy(() => import("./Terminal.tsx").then((m) => ({ default: m.Terminal })));

const KEYS: { label: string; seq: string }[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "^C", seq: "\x03" },
  { label: "^D", seq: "\x04" },
  { label: "^L", seq: "\x0c" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
];

export function ShellPanel({ workspace }: { workspace: Workspace }) {
  const processes = useStore((s) => s.processes);
  const shells = useMemo(
    () =>
      (Object.values(processes) as ProcessSession[])
        .filter((p) => p.workspaceId === workspace.id && p.kind === "shell" && p.state === "running")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [processes, workspace.id],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const [history, setHistory] = useState<string | null>(null);
  const term = useRef<TerminalHandle>(null);
  const current = shells.find((s) => s.id === selected) ?? shells[shells.length - 1] ?? null;

  const create = async () => {
    setError(null);
    try {
      const r = (await sendCommand("shell.create", { workspaceId: workspace.id })) as { processId: string };
      setSelected(r.processId);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const kill = async (p: ProcessSession) => {
    if (!confirm(`Terminate ${p.name}? Anything running in it stops.`)) return;
    try {
      await sendCommand("shell.kill", { processId: p.id });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const showHistory = async () => {
    if (!current) return;
    const r = await api<{ text: string }>(`/api/processes/${current.id}/history?lines=3000`);
    setHistory(r.text);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-wb-bg">
      <PaneHeader
        leading={
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist">
            {shells.length === 0 && (
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400">Shell</span>
            )}
            {shells.map((s) => (
              <span
                key={s.id}
                className={clsx(
                  "flex h-8 shrink-0 items-center rounded-md text-[12.5px]",
                  s.id === current?.id ? "bg-neutral-800 text-neutral-100" : "text-neutral-400",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={s.id === current?.id}
                  className="h-full px-2.5"
                  onClick={() => setSelected(s.id)}
                >
                  {s.name}
                </button>
                <button
                  type="button"
                  aria-label={`Terminate ${s.name}`}
                  className="h-full pr-2 text-neutral-500 hover:text-red-400"
                  onClick={() => void kill(s)}
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        }
      >
        {current && (
          <IconButton label="Scrollback history" onClick={() => void showHistory()}>
            <History size={15} />
          </IconButton>
        )}
        <IconButton label="New shell" onClick={() => void create()} disabled={workspace.state === "archived"}>
          <Plus size={16} />
        </IconButton>
      </PaneHeader>
      {error && <p className="px-3 py-2 text-[12px] text-red-300">{error}</p>}
      {current ? (
        <>
          <div className="min-h-0 flex-1">
            <Suspense fallback={null}>
              <Terminal key={current.id} processId={current.id} ref={term} />
            </Suspense>
          </div>
          {/* Phone input: special keys and a command line that sends on Enter. */}
          <div className="shrink-0 border-t border-wb-border bg-wb-panel md:hidden">
            <div className="flex gap-1 overflow-x-auto px-2 py-1.5">
              {KEYS.map((k) => (
                <button
                  key={k.label}
                  type="button"
                  onClick={() => term.current?.send(k.seq)}
                  className="h-9 min-w-11 shrink-0 rounded-md border border-wb-border bg-wb-bg px-2 font-mono text-[13px] text-neutral-200"
                >
                  {k.label}
                </button>
              ))}
            </div>
            <form
              className="flex gap-2 px-2 pb-2 pb-safe"
              onSubmit={(e) => {
                e.preventDefault();
                term.current?.send(`${line}\r`);
                setLine("");
              }}
            >
              <input
                value={line}
                onChange={(e) => setLine(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Type a command"
                aria-label="Command"
                className="h-10 min-w-0 flex-1 rounded-md border border-wb-border-strong bg-wb-bg px-3 font-mono text-[16px] text-neutral-100"
              />
              <button
                type="submit"
                aria-label="Send command"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-wb-accent text-neutral-950"
              >
                <Send size={16} />
              </button>
            </form>
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-neutral-500">
          <p>Shells run in the workspace's worktree and keep running when you close the browser.</p>
          <Button variant="primary" size="md" onClick={() => void create()} disabled={workspace.state === "archived"}>
            Open a shell
          </Button>
        </div>
      )}
      {history !== null && (
        <Dialog title="Scrollback" onClose={() => setHistory(null)} wide>
          <pre className="whitespace-pre-wrap break-all font-mono text-[12px] text-neutral-300">
            {history || "(empty)"}
          </pre>
        </Dialog>
      )}
    </div>
  );
}
