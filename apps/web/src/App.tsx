import clsx from "clsx";
import { AlertTriangle, Menu, WifiOff } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Sidebar, useWorkspaceActivity } from "./components/Sidebar.tsx";
import { Button, inputClass } from "./components/ui.tsx";
import { WorkspaceView } from "./components/WorkspaceView.tsx";
import { useUnreadCount } from "./lib/hooks.ts";
import { navigate, useRoute } from "./lib/router.ts";
import { boot, login, openConversation, useStore } from "./lib/store.ts";

const JobsView = lazy(() => import("./components/JobsView.tsx").then((m) => ({ default: m.JobsView })));

export function App() {
  const auth = useStore((s) => s.auth);
  useEffect(() => {
    void boot();
  }, []);
  if (auth === "unknown") return null;
  if (auth === "signedOut") return <Login />;
  return <Shell />;
}

function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="flex h-full items-center justify-center p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-lg border border-wb-border bg-wb-panel p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await login(password);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1 className="text-lg font-semibold text-neutral-100">Workbench</h1>
        <label className="block space-y-1.5">
          <span className="text-[12px] text-neutral-400">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="text-[13px] text-red-300">{error}</p>}
        <Button type="submit" variant="primary" size="md" className="w-full" disabled={busy || !password}>
          Sign in
        </Button>
      </form>
    </main>
  );
}

function Shell() {
  const route = useRoute();
  const loaded = useStore((s) => s.loaded);
  const workspaces = useStore((s) => s.workspaces);
  const projects = useStore((s) => s.projects);
  const [drawer, setDrawer] = useState(false);
  const workspace = route.name === "workspace" ? workspaces[route.workspaceId] : undefined;

  useEffect(() => {
    if (route.name !== "workspace") void openConversation(null);
  }, [route.name]);

  const title = route.name === "workspace" && workspace ? workspace.name : route.name === "jobs" ? "Jobs" : "Workbench";
  const subtitle = route.name === "workspace" && workspace ? projects[workspace.projectId]?.name : null;

  return (
    <div className="flex h-dvh min-h-0 flex-col md:flex-row">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-wb-border md:block">
        <Sidebar route={route} />
      </aside>
      {/* Mobile header and drawer */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-wb-border bg-wb-panel px-1.5 pt-safe md:hidden">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => setDrawer(true)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-neutral-300"
        >
          <Menu size={20} />
          <AttentionDot />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-neutral-100">{title}</div>
          {subtitle && <div className="truncate text-[11px] text-neutral-500">{subtitle}</div>}
        </div>
      </header>
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawer(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[85%] max-w-80 border-r border-wb-border pt-safe shadow-2xl">
            <Sidebar route={route} onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <StatusBanner />
        <div className="min-h-0 flex-1">
          {!loaded ? null : route.name === "workspace" ? (
            workspace ? (
              <WorkspaceView
                key={workspace.id}
                workspace={workspace}
                conversationId={route.conversationId}
                pane={route.pane}
              />
            ) : (
              <NotFound />
            )
          ) : route.name === "jobs" ? (
            <Suspense fallback={null}>
              <JobsView runId={route.runId} />
            </Suspense>
          ) : (
            <Home />
          )}
        </div>
      </main>
    </div>
  );
}

/** Amber dot on the menu button when any workspace waits for input. */
function AttentionDot() {
  const activity = useWorkspaceActivity();
  const unread = useUnreadCount();
  const waiting = unread > 0 || Object.values(activity).some((a) => a.waiting > 0);
  return waiting ? <span className="absolute ml-5 -mt-5 h-2 w-2 rounded-full bg-amber-400" /> : null;
}

function StatusBanner() {
  const connection = useStore((s) => s.connection);
  const worker = useStore((s) => s.worker);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  // Heartbeats arrive with status events only on change; staleness is judged from the last known heartbeat.
  const workerDown = !worker || worker.stale || now - Date.parse(worker.heartbeatAt) > 60_000;
  let message: string | null = null;
  if (connection === "offline") message = "Reconnecting to Workbench… Agent work continues on the server.";
  else if (workerDown) message = "The worker is not responding. Commands will wait until it is back.";
  else if (worker?.codex.state === "unavailable") message = `Codex is unavailable: ${worker.codex.error}`;
  else if (worker?.health?.warnings.length) message = worker.health.warnings.join(" ");
  if (!message) return null;
  return (
    <div
      role="status"
      className={clsx(
        "flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[12.5px]",
        connection === "offline"
          ? "border-sky-900/50 bg-sky-950/40 text-sky-200"
          : "border-amber-900/50 bg-amber-950/30 text-amber-200",
      )}
    >
      {connection === "offline" ? <WifiOff size={13} /> : <AlertTriangle size={13} />} {message}
    </div>
  );
}

function NotFound() {
  return (
    <div className="p-6 text-[13px] text-neutral-400">
      Workspace not found.{" "}
      <button type="button" className="text-wb-accent underline" onClick={() => navigate("/")}>
        Go home
      </button>
    </div>
  );
}

function Home() {
  const workspaces = useStore((s) => s.workspaces);
  const projects = useStore((s) => s.projects);
  const activity = useWorkspaceActivity();
  const active = Object.values(workspaces)
    .filter((w) => w.state !== "archived")
    .sort((a, b) => (activity[b.id] ? 1 : 0) - (activity[a.id] ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12);
  return (
    <div className="h-full overflow-y-auto p-4 md:p-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-4 text-lg font-semibold text-neutral-100">Workspaces</h1>
        {Object.keys(projects).length === 0 && (
          <p className="text-[14px] text-neutral-400">Register a project from the navigation to begin.</p>
        )}
        <ul className="space-y-2">
          {active.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                onClick={() =>
                  navigate({ name: "workspace", workspaceId: w.id, conversationId: null, pane: "conversation" })
                }
                className="flex w-full items-center gap-3 rounded-lg border border-wb-border bg-wb-panel px-4 py-3 text-left hover:border-neutral-700"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-neutral-100">{w.name}</span>
                  <span className="block truncate font-mono text-[12px] text-neutral-500">
                    {projects[w.projectId]?.name} · {w.branch}
                  </span>
                </span>
                {activity[w.id] && (
                  <span className="text-[12px] text-neutral-400">
                    {activity[w.id]!.state === "waiting_for_input"
                      ? "Needs input"
                      : activity[w.id]!.state.replace(/_/g, " ")}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
