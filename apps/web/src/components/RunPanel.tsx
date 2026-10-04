// The workspace's application process: configuration, reserved ports,
// start/stop, live log, and preview links. Independent of agent turns.
import type { ProcessSession, Workspace } from "@workbench/contracts";
import { ExternalLink, Play, Square, TerminalSquare } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, sendCommand } from "../lib/api.ts";
import { useStore } from "../lib/store.ts";
import { Button, Dialog, ErrorText, Field, inputClass, PaneHeader, StatusIndicator } from "./ui.tsx";

const Terminal = lazy(() => import("./Terminal.tsx").then((m) => ({ default: m.Terminal })));

type RunInfo = {
  config: {
    source: string | null;
    error: string | null;
    setupCommand: string | null;
    runCommand: string | null;
    ports: { name: string; port: number | null }[];
    previews: { name: string; port: number | null; path: string }[];
  } | null;
  previewHost: string | null;
};

export function RunPanel({ workspace }: { workspace: Workspace }) {
  const processes = useStore((s) => s.processes);
  const project = useStore((s) => s.projects[workspace.projectId]);
  const app = useMemo(
    () =>
      (Object.values(processes) as ProcessSession[])
        .filter((p) => p.workspaceId === workspace.id && p.kind === "app")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
    [processes, workspace.id],
  );
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"log" | "terminal">("log");
  const [editing, setEditing] = useState(false);
  const running = app?.state === "running";

  const load = useCallback(() => {
    api<RunInfo>(`/api/workspaces/${workspace.id}/run`).then(setInfo, (e) => setError((e as Error).message));
  }, [workspace.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the project settings change.
  useEffect(load, [load, project?.updatedAt]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const openPreview = async (name: string) => {
    // Open the tab synchronously so mobile browsers do not block it as a popup.
    const tab = window.open("", "_blank");
    try {
      const { url } = await api<{ url: string }>(`/api/workspaces/${workspace.id}/preview`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      if (tab) tab.location.href = url;
      else location.href = url;
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    }
  };

  const cfg = info?.config;
  return (
    <div className="flex h-full min-h-0 flex-col bg-wb-bg">
      <PaneHeader title="Run">
        {app && (
          <span className="flex items-center gap-1.5 text-[12px] text-neutral-400">
            <StatusIndicator state={running ? "running" : app.state === "failed" ? "failed" : "idle"} />
            {running ? "running" : app.exitCode != null ? `exited ${app.exitCode}` : app.state}
          </span>
        )}
        {running ? (
          <Button
            size="xs"
            variant="danger"
            disabled={busy}
            onClick={() => void act(() => sendCommand("app.stop", { processId: app.id }))}
          >
            <Square size={11} fill="currentColor" /> Stop
          </Button>
        ) : (
          <Button
            size="xs"
            variant="primary"
            disabled={busy || !cfg?.runCommand || workspace.state === "archived"}
            onClick={() => void act(() => sendCommand("app.start", { workspaceId: workspace.id }))}
          >
            <Play size={11} fill="currentColor" /> {app ? "Restart" : "Start"}
          </Button>
        )}
      </PaneHeader>
      <div className="shrink-0 space-y-2 border-b border-wb-border px-3 py-2 text-[12.5px]">
        <div className="flex items-start gap-2">
          <span className="w-16 shrink-0 text-neutral-500">Command</span>
          <code className="min-w-0 flex-1 break-all font-mono text-neutral-200">
            {cfg?.runCommand ?? "not configured"}
          </code>
          <button type="button" className="shrink-0 text-wb-accent underline" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
        {cfg && (
          <div className="flex items-start gap-2">
            <span className="w-16 shrink-0 text-neutral-500">Ports</span>
            <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-neutral-300">
              {cfg.ports.map((p) => (
                <span key={p.name}>
                  {p.name}={p.port ?? "—"}
                </span>
              ))}
            </span>
          </div>
        )}
        {cfg?.source && (
          <p className="text-[11px] text-neutral-600">From {cfg.source}; project settings override it.</p>
        )}
        {cfg?.error && <p className="text-red-300">{cfg.error}</p>}
        {running && cfg && cfg.previews.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {cfg.previews.map((p) => (
              <Button key={p.name} size="xs" onClick={() => void openPreview(p.name)}>
                <ExternalLink size={12} /> Open {p.name} preview
              </Button>
            ))}
          </div>
        )}
        {running && info?.previewHost === "127.0.0.1" && (
          <p className="text-[11px] text-amber-300">
            Previews listen on 127.0.0.1 only; connect Tailscale to open them from other devices.
          </p>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
      {app ? (
        <>
          <div className="flex shrink-0 gap-1 border-b border-wb-border px-2 py-1" role="tablist">
            {(["log", "terminal"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`h-7 rounded px-2.5 text-[12px] ${view === v ? "bg-neutral-800 text-neutral-100" : "text-neutral-400"}`}
              >
                {v === "log" ? (
                  "Log"
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <TerminalSquare size={12} /> Terminal
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {view === "log" ? (
              <LogView runId={app.id} live={running} />
            ) : (
              <Suspense fallback={null}>
                <Terminal key={app.id} processId={app.id} />
              </Suspense>
            )}
          </div>
        </>
      ) : (
        <p className="p-4 text-[13px] text-neutral-500">
          The app runs independently of agent turns and keeps running after you close the browser.
        </p>
      )}
      {editing && project && (
        <RunSettingsDialog
          projectId={project.id}
          initialRun={project.runCommand ?? ""}
          initialSetup={project.setupCommand ?? ""}
          onClose={() => {
            setEditing(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// Terminal escape sequences (colors, cursor moves) are not meaningful in the plain log view.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Tail of a run's output log, polled while live and capped at 64 KiB in view. */
export function LogView({ runId, live }: { runId: string; live: boolean }) {
  const [text, setText] = useState("");
  const offset = useRef<number | null>(null);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    offset.current = null;
    setText("");
    let stop = false;
    const tick = async () => {
      const q = offset.current == null ? "" : `?offset=${offset.current}`;
      const r = await api<{ text: string; offset: number }>(`/api/runs/${runId}/log${q}`).catch(() => null);
      if (stop || !r) return;
      offset.current = r.offset;
      if (r.text) {
        const el = box.current;
        const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        setText((t) => (t + r.text).slice(-64 * 1024));
        if (atBottom && el) {
          requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight;
          });
        }
      }
    };
    void tick();
    const t = live ? setInterval(tick, 1500) : undefined;
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [runId, live]);
  return (
    <pre
      ref={box}
      className="h-full overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[12px] leading-[1.5] text-neutral-300"
    >
      {stripAnsi(text) || "(no output yet)"}
    </pre>
  );
}

function RunSettingsDialog({
  projectId,
  initialRun,
  initialSetup,
  onClose,
}: {
  projectId: string;
  initialRun: string;
  initialSetup: string;
  onClose: () => void;
}) {
  const [run, setRun] = useState(initialRun);
  const [setup, setSetup] = useState(initialSetup);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Project commands" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          sendCommand("project.update", {
            projectId,
            runCommand: run.trim() || null,
            setupCommand: setup.trim() || null,
          })
            .then(onClose)
            .catch((err) => setError((err as Error).message));
        }}
      >
        <Field
          label="Dev command"
          hint="Leave empty to use dev.command from workbench.json. $PORT is this workspace's first reserved port."
        >
          <input
            className={`${inputClass} font-mono`}
            value={run}
            onChange={(e) => setRun(e.target.value)}
            placeholder="npm run dev -- --port $PORT"
          />
        </Field>
        <Field label="Setup command" hint="Runs when a workspace is created or retried.">
          <input
            className={`${inputClass} font-mono`}
            value={setup}
            onChange={(e) => setSetup(e.target.value)}
            placeholder="npm ci"
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
