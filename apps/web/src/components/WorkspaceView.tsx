// Workspace screen, adapted from Canopy's WorkspaceView: conversation in the
// main area and a collapsible side panel (Changes, Run, Shell) on desktop;
// one full-screen pane at a time with a bottom tab bar on phones.
import type { Conversation, Workspace } from "@workbench/contracts";
import clsx from "clsx";
import { Archive, ArchiveRestore, Code2, PanelRightClose, PanelRightOpen, Pencil, Plus, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api, sendCommand } from "../lib/api.ts";
import { useIsDesktop } from "../lib/media.ts";
import { navigate, type Pane } from "../lib/router.ts";
import { openConversation, useStore } from "../lib/store.ts";
import { ChangesPanel } from "./ChangesPanel.tsx";
import { ConversationView } from "./ConversationView.tsx";
import { RunPanel } from "./RunPanel.tsx";
import { ShellPanel } from "./ShellPanel.tsx";
import { Button, Dialog, ErrorText, Field, IconButton, inputClass, StatusIndicator } from "./ui.tsx";

const SIDE_PANES: { id: Exclude<Pane, "conversation">; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "run", label: "Run" },
  { id: "shell", label: "Shell" },
];

export function WorkspaceView({
  workspace,
  conversationId,
  pane,
}: {
  workspace: Workspace;
  conversationId: string | null;
  pane: Pane;
}) {
  const allConversations = useStore((s) => s.conversations);
  const runs = useStore((s) => s.runs);
  const conversations = useMemo(
    () =>
      (Object.values(allConversations) as Conversation[])
        .filter((c) => c.workspaceId === workspace.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [allConversations, workspace.id],
  );
  const [sideOpen, setSideOpen] = useState(() => localStorage.getItem("wb:side-open") !== "0");
  const [sideTab, setSideTab] = useState<Exclude<Pane, "conversation">>(
    () => (localStorage.getItem("wb:side-tab") as Exclude<Pane, "conversation">) || "changes",
  );
  const [newConv, setNewConv] = useState(false);
  const desktop = useIsDesktop();

  // Default to the most recently active conversation.
  useEffect(() => {
    if (conversationId || conversations.length === 0) return;
    const latest = [...conversations].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0]!;
    navigate({ name: "workspace", workspaceId: workspace.id, conversationId: latest.id, pane }, true);
  }, [conversationId, conversations, workspace.id, pane]);

  useEffect(() => {
    void openConversation(conversationId);
  }, [conversationId]);

  useEffect(() => {
    if (pane !== "conversation") setSideTab(pane);
  }, [pane]);

  const go = (p: Pane, c: string | null = conversationId) =>
    navigate({ name: "workspace", workspaceId: workspace.id, conversationId: c, pane: p });

  const toggleSide = () => {
    localStorage.setItem("wb:side-open", sideOpen ? "0" : "1");
    setSideOpen(!sideOpen);
  };
  const selectSide = (t: Exclude<Pane, "conversation">) => {
    localStorage.setItem("wb:side-tab", t);
    setSideTab(t);
    setSideOpen(true);
    go(t);
  };

  const sidePanel = (id: Exclude<Pane, "conversation">) =>
    id === "changes" ? (
      <ChangesPanel workspace={workspace} />
    ) : id === "run" ? (
      <RunPanel workspace={workspace} />
    ) : (
      <ShellPanel workspace={workspace} />
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader workspace={workspace} sideOpen={sideOpen} onToggleSide={toggleSide} />
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Conversation"
          className={clsx("min-h-0 min-w-0 flex-1 flex-col", pane === "conversation" ? "flex" : "hidden md:flex")}
        >
          <div
            className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-wb-border bg-wb-panel px-2"
            role="tablist"
          >
            {conversations.map((c) => {
              const active = Object.values(runs).find(
                (r) =>
                  r.conversationId === c.id && !["succeeded", "failed", "cancelled", "interrupted"].includes(r.state),
              );
              return (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={c.id === conversationId}
                  onClick={() => go("conversation", c.id)}
                  className={clsx(
                    "flex h-8 max-w-52 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px]",
                    c.id === conversationId
                      ? "bg-neutral-800 text-neutral-100"
                      : "text-neutral-400 hover:bg-neutral-900",
                  )}
                >
                  {active && <StatusIndicator state={active.state} />}
                  <span className="truncate">{c.title}</span>
                </button>
              );
            })}
            <IconButton label="New conversation" onClick={() => setNewConv(true)}>
              <Plus size={16} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1">
            {conversationId && allConversations[conversationId] ? (
              <ConversationView workspace={workspace} />
            ) : (
              <EmptyConversation workspace={workspace} onNew={() => setNewConv(true)} />
            )}
          </div>
        </section>
        {/* Desktop side panel */}
        {desktop && sideOpen && (
          <aside className="hidden w-[min(44vw,620px)] min-w-[340px] shrink-0 flex-col border-l border-wb-border md:flex">
            <div
              className="flex h-10 shrink-0 items-center gap-1 border-b border-wb-border bg-wb-panel px-2"
              role="tablist"
            >
              {SIDE_PANES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={sideTab === t.id}
                  onClick={() => selectSide(t.id)}
                  className={clsx(
                    "h-8 rounded-md px-3 text-[13px]",
                    sideTab === t.id ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">{sidePanel(sideTab)}</div>
          </aside>
        )}
        {/* Phone: the selected non-conversation pane fills the screen. */}
        {!desktop && pane !== "conversation" && <div className="min-h-0 min-w-0 flex-1">{sidePanel(pane)}</div>}
      </div>
      <MobileNav pane={pane} onPane={(p) => go(p)} />
      {newConv && (
        <NewConversationDialog
          workspace={workspace}
          onClose={() => setNewConv(false)}
          onCreated={(id) => {
            setNewConv(false);
            go("conversation", id);
          }}
        />
      )}
    </div>
  );
}

function MobileNav({ pane, onPane }: { pane: Pane; onPane: (p: Pane) => void }) {
  const tabs: { id: Pane; label: string }[] = [
    { id: "conversation", label: "Conversation" },
    { id: "changes", label: "Changes" },
    { id: "run", label: "Run" },
    { id: "shell", label: "Shell" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Workspace views"
      className="flex shrink-0 border-t border-wb-border-strong bg-wb-panel pb-safe md:hidden"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={pane === t.id}
          onClick={() => onPane(t.id)}
          className={clsx(
            "flex h-12 flex-1 items-center justify-center text-[12.5px] font-medium",
            pane === t.id ? "text-wb-accent" : "text-neutral-500",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function WorkspaceHeader({
  workspace,
  sideOpen,
  onToggleSide,
}: {
  workspace: Workspace;
  sideOpen: boolean;
  onToggleSide: () => void;
}) {
  const project = useStore((s) => s.projects[workspace.projectId]);
  const [dialog, setDialog] = useState<"rename" | "editor" | "log" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const failed = workspace.state === "setup_failed" || workspace.state === "create_failed";
  return (
    <div className="shrink-0 border-b border-wb-border bg-wb-panel">
      <div className="hidden h-11 items-center gap-2 px-3 md:flex">
        <StatusIndicator state={workspace.state === "ready" ? "idle" : workspace.state} />
        <span className="truncate text-[14px] font-semibold text-neutral-100">{workspace.name}</span>
        <span className="truncate font-mono text-[12px] text-neutral-500">
          {project?.name} · {workspace.branch}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <WorkspaceActions workspace={workspace} busy={busy} act={act} setDialog={setDialog} />
          <IconButton label={sideOpen ? "Hide side panel" : "Show side panel"} onClick={onToggleSide}>
            {sideOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </IconButton>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 px-2 py-1 md:hidden">
        <span className="mr-auto truncate font-mono text-[11.5px] text-neutral-500">{workspace.branch}</span>
        <WorkspaceActions workspace={workspace} busy={busy} act={act} setDialog={setDialog} />
      </div>
      {(failed ||
        workspace.state === "setting_up" ||
        workspace.state === "creating" ||
        workspace.state === "archived" ||
        error) && (
        <div
          className={clsx(
            "flex flex-wrap items-center gap-2 border-t px-3 py-2 text-[13px]",
            failed || error ? "border-red-900/50 bg-red-950/30 text-red-200" : "border-wb-border text-neutral-300",
          )}
        >
          <span className="min-w-0 flex-1">
            {error ??
              (workspace.state === "archived"
                ? "This workspace is archived. Its worktree and uncommitted files are kept on disk."
                : workspace.state === "setting_up"
                  ? "Running the project setup command…"
                  : workspace.state === "creating"
                    ? "Creating the worktree…"
                    : workspace.error)}
          </span>
          {(failed || workspace.state === "setting_up") && (
            <Button size="xs" onClick={() => setDialog("log")}>
              Setup log
            </Button>
          )}
          {failed && (
            <Button
              size="xs"
              disabled={busy}
              onClick={() => void act(() => sendCommand("workspace.retry", { workspaceId: workspace.id }))}
            >
              <RotateCcw size={12} /> Retry
            </Button>
          )}
        </div>
      )}
      {dialog === "rename" && <RenameDialog workspace={workspace} onClose={() => setDialog(null)} />}
      {dialog === "editor" && <EditorDialog workspace={workspace} onClose={() => setDialog(null)} />}
      {dialog === "log" && <SetupLogDialog workspace={workspace} onClose={() => setDialog(null)} />}
    </div>
  );
}

function WorkspaceActions({
  workspace,
  busy,
  act,
  setDialog,
}: {
  workspace: Workspace;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  setDialog: (d: "rename" | "editor" | "log") => void;
}) {
  return (
    <>
      <IconButton label="Open in editor" onClick={() => setDialog("editor")}>
        <Code2 size={16} />
      </IconButton>
      <IconButton label="Rename workspace" onClick={() => setDialog("rename")}>
        <Pencil size={15} />
      </IconButton>
      {workspace.state === "archived" ? (
        <IconButton
          label="Restore workspace"
          disabled={busy}
          onClick={() => void act(() => sendCommand("workspace.restore", { workspaceId: workspace.id }))}
        >
          <ArchiveRestore size={16} />
        </IconButton>
      ) : (
        <IconButton
          label="Archive workspace"
          disabled={busy}
          onClick={() => {
            if (confirm(`Archive "${workspace.name}"? Its worktree and uncommitted files stay on disk.`)) {
              void act(() => sendCommand("workspace.archive", { workspaceId: workspace.id }));
            }
          }}
        >
          <Archive size={15} />
        </IconButton>
      )}
    </>
  );
}

function RenameDialog({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const [name, setName] = useState(workspace.name);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Rename workspace" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          sendCommand("workspace.rename", { workspaceId: workspace.id, name: name.trim() })
            .then(onClose)
            .catch((err) => setError((err as Error).message));
        }}
      >
        <Field label="Name" hint="The branch name does not change.">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Rename
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditorDialog({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const [info, setInfo] = useState<{
    path: string;
    sshHost: string | null;
    cursorUrl: string | null;
    vscodeUrl: string | null;
  } | null>(null);
  useEffect(() => {
    void api<typeof info>(`/api/workspaces/${workspace.id}/editor`).then(setInfo);
  }, [workspace.id]);
  const copy = (s: string) => void navigator.clipboard?.writeText(s);
  return (
    <Dialog title="Open in a desktop editor" onClose={onClose}>
      {info && (
        <div className="space-y-4 text-[13px]">
          <Field label="Worktree path">
            <div className="flex gap-2">
              <code className="min-w-0 flex-1 break-all rounded border border-wb-border bg-wb-bg px-2 py-1.5 font-mono text-[12px]">
                {info.path}
              </code>
              <Button size="xs" onClick={() => copy(info.path)}>
                Copy
              </Button>
            </div>
          </Field>
          {info.cursorUrl ? (
            <div className="flex flex-wrap gap-2">
              <a
                className="inline-flex h-9 items-center rounded-md bg-wb-accent px-3 font-medium text-neutral-950"
                href={info.cursorUrl}
              >
                Open in Cursor
              </a>
              <a
                className="inline-flex h-9 items-center rounded-md border border-wb-border px-3 text-neutral-200"
                href={info.vscodeUrl!}
              >
                Open in VS Code
              </a>
            </div>
          ) : (
            <p className="text-neutral-400">
              Set <code className="font-mono">WORKBENCH_SSH_HOST</code> to the SSH host alias your desktop uses for this
              machine to enable one-click links. Until then, use Remote-SSH and open the path above.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function SetupLogDialog({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const runs = useStore((s) => s.runs);
  const [text, setText] = useState<string>("");
  const [runId, setRunId] = useState<string | null>(null);
  useEffect(() => {
    // The latest setup run for this workspace may not be in the active-run map; ask the API.
    const local = Object.values(runs)
      .filter((r) => r.workspaceId === workspace.id && r.kind === "workspace_setup")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (local) setRunId(local.id);
    else void api<{ runId: string | null }>(`/api/workspaces/${workspace.id}/setup-run`).then((r) => setRunId(r.runId));
  }, [runs, workspace.id]);
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const tick = async () => {
      const r = await api<{ text: string }>(`/api/runs/${runId}/log`);
      if (!stop) setText(r.text);
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [runId]);
  return (
    <Dialog title="Setup log" onClose={onClose} wide>
      <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] text-neutral-300">
        {runId ? text || "(no output yet)" : "No setup run recorded."}
      </pre>
    </Dialog>
  );
}

function EmptyConversation({ workspace, onNew }: { workspace: Workspace; onNew: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-neutral-500">
      <p className="text-neutral-300">No conversations in {workspace.name} yet.</p>
      <Button variant="primary" size="md" onClick={onNew} disabled={workspace.state === "archived"}>
        Start a conversation
      </Button>
    </div>
  );
}

function NewConversationDialog({
  workspace,
  onClose,
  onCreated,
}: {
  workspace: Workspace;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const worker = useStore((s) => s.worker);
  const [provider, setProvider] = useState<"codex" | "claude">("codex");
  const [policy, setPolicy] = useState<"never" | "untrusted" | "on-request">("never");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = (await sendCommand("conversation.create", {
        workspaceId: workspace.id,
        provider,
        approvalPolicy: policy,
      })) as { conversationId: string };
      onCreated(r.conversationId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const option = (value: string, title: string, body: ReactNode, disabled = false) => ({
    value,
    title,
    body,
    disabled,
  });
  const providers = [
    option(
      "codex",
      "Codex",
      worker?.codex.state === "unavailable" ? worker.codex.error : `Codex ${worker?.codex.version ?? ""}`,
    ),
    option("claude", "Claude", worker?.claude.reason ?? "Not configured.", true),
  ];
  return (
    <Dialog title="New conversation" onClose={onClose}>
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[12px] font-medium text-neutral-300">Agent</legend>
          {providers.map((p) => (
            <label
              key={p.value}
              className={clsx(
                "flex items-start gap-2 rounded-md border border-wb-border p-2.5",
                p.disabled ? "opacity-50" : "cursor-pointer hover:bg-neutral-900",
              )}
            >
              <input
                type="radio"
                className="mt-1"
                disabled={p.disabled}
                checked={provider === p.value}
                onChange={() => setProvider(p.value as "codex")}
              />
              <span>
                <span className="block text-[14px] text-neutral-100">{p.title}</span>
                <span className="block text-[12px] text-neutral-500">{p.body}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field
          label="Approvals"
          hint="Commands run with full access in the worktree. Choose whether Codex must ask first (see decision 0002)."
        >
          <select className={inputClass} value={policy} onChange={(e) => setPolicy(e.target.value as typeof policy)}>
            <option value="never">Never ask</option>
            <option value="on-request">Ask when Codex decides it is needed</option>
            <option value="untrusted">Ask before any command not known to be safe</option>
          </select>
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            Start
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
