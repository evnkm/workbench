import {
  type IdentityQuestion,
  type Person,
  type RolodexMessage,
  type RolodexState,
  uuidv7,
} from "@workbench/contracts";
import clsx from "clsx";
import {
  ArrowLeft,
  ChevronRight,
  Crosshair,
  GripHorizontal,
  Loader2,
  Maximize2,
  MessageCircle,
  Minus,
  Network,
  Plus,
  Search,
  Send,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { type GraphActions, personColor, RolodexGraph } from "./RolodexGraph.tsx";
import { Button, ErrorText, IconButton } from "./ui.tsx";

const endpoint = "/api/apps/rolodex";
const APPS = [
  { id: "rolodex", name: "Rolodex", description: "People you know and how they are connected", Icon: Network },
];
export function MiniAppsView({ app }: { app: string | null }) {
  return app === "rolodex" ? (
    <Rolodex />
  ) : (
    <div className="h-full overflow-y-auto p-4 md:p-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-4 text-lg font-semibold text-neutral-100">Mini-apps</h1>
        <ul className="space-y-2">
          {APPS.map(({ id, name, description, Icon }) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => navigate({ name: "apps", app: id })}
                className="flex w-full items-center gap-3 rounded-lg border border-wb-border bg-wb-panel px-4 py-3 text-left hover:border-neutral-700"
              >
                <Icon size={16} className="shrink-0 text-neutral-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-neutral-100">{name}</span>
                  <span className="block truncate text-[12px] text-neutral-500">{description}</span>
                </span>
                <ChevronRight size={16} className="shrink-0 text-neutral-600" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Rolodex() {
  const [state, setState] = useState<RolodexState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showPeople, setShowPeople] = useState(false);
  const actions = useRef<GraphActions | null>(null);
  useEffect(() => {
    let disposed = false;
    const update = (next: RolodexState) => {
      if (disposed) return;
      setState((old) =>
        old && next.revision <= old.revision
          ? old
          : {
              ...next,
              people: JSON.stringify(old?.people) === JSON.stringify(next.people) ? old!.people : next.people,
              connections:
                JSON.stringify(old?.connections) === JSON.stringify(next.connections)
                  ? old!.connections
                  : next.connections,
            },
      );
      setError(null);
    };
    void api<RolodexState>(`${endpoint}/state`)
      .then(update)
      .catch((e: Error) => !disposed && setError(e.message));
    const source = new EventSource(`${endpoint}/events`);
    source.addEventListener("state", (event) => {
      update(JSON.parse((event as MessageEvent).data));
      setConnected(true);
    });
    source.onerror = () => {
      setConnected(false);
    };
    return () => {
      disposed = true;
      source.close();
    };
  }, []);
  const people = state?.people ?? [];
  const connections = state?.connections ?? [];
  const person = people.find((p) => p.id === selected);
  const filtered = people
    .filter((p) =>
      `${p.name} ${p.headline} ${p.tags.join(" ")} ${p.aliases.join(" ")} ${p.details.join(" ")} ${connections
        .filter((c) => c.from === p.id || c.to === p.id)
        .map((c) => `${c.label} ${c.context}`)
        .join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const select = (id: string) => {
    setSelected(id);
    setShowPeople(false);
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-wb-bg">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-wb-border bg-wb-panel px-1.5 md:px-2">
        <IconButton label="All mini-apps" onClick={() => navigate({ name: "apps", app: null })}>
          <ArrowLeft size={16} />
        </IconButton>
        <h1 className="hidden text-[13px] font-semibold text-neutral-100 md:block">Rolodex</h1>
        {state && (
          <span className="text-[12px] tabular-nums text-neutral-500">
            {people.length} {people.length === 1 ? "person" : "people"}, {connections.length}{" "}
            {connections.length === 1 ? "connection" : "connections"}
          </span>
        )}
        {state && !connected && <span className="text-[12px] text-amber-400">Reconnecting…</span>}
        <IconButton
          label={showPeople ? "Show graph" : "Show people"}
          aria-expanded={showPeople}
          onClick={() => setShowPeople(!showPeople)}
          className="ml-auto md:hidden"
        >
          {showPeople ? <X size={16} /> : <Users size={16} />}
        </IconButton>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <section
          aria-label="People"
          className={clsx(
            "min-h-0 flex-col bg-wb-panel md:static md:z-auto md:flex md:w-64 md:shrink-0 md:border-r md:border-wb-border",
            showPeople ? "absolute inset-0 z-30 flex" : "hidden",
          )}
        >
          <div className="shrink-0 p-2">
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600"
              />
              <input
                type="search"
                aria-label="Find a person"
                placeholder="Search people, roles, notes"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-9 w-full rounded-md border border-wb-border bg-wb-bg pl-8 pr-2 text-[16px] text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none md:h-8 md:text-[13px]"
              />
            </div>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {filtered.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-current={p.id === selected ? "true" : undefined}
                  onClick={() => select(p.id)}
                  className={clsx(
                    "flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-2 text-left md:py-1.5",
                    p.id === selected ? "bg-neutral-800/70" : "hover:bg-neutral-900",
                  )}
                >
                  <Avatar person={p} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-neutral-200">{p.name}</span>
                    {(p.headline || p.tags.length > 0) && (
                      <span className="block truncate text-[12px] text-neutral-500">
                        {p.headline || p.tags.join(", ")}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
            {state && !filtered.length && (
              <li className="px-2 py-6 text-center text-[13px] text-neutral-500">
                {people.length ? "No matches." : "No people yet."}
              </li>
            )}
          </ul>
        </section>
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {state && (
            <RolodexGraph
              people={state.people}
              connections={state.connections}
              selected={selected}
              onSelect={select}
              actions={actions}
            />
          )}
          {state && !people.length && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8 pb-32">
              <div className="max-w-xs text-center">
                <p className="text-[14px] font-medium text-neutral-300">No people yet</p>
                <p className="mt-1 text-[13px] leading-relaxed text-neutral-500">
                  Open the chat and describe someone you met and who they know.
                </p>
              </div>
            </div>
          )}
          {error && (
            <div className="absolute inset-x-3 top-3 z-20">
              <ErrorText>
                Couldn’t load the Rolodex: {error}{" "}
                <button type="button" onClick={() => location.reload()} className="underline">
                  Retry
                </button>
              </ErrorText>
            </div>
          )}
          {person && (
            <section
              aria-label={`${person.name} person card`}
              className="absolute inset-x-0 bottom-0 z-40 max-h-[65%] overflow-y-auto overscroll-contain rounded-t-xl border-t border-wb-border-strong bg-wb-panel p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl md:inset-x-auto md:bottom-auto md:right-3 md:top-3 md:max-h-[calc(100%-1.5rem)] md:z-20 md:w-80 md:rounded-lg md:border md:pb-4"
            >
              <div className="flex items-start gap-3">
                <Avatar person={person} large />
                <div className="min-w-0 flex-1 pt-0.5">
                  <h2 className="truncate text-[15px] font-semibold text-neutral-100">{person.name}</h2>
                  {person.headline && <p className="text-[13px] text-neutral-400">{person.headline}</p>}
                </div>
                <IconButton label="Close person card" onClick={() => setSelected(null)} className="-mr-1.5 -mt-1.5">
                  <X size={16} />
                </IconButton>
              </div>
              {person.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {person.tags.map((tag) => (
                    <span key={tag} className="rounded bg-neutral-800/70 px-1.5 py-0.5 text-[11px] text-neutral-400">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <h3 className="mb-1.5 mt-4 text-[12px] font-medium text-neutral-500">Notes</h3>
              {person.details.length ? (
                <ul className="space-y-1.5">
                  {person.details.map((detail) => (
                    <li key={detail} className="text-[13px] leading-relaxed text-neutral-300">
                      {detail}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-neutral-500">None yet.</p>
              )}
              <h3 className="mb-1.5 mt-4 text-[12px] font-medium text-neutral-500">Connections</h3>
              <ul className="-mx-2">
                {connections
                  .filter((c) => c.from === person.id || c.to === person.id)
                  .map((c) => {
                    const other = people.find((p) => p.id === (c.from === person.id ? c.to : c.from));
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => other && select(other.id)}
                          className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-neutral-900"
                        >
                          <span className="text-[13px] font-medium text-neutral-200">{other?.name}</span>
                          <span className="ml-2 text-[12px] text-neutral-500">{c.label}</span>
                          {c.context && (
                            <span className="mt-0.5 block text-[12px] leading-relaxed text-neutral-500">
                              {c.context}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
              </ul>
              <Button variant="bare" size="xs" onClick={() => actions.current?.focus(person.id)} className="-ml-2 mt-2">
                <Crosshair size={13} /> Show in graph
              </Button>
            </section>
          )}
          <div className="absolute bottom-3 right-3 z-10 flex flex-col rounded-lg border border-wb-border bg-wb-panel p-0.5">
            <IconButton label="Zoom in" onClick={() => actions.current?.zoom(0.8)}>
              <Plus size={16} />
            </IconButton>
            <IconButton label="Zoom out" onClick={() => actions.current?.zoom(1.25)}>
              <Minus size={16} />
            </IconButton>
            <IconButton label="Fit everyone" onClick={() => actions.current?.fit()}>
              <Maximize2 size={14} />
            </IconButton>
          </div>
          <RolodexChat messages={state?.messages ?? []} />
        </div>
      </div>
    </div>
  );
}

function Avatar({ person, large = false }: { person: Person; large?: boolean }) {
  return (
    <span
      style={{ backgroundColor: `${personColor(person)}40` }}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-neutral-100",
        large ? "h-10 w-10 text-[14px]" : "h-7 w-7 text-[11px]",
      )}
    >
      {person.name
        .split(/\s+/)
        .slice(0, 2)
        .map((s) => s[0])
        .join("")
        .toUpperCase()}
    </span>
  );
}

function RolodexChat({ messages }: { messages: RolodexMessage[] }) {
  const container = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [bounds, setBounds] = useState({ width: 1000, height: 700 });
  const [open, setOpen] = useState(() => localStorage.getItem("wb:rolodex-chat-open") === "1");
  const [position, setPosition] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem("wb:rolodex-chat-position") ?? "null");
      if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return p as { x: number; y: number };
    } catch {
      /* Use the default position. */
    }
    return { x: 12, y: 99999 };
  });
  const [text, setText] = useState(() => localStorage.getItem("wb:rolodex-draft") ?? "");
  const [provider, setProvider] = useState<"codex" | "claude">(() =>
    localStorage.getItem("wb:rolodex-provider") === "claude" ? "claude" : "codex",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ id: string; text: string; provider: string } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const [dragging, setDragging] = useState(false);
  const width = open ? Math.min(400, bounds.width - 24) : 44;
  const height = open ? Math.min(520, bounds.height - 24) : 44;
  const left = Math.max(12, Math.min(position.x, bounds.width - width - 12));
  const top = Math.max(12, Math.min(position.y, bounds.height - height - 12));
  useEffect(() => {
    const parent = container.current!.parentElement!;
    const observer = new ResizeObserver(() => setBounds({ width: parent.clientWidth, height: parent.clientHeight }));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    localStorage.setItem("wb:rolodex-chat-open", open ? "1" : "0");
    if (open && !matchMedia("(pointer: coarse)").matches) input.current?.focus();
  }, [open]);
  useEffect(() => {
    localStorage.setItem("wb:rolodex-draft", text);
  }, [text]);
  useEffect(() => {
    localStorage.setItem("wb:rolodex-provider", provider);
  }, [provider]);
  useEffect(() => {
    localStorage.setItem("wb:rolodex-chat-position", JSON.stringify({ x: left, y: top }));
  }, [left, top]);
  useEffect(() => {
    if (messages.length || open) end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [messages, open]);
  const pointer = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || (open && (e.target as Element).closest("button, select"))) return;
      moved.current = false;
      drag.current = { x: e.clientX, y: e.clientY, left, top, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) {
        d.moved = true;
        moved.current = true;
        setDragging(true);
      }
      if (d.moved)
        setPosition({
          x: Math.max(12, Math.min(bounds.width - width - 12, d.left + e.clientX - d.x)),
          y: Math.max(12, Math.min(bounds.height - height - 12, d.top + e.clientY - d.y)),
        });
    },
    onPointerUp: () => {
      drag.current = null;
      setDragging(false);
    },
    onPointerCancel: () => {
      moved.current = false;
      drag.current = null;
      setDragging(false);
    },
  };
  const submit = async () => {
    if (!text.trim() || busy) return;
    if (attempt.current?.text !== text.trim() || attempt.current.provider !== provider)
      attempt.current = { id: uuidv7(), text: text.trim(), provider };
    setBusy(true);
    setError(null);
    try {
      await api(`${endpoint}/messages`, { method: "POST", body: JSON.stringify(attempt.current) });
      setText("");
      attempt.current = null;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const waiting = messages.some((m) => m.status === "confirm");
  const working = messages.some((m) => m.status === "queued" || m.status === "running");
  const agent = provider === "codex" ? "Codex" : "Claude Code";
  return (
    <div
      ref={container}
      style={{ left, top, width, height, ["--wb-glass-r" as string]: open ? "16px" : "22px" }}
      className={clsx("wb-glass absolute z-30 overflow-hidden", !dragging && "wb-glass-morph")}
    >
      {!open ? (
        <button
          type="button"
          aria-label="Open Rolodex chat"
          title={waiting ? "Needs your answer" : working ? "Updating" : "Open chat"}
          {...pointer}
          onClick={() => {
            if (!moved.current) setOpen(true);
            moved.current = false;
          }}
          className="wb-glass-content flex h-full w-full touch-none select-none items-center justify-center rounded-[inherit] text-neutral-300 transition hover:text-neutral-100 active:scale-95"
        >
          {working ? <Loader2 size={18} className="animate-spin" /> : <MessageCircle size={18} />}
          {waiting && <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-amber-400" />}
        </button>
      ) : (
        <div className="wb-glass-content flex h-full min-h-0 flex-col">
          <div
            {...pointer}
            className="flex h-11 shrink-0 cursor-grab touch-none select-none items-center gap-2 border-b border-wb-border pl-3.5 pr-1.5 active:cursor-grabbing"
          >
            <span className="text-[13px] font-medium text-neutral-100">Chat</span>
            <select
              aria-label="Rolodex AI provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as "codex" | "claude")}
              className="h-7 rounded-md border border-wb-border bg-transparent px-1.5 text-[12px] text-neutral-400 hover:text-neutral-200 focus:outline-none"
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
            <GripHorizontal size={14} className="ml-auto text-neutral-600" />
            <IconButton label="Collapse Rolodex chat" onClick={() => setOpen(false)}>
              <Minus size={16} />
            </IconButton>
          </div>
          <div
            role="log"
            aria-label="Rolodex conversation"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3.5"
          >
            {!messages.length && (
              <p className="text-[13px] leading-relaxed text-neutral-400">
                Describe who you met and who they know. If a name matches someone already here, you’ll be asked to
                confirm before anything is saved.
              </p>
            )}
            {messages.map((message) => (
              <div key={message.id} className="space-y-2">
                <div className="ml-8 whitespace-pre-wrap rounded-lg bg-neutral-800/70 px-3 py-2 text-[13px] leading-relaxed text-neutral-100">
                  {message.text}
                </div>
                {(message.status === "running" || message.status === "queued") && (
                  <p role="status" className="flex items-center gap-2 text-[12px] text-neutral-500">
                    <Loader2 size={13} className="animate-spin" />
                    {message.status === "running"
                      ? `${message.provider === "codex" ? "Codex" : "Claude Code"} is reading the note`
                      : "Queued"}
                  </p>
                )}
                {message.status === "confirm" && <IdentityConfirmation message={message} />}
                {message.reply && message.status === "done" && (
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-300">{message.reply}</p>
                )}
                {message.status === "failed" && (
                  <div role="alert" className="text-[13px] leading-relaxed text-red-400">
                    {message.error}
                    <button
                      type="button"
                      onClick={() => setText(message.text)}
                      className="mt-1 block text-[12px] text-neutral-400 underline hover:text-neutral-200"
                    >
                      Edit and retry
                    </button>
                  </div>
                )}
                {message.status === "cancelled" && (
                  <p className="text-[12px] text-neutral-500">Cancelled. Nothing was changed.</p>
                )}
              </div>
            ))}
            <div ref={end} />
          </div>
          <form
            className="shrink-0 border-t border-wb-border p-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {error && <p className="mb-2 text-[12px] text-red-400">{error}</p>}
            <div className="flex items-end gap-2 rounded-lg border border-wb-border bg-wb-bg p-1.5 focus-within:border-neutral-600">
              <textarea
                ref={input}
                aria-label="Tell Rolodex about someone"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Met Bob at a climate meetup. He’s a designer and knows Alice…"
                rows={2}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    !matchMedia("(pointer: coarse)").matches
                  ) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                className="max-h-28 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-[16px] leading-relaxed text-neutral-100 outline-none placeholder:text-neutral-600 md:text-[13px]"
              />
              <button
                type="submit"
                aria-label="Send Rolodex note"
                title={`Send to ${agent}`}
                disabled={busy || !text.trim()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-950 transition hover:opacity-90 active:scale-95 disabled:opacity-25"
              >
                <Send size={14} />
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function IdentityConfirmation({ message }: { message: RolodexMessage }) {
  const [choices, setChoices] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (cancel = false) => {
    setBusy(true);
    setError(null);
    try {
      await api(`${endpoint}/messages/${message.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ choices, cancel }),
      });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const option = (chosen: boolean) =>
    clsx(
      "flex cursor-pointer gap-2.5 rounded-md border p-2",
      chosen ? "border-neutral-500 bg-neutral-800/60" : "border-wb-border hover:border-neutral-700",
    );
  const suggestions = message.questions.flatMap((q) => (q.suggested ? [[q.key, q.suggested] as const] : []));
  const allSelected = suggestions.every(([key, id]) => choices[key] === id);
  return (
    <div className="rounded-lg border border-wb-border-strong bg-wb-panel-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[13px] font-medium text-neutral-100">Is this someone already in your Rolodex?</p>
          <p className="mt-0.5 text-[12px] text-neutral-500">Nothing is saved until you choose.</p>
        </div>
        {suggestions.length > 1 && (
          <Button
            size="xs"
            disabled={busy}
            onClick={() =>
              setChoices((old) => {
                const next = { ...old };
                for (const [key, id] of suggestions) {
                  if (allSelected) delete next[key];
                  else next[key] = id;
                }
                return next;
              })
            }
          >
            {allSelected ? "Clear all" : "Select all"}
          </Button>
        )}
      </div>
      {message.questions.map((q: IdentityQuestion) => (
        <fieldset key={q.key} disabled={busy} className="mt-3 space-y-1.5">
          <legend className="mb-1.5 text-[12px] font-medium text-neutral-400">{q.name}</legend>
          {q.candidates.map((person) => (
            <label key={person.id} className={option(choices[q.key] === person.id)}>
              <input
                type="radio"
                className="mt-1.5 accent-neutral-300"
                name={`${message.id}-${q.key}`}
                checked={choices[q.key] === person.id}
                onChange={() => setChoices({ ...choices, [q.key]: person.id })}
              />
              <Avatar person={person} />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-neutral-200">{person.name}</span>
                {person.headline && <span className="block text-[12px] text-neutral-500">{person.headline}</span>}
                {person.details.map((detail) => (
                  <span key={detail} className="mt-0.5 block text-[12px] leading-relaxed text-neutral-400">
                    {detail}
                  </span>
                ))}
              </span>
            </label>
          ))}
          <label className={clsx(option(q.key in choices && choices[q.key] === null), "items-center")}>
            <input
              type="radio"
              className="accent-neutral-300"
              name={`${message.id}-${q.key}`}
              checked={q.key in choices && choices[q.key] === null}
              onChange={() => setChoices({ ...choices, [q.key]: null })}
            />
            <span className="text-[13px] text-neutral-300">New person named {q.name}</span>
          </label>
        </fieldset>
      ))}
      {error && <p className="mt-2 text-[12px] text-red-400">{error}</p>}
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          disabled={busy || message.questions.some((q) => !(q.key in choices))}
          onClick={() => void resolve()}
        >
          Save
        </Button>
        <Button disabled={busy} onClick={() => void resolve(true)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
