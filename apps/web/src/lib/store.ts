// Client state: a snapshot from the API plus ordered events from one
// EventSource. Every event carries a durable sequence number; the store
// applies each at most once, so reconnects and duplicate deliveries are safe.
import type {
  AppEvent,
  Artifact,
  Conversation,
  ConversationItem,
  Job,
  PendingInput,
  ProcessSession,
  Project,
  Run,
  WorkerStatus,
  Workspace,
} from "@workbench/contracts";
import { useSyncExternalStore } from "react";
import { api, setUnauthorizedHandler } from "./api.ts";

export type WorkerInfo = WorkerStatus & { connected: boolean; stale: boolean };

export type ConversationView = {
  id: string;
  loading: boolean;
  /** Snapshot cursor: detail events at or below it are already reflected. */
  baseSeq: number;
  items: Record<string, ConversationItem>;
  runs: Record<string, Run>;
  inputs: Record<string, PendingInput>;
  hasMore: boolean;
  error: string | null;
};

export type State = {
  auth: "unknown" | "signedOut" | "signedIn";
  loaded: boolean;
  connection: "connecting" | "live" | "offline";
  lastSeq: number;
  projects: Record<string, Project>;
  workspaces: Record<string, Workspace>;
  conversations: Record<string, Conversation>;
  runs: Record<string, Run>;
  inputs: Record<string, PendingInput>;
  processes: Record<string, ProcessSession>;
  jobs: Record<string, Job>;
  artifacts: Record<string, Artifact>;
  worker: WorkerInfo | null;
  conversation: ConversationView | null;
  /** Bumped when job runs change, so the Jobs view can refetch. */
  jobsVersion: number;
};

const initial: State = {
  auth: "unknown",
  loaded: false,
  connection: "connecting",
  lastSeq: 0,
  projects: {},
  workspaces: {},
  conversations: {},
  runs: {},
  inputs: {},
  processes: {},
  jobs: {},
  artifacts: {},
  worker: null,
  conversation: null,
  jobsVersion: 0,
};

let state: State = initial;
const listeners = new Set<() => void>();
const set = (patch: Partial<State> | ((s: State) => Partial<State>)) => {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const l of listeners) l();
};
export const getState = () => state;

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
  );
}

const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

type StateResponse = {
  cursor: number;
  projects: Project[];
  workspaces: Workspace[];
  conversations: Conversation[];
  activeRuns: Run[];
  openInputs: PendingInput[];
  processes?: ProcessSession[];
  jobs?: Job[];
  worker: WorkerInfo | null;
};

type Snapshot = {
  cursor: number;
  conversation: Conversation;
  items: ConversationItem[];
  hasMore: boolean;
  runs: Run[];
  inputs: PendingInput[];
};

// ------------------------------------------------------------------ bootstrap

setUnauthorizedHandler(() => {
  if (state.auth !== "signedOut") {
    source?.close();
    source = null;
    set({ ...initial, auth: "signedOut" });
  }
});

export async function boot() {
  try {
    await api("/api/auth/session");
  } catch {
    set({ auth: "signedOut" });
    return;
  }
  set({ auth: "signedIn" });
  await loadState();
}

async function loadState() {
  const s = await api<StateResponse>("/api/state");
  set({
    loaded: true,
    lastSeq: s.cursor,
    projects: byId(s.projects),
    workspaces: byId(s.workspaces),
    conversations: byId(s.conversations),
    runs: byId(s.activeRuns),
    inputs: byId(s.openInputs),
    processes: byId(s.processes ?? []),
    jobs: byId(s.jobs ?? []),
    worker: s.worker,
  });
  connect();
  if (state.conversation) void openConversation(state.conversation.id, true);
}

export async function login(password: string) {
  await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
  set({ auth: "signedIn" });
  await loadState();
}

export async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  source?.close();
  source = null;
  set({ ...initial, auth: "signedOut" });
}

// ------------------------------------------------------------------ events

let source: EventSource | null = null;
let buffered: AppEvent[] = [];

function connect() {
  source?.close();
  const conv = state.conversation?.id ?? "";
  const es = new EventSource(`/api/events?after=${state.lastSeq}&conversation=${encodeURIComponent(conv)}`);
  source = es;
  set({ connection: "connecting" });
  es.addEventListener("ready", () => set({ connection: "live" }));
  es.addEventListener("heartbeat", (m) => {
    const { heartbeatAt } = JSON.parse((m as MessageEvent).data) as { heartbeatAt: string | null };
    set((s) => ({
      connection: "live",
      worker: s.worker && heartbeatAt ? { ...s.worker, heartbeatAt, stale: false } : s.worker,
    }));
  });
  es.addEventListener("event", (m) => apply(JSON.parse((m as MessageEvent).data) as AppEvent));
  es.addEventListener("reset", () => {
    es.close();
    void loadState();
  });
  es.onerror = () => {
    if (source !== es) return;
    set({ connection: "offline" });
    // EventSource retries by itself with Last-Event-ID; also detect expired sessions.
    void api("/api/auth/session").catch(() => {});
  };
}

