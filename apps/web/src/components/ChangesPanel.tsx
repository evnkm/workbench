// Authoritative Git changes for a workspace: status list plus lazily loaded,
// bounded per-file diffs. Side-by-side on wide screens, stacked on phones.
import type { FileDiff, FileStatus, GitStatus, Workspace } from "@workbench/contracts";
import clsx from "clsx";
import { ChevronRight, Columns2, RefreshCw, Rows2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useStore } from "../lib/store.ts";
import { DiffText } from "./DiffText.tsx";
import { IconButton, PaneHeader } from "./ui.tsx";

const wide = () => window.matchMedia("(min-width: 1280px)").matches;

export function ChangesPanel({ workspace }: { workspace: Workspace }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [split, setSplit] = useState(() => localStorage.getItem("wb:diff-split") === "1" && wide());
  // Refresh when any run in this workspace changes state (agent edits, shells finish).
  const runsVersion = useStore((s) =>
    Object.values(s.runs)
      .filter((r) => r.workspaceId === workspace.id)
      .map((r) => `${r.id}:${r.state}`)
      .join(","),
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api<GitStatus>(`/api/workspaces/${workspace.id}/changes`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspace.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on run state changes.
  useEffect(() => {
    void refresh();
  }, [refresh, runsVersion]);
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const files = status?.files ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col bg-wb-bg">
      <PaneHeader title={`Changes${files.length ? ` · ${files.length}` : ""}`}>
        {wide() && (
          <IconButton
            label={split ? "Stacked diff" : "Side-by-side diff"}
            onClick={() => {
              localStorage.setItem("wb:diff-split", split ? "0" : "1");
              setSplit(!split);
            }}
          >
            {split ? <Rows2 size={15} /> : <Columns2 size={15} />}
          </IconButton>
        )}
        <IconButton label="Refresh changes" onClick={() => void refresh()}>
          <RefreshCw size={15} className={clsx(loading && "animate-spin")} />
        </IconButton>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {status && (
          <div className="border-b border-wb-border px-3 py-2 font-mono text-[11.5px] text-neutral-500">
            {status.branch ?? "detached HEAD"}
            {status.branch !== workspace.branch && (
              <span className="ml-2 text-amber-300">(expected {workspace.branch})</span>
            )}
            {status.upstream && ` · ${status.upstream} +${status.ahead} -${status.behind}`}
          </div>
        )}
        {error && <p className="p-3 text-[13px] text-red-300">{error}</p>}
        {status && files.length === 0 && <p className="p-4 text-[13px] text-neutral-500">No uncommitted changes.</p>}
        <ul>
          {files.map((f) => (
            <FileRow key={f.path} workspaceId={workspace.id} file={f} version={status!.version} split={split} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function label(f: FileStatus) {
  if (f.untracked) return { text: "new", cls: "text-emerald-400" };
  const c = f.staged !== "." ? f.staged : f.unstaged;
  const map: Record<string, [string, string]> = {
    M: ["mod", "text-amber-300"],
    A: ["add", "text-emerald-400"],
    D: ["del", "text-red-400"],
    R: ["ren", "text-sky-300"],
    U: ["conflict", "text-red-400"],
  };
  const [text, cls] = map[c] ?? [c, "text-neutral-400"];
  return { text, cls };
}

function FileRow({
  workspaceId,
  file,
  version,
  split,
}: {
  workspaceId: string;
  file: FileStatus;
  version: string;
  split: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<(FileDiff & { version: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const l = label(file);

  useEffect(() => {
    if (!open || diff?.version === version) return;
    const q = new URLSearchParams({ path: file.path, ...(file.untracked ? { untracked: "1" } : {}) });
    api<FileDiff>(`/api/workspaces/${workspaceId}/diff?${q}`)
      .then((d) => setDiff({ ...d, version }))
      .catch((e) => setError((e as Error).message));
  }, [open, version, workspaceId, file.path, file.untracked, diff?.version]);

  return (
    <li className="border-b border-wb-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-900/50"
      >
        <ChevronRight
          size={13}
          className={clsx("shrink-0 text-neutral-500 transition-transform", open && "rotate-90")}
        />
        <span className={clsx("w-14 shrink-0 font-mono text-[11px] uppercase", l.cls)}>{l.text}</span>
        <span className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-neutral-200" title={file.path}>
          {file.origPath ? `${file.origPath} → ` : ""}
          {file.path}
        </span>
        {file.binary ? (
          <span className="text-[11px] text-neutral-500">binary</span>
        ) : (
          (file.additions != null || file.deletions != null) && (
            <span className="shrink-0 font-mono text-[11px]">
              <span className="text-emerald-400">+{file.additions ?? 0}</span>{" "}
              <span className="text-red-400">-{file.deletions ?? 0}</span>
            </span>
          )
        )}
      </button>
      {open && (
        <div className="border-t border-wb-border bg-wb-panel">
          {error && <p className="p-3 text-[12px] text-red-300">{error}</p>}
          {!diff && !error && <p className="p-3 text-[12px] text-neutral-500">Loading diff…</p>}
          {diff && diff.version !== version && <p className="px-3 pt-2 text-[11px] text-amber-300">Refreshing…</p>}
          {diff?.binary && <p className="p-3 text-[12px] text-neutral-500">Binary file; no preview.</p>}
          {diff?.truncated && (
            <p className="px-3 pt-2 text-[11px] text-amber-300">
              Showing the first 256 KiB of a {(diff.bytes / 1024).toFixed(0)} KiB diff. Open the workspace in an editor
              for the rest.
            </p>
          )}
          {diff && !diff.binary && <DiffText diff={diff.diff} split={split} />}
        </div>
      )}
    </li>
  );
}
