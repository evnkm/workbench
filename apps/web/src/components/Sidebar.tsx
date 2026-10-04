// Project and workspace navigation, recreated from Canopy's HomeSidebar
// hierarchy against Workbench data.
import type { Project, Run, Workspace } from "@workbench/contracts";
import clsx from "clsx";
import { Archive, ChevronRight, Clock, FolderGit2, LogOut, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { sendCommand } from "../lib/api.ts";
import { useUnreadCount } from "../lib/hooks.ts";
import { navigate, type Route } from "../lib/router.ts";
import { logout, useStore } from "../lib/store.ts";
import { Button, Dialog, ErrorText, Field, IconButton, inputClass, StatusIndicator } from "./ui.tsx";

/** The most urgent activity in a workspace, for its row indicator. */
export function useWorkspaceActivity() {
  const runs = useStore((s) => s.runs);
  const inputs = useStore((s) => s.inputs);
  return useMemo(() => {
    const rank: Record<string, number> = { waiting_for_input: 4, running: 3, starting: 3, stopping: 3, queued: 2 };
    const out: Record<string, { state: string; waiting: number }> = {};
    const runWorkspace: Record<string, string> = {};
    for (const r of Object.values(runs) as Run[]) {
      if (!r.workspaceId) continue;
      runWorkspace[r.id] = r.workspaceId;
      const score = rank[r.state];
      if (!score) continue;
      const cur = out[r.workspaceId];
      if (!cur || score > (rank[cur.state] ?? 0)) out[r.workspaceId] = { state: r.state, waiting: cur?.waiting ?? 0 };
    }
    for (const i of Object.values(inputs)) {
      if (i.state !== "open") continue;
      const w = runWorkspace[i.runId];
      if (w) out[w] = { state: "waiting_for_input", waiting: (out[w]?.waiting ?? 0) + 1 };
    }
    return out;
  }, [runs, inputs]);
}

export function Sidebar({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const activity = useWorkspaceActivity();
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: "project" } | { kind: "workspace"; project: Project }>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const unread = useUnreadCount();

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (Object.values(projects) as Project[])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({
        project: p,
        workspaces: (Object.values(workspaces) as Workspace[])
          .filter((w) => w.projectId === p.id && (showArchived || w.state !== "archived"))
          .filter((w) => !q || w.name.toLowerCase().includes(q) || w.branch.toLowerCase().includes(q))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      }))
      .filter((g) => !q || g.workspaces.length || g.project.name.toLowerCase().includes(q));
  }, [projects, workspaces, query, showArchived]);

  const go = (r: Route | string) => {
    navigate(r);
    onNavigate?.();
  };
  const currentWorkspace = route.name === "workspace" ? route.workspaceId : null;

  return (
    <nav aria-label="Projects and workspaces" className="flex h-full min-h-0 flex-col bg-wb-panel">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-wb-border px-3">
        <button
          type="button"
          onClick={() => go("/")}
          className="text-[13px] font-semibold tracking-tight text-neutral-100"
        >
          Workbench
        </button>
        <div className="flex items-center">
          <IconButton
            label={unread ? `Jobs (${unread} unread)` : "Jobs"}
            onClick={() => go({ name: "jobs", runId: null })}
            className="relative"
          >
            <Clock size={16} />
            {unread > 0 && (
              <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-wb-accent px-1 text-[10px] font-bold leading-4 text-neutral-950">
                {unread}
              </span>
            )}
          </IconButton>
          <IconButton label="Register project" onClick={() => setDialog({ kind: "project" })}>
            <Plus size={16} />
          </IconButton>
        </div>
      </div>
      <div className="shrink-0 px-2 pt-2">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workspaces"
            aria-label="Search workspaces"
            className="h-9 w-full rounded-md border border-wb-border bg-wb-bg pl-8 pr-2 text-[14px] text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none md:h-8 md:text-[13px]"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {grouped.length === 0 && (
          <div className="px-3 py-6 text-center text-[13px] text-neutral-500">
            {Object.keys(projects).length === 0 ? (
              <>
                <p className="mb-3">Register a Git repository to start.</p>
                <Button variant="primary" onClick={() => setDialog({ kind: "project" })}>
                  Register project
                </Button>
              </>
            ) : (
              "No matching workspaces."
            )}
          </div>
        )}
        {grouped.map(({ project, workspaces: ws }) => {
          const open = !collapsed[project.id];
          return (
            <div key={project.id} className="mb-1">
              <div className="group flex items-center rounded-md hover:bg-neutral-900/60">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setCollapsed((c) => ({ ...c, [project.id]: open }))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-2 text-left md:py-1.5"
                >
                  <ChevronRight
                    size={13}
                    className={clsx("shrink-0 text-neutral-500 transition-transform", open && "rotate-90")}
                  />
                  <FolderGit2 size={14} className="shrink-0 text-neutral-500" />
                  <span className="truncate text-[13px] font-semibold text-neutral-200">{project.name}</span>
                </button>
                <IconButton
                  label={`New workspace in ${project.name}`}
                  className="md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
                  onClick={() => setDialog({ kind: "workspace", project })}
                >
                  <Plus size={15} />
                </IconButton>
              </div>
              {open && (
                <ul className="ml-3 border-l border-wb-border pl-1.5">
                  {ws.length === 0 && <li className="px-2 py-1.5 text-[12px] text-neutral-600">No workspaces</li>}
                  {ws.map((w) => {
                    const act = activity[w.id];
                    const state = act?.state ?? (w.state === "ready" ? "idle" : w.state);
                    return (
                      <li key={w.id}>
                        <button
                          type="button"
                          aria-current={currentWorkspace === w.id ? "page" : undefined}
                          onClick={() =>
                            go({ name: "workspace", workspaceId: w.id, conversationId: null, pane: "conversation" })
                          }
                          className={clsx(
                            "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left md:py-1.5",
                            currentWorkspace === w.id
                              ? "bg-neutral-800/70 text-neutral-100"
                              : "text-neutral-300 hover:bg-neutral-900",
                          )}
                        >
                          <span className="flex w-3 shrink-0 justify-center">
                            {w.state === "archived" ? (
                              <Archive size={12} className="text-neutral-600" />
                            ) : (
                              <StatusIndicator state={state} />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium">{w.name}</span>
                            <span className="block truncate font-mono text-[11px] text-neutral-500">{w.branch}</span>
                          </span>
                          {act?.waiting ? (
                            <span className="shrink-0 rounded-full bg-amber-400/15 px-1.5 text-[11px] font-semibold text-amber-300">
                              {act.waiting}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-wb-border px-2 py-1.5 pb-safe">
        <label className="flex items-center gap-2 px-1 text-[12px] text-neutral-500">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
        <IconButton label="Sign out" onClick={() => void logout()}>
          <LogOut size={15} />
        </IconButton>
      </div>
      {dialog?.kind === "project" && <RegisterProjectDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "workspace" && (
        <NewWorkspaceDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setDialog(null);
            go({ name: "workspace", workspaceId: id, conversationId: null, pane: "conversation" });
          }}
        />
      )}
    </nav>
  );
}

function RegisterProjectDialog({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [setup, setSetup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendCommand("project.register", {
        path: path.trim(),
        defaultBranch: branch.trim() || undefined,
        setupCommand: setup.trim() || null,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Register project" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Repository path on the server" hint="An existing Git checkout, for example /home/ubuntu/canopy.">
          <input className={inputClass} value={path} onChange={(e) => setPath(e.target.value)} required autoFocus />
        </Field>
        <Field
          label="Default base branch (optional)"
          hint="Discovered from origin/HEAD, main, or master when left empty."
        >
          <input className={inputClass} value={branch} onChange={(e) => setBranch(e.target.value)} />
        </Field>
        <Field label="Setup command (optional)" hint="Runs in each new workspace, for example npm ci.">
          <input className={`${inputClass} font-mono`} value={setup} onChange={(e) => setSetup(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !path.trim()}>
            {busy ? "Registering…" : "Register"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function NewWorkspaceDialog({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState(project.defaultBranch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = (await sendCommand("workspace.create", {
        projectId: project.id,
        name: name.trim(),
        branch: branch.trim() || undefined,
        baseRef: base.trim() || undefined,
      })) as { workspaceId: string };
      onCreated(r.workspaceId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`New workspace in ${project.name}`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Branch" hint="A new branch is created for the workspace.">
          <input
            className={`${inputClass} font-mono`}
            value={branch}
            placeholder={slug(name) || "feature-name"}
            onChange={(e) => setBranch(e.target.value)}
          />
        </Field>
        <Field label="Based on">
          <input className={`${inputClass} font-mono`} value={base} onChange={(e) => setBase(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create workspace"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