function apply(e: AppEvent) {
  if (e.seq <= state.lastSeq && !isDetail(e)) return;
  const conv = state.conversation;
  if (isDetail(e)) {
    if (!conv || e.conversationId !== conv.id) return;
    if (conv.loading) {
      buffered.push(e);
      return;
    }
    if (e.seq <= conv.baseSeq) return;
  }
  set((s) => ({ ...reduce(s, e), lastSeq: Math.max(s.lastSeq, e.seq), connection: "live" }));
}

const isDetail = (e: AppEvent) => e.type === "item.upserted" || e.type === "item.delta";

function reduce(s: State, e: AppEvent): Partial<State> {
  const conv = s.conversation;
  const inConv = conv && e.conversationId === conv.id && e.seq > conv.baseSeq;
  switch (e.type) {
    case "project.upserted":
      return { projects: { ...s.projects, [e.project.id]: e.project } };
    case "workspace.upserted":
      return { workspaces: { ...s.workspaces, [e.workspace.id]: e.workspace } };
    case "conversation.upserted":
      return { conversations: { ...s.conversations, [e.conversation.id]: e.conversation } };
    case "run.upserted":
      return {
        runs: { ...s.runs, [e.run.id]: e.run },
        conversation: inConv ? { ...conv, runs: { ...conv.runs, [e.run.id]: e.run } } : conv,
        jobsVersion: e.run.kind === "job" ? s.jobsVersion + 1 : s.jobsVersion,
      };
    case "input.upserted":
      return {
        inputs: { ...s.inputs, [e.input.id]: e.input },
        conversation: inConv ? { ...conv, inputs: { ...conv.inputs, [e.input.id]: e.input } } : conv,
      };
    case "process.upserted":
      return { processes: { ...s.processes, [e.process.id]: e.process } };
    case "job.upserted":
      return { jobs: { ...s.jobs, [e.job.id]: e.job }, jobsVersion: s.jobsVersion + 1 };
    case "job.deleted": {
      const jobs = { ...s.jobs };
      delete jobs[e.jobId];
      return { jobs, jobsVersion: s.jobsVersion + 1 };
    }
    case "artifact.upserted":
      return { artifacts: { ...s.artifacts, [e.artifact.id]: e.artifact }, jobsVersion: s.jobsVersion + 1 };
    case "worker.status":
      return { worker: { ...e.status, connected: true, stale: false } };
    case "command.upserted":
      return {};
    case "item.upserted":
      return conv ? { conversation: { ...conv, items: { ...conv.items, [e.item.id]: e.item } } } : {};
    case "item.delta": {
      const item = conv?.items[e.itemId];
      if (!conv || !item) return {};
      const data = { ...item.data, [e.field]: String(item.data[e.field] ?? "") + e.delta };
      return { conversation: { ...conv, items: { ...conv.items, [item.id]: { ...item, data } } } };
    }
  }
}

// ------------------------------------------------------------------ conversations

/**
 * Switch the detail subscription to a conversation: reconnect the stream
 * first (buffering detail events), then load the snapshot and apply only
 * buffered events newer than its cursor. Nothing is lost between the two.
 */
export async function openConversation(id: string | null, force = false) {
  if (!force && state.conversation?.id === id) return;
  buffered = [];
  set({
    conversation: id
      ? { id, loading: true, baseSeq: 0, items: {}, runs: {}, inputs: {}, hasMore: false, error: null }
      : null,
  });
  if (state.auth !== "signedIn") return;
  connect();
  if (!id) return;
  try {
    const snap = await api<Snapshot>(`/api/conversations/${id}/snapshot`);
    if (state.conversation?.id !== id) return;
    set({
      conversation: {
        id,
        loading: false,
        baseSeq: snap.cursor,
        items: byId(snap.items),
        runs: byId(snap.runs),
        inputs: byId(snap.inputs),
        hasMore: snap.hasMore,
        error: null,
      },
      conversations: { ...state.conversations, [id]: snap.conversation },
    });
    const pending = buffered;
    buffered = [];
    for (const e of pending) apply(e);
  } catch (e) {
    if (state.conversation?.id === id) {
      set({ conversation: { ...state.conversation, loading: false, error: (e as Error).message } });
    }
  }
}

export async function loadOlder() {
  const conv = state.conversation;
  if (!conv?.hasMore) return;
  const oldest = Math.min(...Object.values(conv.items).map((i) => i.position));
  const page = await api<Snapshot>(`/api/conversations/${conv.id}/snapshot?before=${oldest}&limit=80`);
  const cur = state.conversation;
  if (cur?.id !== conv.id) return;
  set({ conversation: { ...cur, items: { ...byId(page.items), ...cur.items }, hasMore: page.hasMore } });
}

export function sortedItems(conv: ConversationView): ConversationItem[] {
  return Object.values(conv.items).sort((a, b) => a.position - b.position);
}
