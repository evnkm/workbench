import {
  algorithmFamilies,
  algorithmStatuses,
  experimentStatuses,
  PLAYBOOK_MINUTES,
  type PokerBot,
  type PokerbotState,
  type PokerMatch,
  type PokerRecordInput,
  type PokerResult,
  pokerHeadToHead,
  pokerResult,
  pokerStandings,
} from "@workbench/contracts";
import clsx from "clsx";
import { ArrowLeft, ExternalLink, Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { href, navigate } from "../lib/router.ts";
import { type Editing, PokerbotForm } from "./PokerbotForms.tsx";
import { Lineage } from "./PokerbotLineage.tsx";
import { Button, ErrorText, IconButton } from "./ui.tsx";

const endpoint = "/api/apps/pokerbot";
const SECTIONS = [
  ["overview", "Overview"],
  ["experiments", "Experiments"],
  ["matches", "Matches"],
  ["bots", "Bots"],
  ["algorithms", "Algorithms"],
  ["event", "Event"],
] as const;
type Section = (typeof SECTIONS)[number][0];

// From pokerbot.sequoiacap.com, for the Bay Area route: the Menlo Park regional, then the finals.
const SITE = "https://pokerbot.sequoiacap.com/";
const EVENTS = [
  { date: "2026-10-27", label: "Applications open", note: "" },
  { date: "2026-11-03", label: "Registration closes", note: "11:59 PM PT, Bay Area regional" },
  { date: "2026-11-05", label: "Decisions", note: "Bay Area applicants hear back" },
  {
    date: "2026-11-06",
    label: "Bay Area regional",
    note: "2800 Sand Hill Road, Menlo Park; check-in 5:30, 6:00–9:00 PM",
  },
  { date: "2026-11-15", label: "Finals", note: "San Francisco, by invitation; 12:00–8:00 PM" },
];
const HOME_EVENT = EVENTS[3]!;
const DEADLINE = EVENTS[1]!;
// From the official rules (pokerbot.sequoiacap.com/rules.html).
const FORMAT: [string, string][] = [
  ["Game", "Poker variant revealed at the start of the build"],
  ["Format", "8-bot sit-and-gos, up to 200 hands each"],
  ["Stacks", "2,000 chips; blinds 10/20, up every 25 hands"],
  ["Scoring", "Points by finishing place; ICM splits the rest at hand 200"],
  ["Tournaments", "T1–T6, 20 min apart, weighted 1–6; 10,000 sit-and-gos each"],
  ["Bot", "Python Agent interface; 1 ms per decision; 100 MB"],
  ["Errors", "A timeout or error folds, or checks if it can"],
  ["Opponents", "Anonymized; bot state resets at each table"],
  ["Sandbox", "No network access"],
  ["Build", "60 minutes; Astra and Codex allowed; one submission per 5 min"],
  ["Starter kit", "Agent template, simulator, ICM calculator, payouts, blind schedule"],
  ["Team", "1 or 2 people; one regional each"],
  ["Prizes", "Regional top 5: $5,000 and the Finals; Finals $100K, $50K, $25K"],
];

export const STATUS_LABEL: Record<string, string> = {
  idea: "Idea",
  building: "Building",
  ready: "Ready",
  retired: "Retired",
  planned: "Planned",
  running: "Running",
  done: "Done",
  dropped: "Dropped",
  queued: "To read",
  reading: "Reading",
  understood: "Understood",
  implemented: "Implemented",
};

export const signed = (n: number) => {
  const r = Math.round(n);
  return r > 0 ? `+${r.toLocaleString()}` : r < 0 ? `−${Math.abs(r).toLocaleString()}` : "0";
};
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const today = () => new Date().toLocaleDateString("en-CA");
const daysUntil = (date: string) => Math.round((Date.parse(date) - Date.parse(today())) / 86_400_000);
export const shortDate = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const inDays = (date: string) => {
  const d = daysUntil(date);
  return d === 0 ? "Today" : d === 1 ? "Tomorrow" : d > 0 ? `in ${d} days` : d === -1 ? "Yesterday" : `${-d} days ago`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function Pokerbot({ section }: { section?: string }) {
  const current: Section = SECTIONS.find(([id]) => id === section)?.[0] ?? "overview";
  const [state, setState] = useState<PokerbotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const load = useCallback(() => {
    setError(null);
    api<PokerbotState>(`${endpoint}/state`).then(setState, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    // Benchmark scripts write here too; refresh while the tab is in view.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        api<PokerbotState>(`${endpoint}/state`).then(setState, () => undefined);
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);
  const mutate = async (path: string, init: RequestInit) =>
    setState(await api<PokerbotState>(`${endpoint}${path}`, init));
  const view = state && { state, edit: setEditing };
  return (
    <div className="flex h-full min-h-0 flex-col bg-wb-bg">
      <header className="flex h-11 shrink-0 items-center border-b border-wb-border bg-wb-panel px-1.5 md:px-2">
        <IconButton label="All mini-apps" onClick={() => navigate({ name: "apps", app: null })}>
          <ArrowLeft size={16} />
        </IconButton>
        {/* The Workbench phone header already names the app. */}
        <h1 className="sr-only md:not-sr-only md:ml-2 md:pr-3 md:text-[13px] md:font-semibold md:text-neutral-100">
          Pokerbot
        </h1>
        <nav aria-label="Pokerbot sections" className="flex h-full min-w-0 flex-1 overflow-x-auto">
          {SECTIONS.map(([id, label]) => {
            const route = { name: "apps", app: "pokerbot", section: id } as const;
            return (
              <a
                key={id}
                href={href(route)}
                aria-current={id === current ? "page" : undefined}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                  e.preventDefault();
                  navigate(route);
                }}
                className={clsx(
                  // The active tab is marked by a 1px line as wide as its label, on the header's edge.
                  "relative flex h-full shrink-0 items-center px-3 text-[14px] transition-colors md:text-[13px]",
                  "after:absolute after:inset-x-3 after:-bottom-px after:h-px",
                  id === current ? "text-neutral-100 after:bg-neutral-100" : "text-neutral-500 hover:text-neutral-200",
                )}
              >
                {label}
              </a>
            );
          })}
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-5 md:px-6 md:pt-6">
          {error && (
            <ErrorText>
              Couldn’t load Pokerbot: {error}{" "}
              <button type="button" onClick={load} className="underline">
                Retry
              </button>
            </ErrorText>
          )}
          {view &&
            (current === "overview" ? (
              <Overview {...view} />
            ) : current === "experiments" ? (
              <Experiments {...view} />
            ) : current === "matches" ? (
              <Matches {...view} />
            ) : current === "bots" ? (
              <Bots {...view} />
            ) : current === "algorithms" ? (
              <Algorithms {...view} />
            ) : (
              <EventPlan {...view} />
            ))}
        </div>
      </div>
      {state && editing && (
        <PokerbotForm
          editing={editing}
          state={state}
          edit={setEditing}
          save={(id: string, input: PokerRecordInput) =>
            mutate(`/records/${id}`, { method: "PUT", body: JSON.stringify(input) })
          }
          remove={(id: string) => mutate(`/records/${id}`, { method: "DELETE" })}
        />
      )}
    </div>
  );
}

type View = { state: PokerbotState; edit: (e: Editing) => void };

function TitleRow({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-neutral-100">{title}</h2>
        {sub && <p className="mt-1 text-[13px] text-neutral-400">{sub}</p>}
      </div>
      {children && <div className="flex shrink-0 gap-2">{children}</div>}
    </div>
  );
}

function Panel({
  title,
  meta,
  children,
  className,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={clsx("min-w-0 rounded-lg border border-wb-border bg-wb-panel", className)}>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2">
        <h3 className="text-[13px] font-medium text-neutral-100">{title}</h3>
        {meta && <div className="text-[12px] text-neutral-500">{meta}</div>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="mx-4 mb-4 rounded-md border border-dashed border-wb-border-strong px-3 py-2.5 text-[13px] text-neutral-500">
      {children}
    </p>
  );
}

function Status({ value }: { value: string }) {
  // Only work in progress carries the accent.
  const live = value === "running" || value === "reading" || value === "building";
  return (
    <span className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap text-[12px] text-neutral-400">
      <span className={clsx("h-1.5 w-1.5 rounded-full", live ? "bg-wb-accent" : "bg-neutral-600")} />
      {STATUS_LABEL[value]}
    </span>
  );
}

/** A signed mbb/hand figure: ink when it is clear of its 95% interval, grey when it is still noise. */
export function Result({ result, detail = true }: { result: PokerResult | null; detail?: boolean }) {
  if (!result) return <span className="text-neutral-600">—</span>;
  const clear = result.ci !== null && Math.abs(result.mbb) > result.ci;
  return (
    <span className="tabular-nums" title={`${signed(result.mbb)} mbb/hand over ${plural(result.hands, "hand")}`}>
      <span className={clear ? "text-neutral-100" : "text-neutral-400"}>{signed(result.mbb)}</span>
      {detail && (
        <span className="block whitespace-nowrap text-[11px] text-neutral-500">
          {result.ci !== null ? `± ${Math.round(result.ci).toLocaleString()}` : `${compact.format(result.hands)} hands`}
        </span>
      )}
    </span>
  );
}

function rowButton(onClick: () => void) {
  return {
    tabIndex: 0,
    onClick,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
    className:
      "cursor-pointer border-t border-wb-border transition-colors hover:bg-neutral-900/60 focus-visible:outline-offset-[-2px]",
  };
}

const th = "h-9 whitespace-nowrap px-3 text-left text-[12px] font-normal text-neutral-500 first:pl-4 last:pr-4";
const td = "px-3 py-2.5 align-top text-[13px] first:pl-4 last:pr-4";

function matchLabel(match: PokerMatch, bots: PokerBot[]) {
  const name = (id: string) => bots.find((b) => b.id === id)?.name ?? "Deleted bot";
  return match.seats.length === 2
    ? `${name(match.seats[0]!.botId)} vs ${name(match.seats[1]!.botId)}`
    : `${match.seats.length}-bot table`;
}

function MatchSummary({ match, bots }: { match: PokerMatch; bots: PokerBot[] }) {
  const best = [...match.seats].sort((a, b) => b.chips - a.chips)[0]!;
  const name = bots.find((b) => b.id === best.botId)?.name;
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className="text-neutral-400">{name} </span>
      <span className="text-neutral-100">{signed(pokerResult([{ ...best, hands: match.hands }])!.mbb)}</span>
    </span>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ state, edit }: View) {
  const standings = pokerStandings(state.bots, state.matches);
  const leader = standings.filter((s) => s.headsUp).sort((a, b) => b.headsUp!.mbb - a.headsUp!.mbb)[0];
  const hands = state.matches.reduce((n, m) => n + m.hands, 0);
  const running = state.experiments.filter((e) => e.status === "running");
  const planned = state.experiments.filter((e) => e.status === "planned");
  const cells: [string, ReactNode, ReactNode][] = [
    [HOME_EVENT.label, shortDate(HOME_EVENT.date), inDays(HOME_EVENT.date)],
    [
      "Leading bot, heads-up",
      leader ? leader.bot.name : "—",
      leader
        ? `${signed(leader.headsUp!.mbb)} mbb/hand over ${compact.format(leader.headsUp!.hands)} hands`
        : "No heads-up matches yet",
    ],
    ["Hands played", compact.format(hands), plural(state.matches.length, "match", "matches")],
    ["Experiments running", running.length, `${planned.length} planned`],
  ];
  return (
    <>
      <TitleRow
        title="Overview"
        sub={`${HOME_EVENT.label} in Menlo Park on ${shortDate(HOME_EVENT.date)}, ${inDays(HOME_EVENT.date)}. Registration closes ${shortDate(DEADLINE.date)}, 11:59 PM PT.`}
      >
        <Button onClick={() => edit({ kind: "experiment", id: null })}>New experiment</Button>
        <Button onClick={() => edit({ kind: "match", id: null })}>
          <Plus size={14} /> Log match
        </Button>
      </TitleRow>
      <div className="mb-4 grid grid-cols-2 overflow-hidden rounded-lg border border-wb-border bg-wb-panel md:grid-cols-4">
        {cells.map(([label, value, sub], i) => (
          <div
            key={label}
            className={clsx(
              "min-w-0 border-wb-border px-4 py-3.5",
              i % 2 === 1 && "border-l",
              i >= 2 && "border-t md:border-t-0",
              i === 2 && "md:border-l",
            )}
          >
            <div className="text-[12px] text-neutral-500">{label}</div>
            <div className="mt-1 truncate text-[22px] font-medium tabular-nums tracking-[-0.01em] text-neutral-100">
              {value}
            </div>
            <div className="mt-0.5 text-[12px] text-neutral-500">{sub}</div>
          </div>
        ))}
      </div>
      <div className="mb-4 grid items-start gap-4 lg:grid-cols-3">
        <HeadToHead state={state} className="lg:col-span-2" />
        <Standings state={state} edit={edit} />
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel title="Experiments in progress" meta={<SectionLink section="experiments">All experiments</SectionLink>}>
          {[...running, ...planned].length ? (
            <ul className="pb-2">
              {[...running, ...planned].slice(0, 5).map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => edit({ kind: "experiment", id: x.id })}
                    className="flex w-full items-start gap-3 border-t border-wb-border px-4 py-2.5 text-left hover:bg-neutral-900/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-neutral-100">{x.title}</span>
                      {x.question && <span className="block truncate text-[12px] text-neutral-500">{x.question}</span>}
                    </span>
                    <Status value={x.status} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing planned. An experiment is one question, a few bots and enough hands to answer it.</Empty>
          )}
        </Panel>
        <Panel title="Recent matches" meta={<SectionLink section="matches">All matches</SectionLink>}>
          {state.matches.length ? (
            <ul className="pb-2">
              {state.matches.slice(0, 5).map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => edit({ kind: "match", id: m.id })}
                    className="flex w-full items-start gap-3 border-t border-wb-border px-4 py-2.5 text-left text-[13px] hover:bg-neutral-900/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-neutral-100">{matchLabel(m, state.bots)}</span>
                      <span className="block text-[12px] text-neutral-500">
                        {shortDate(m.playedOn)} · {plural(m.hands, "hand")}
                      </span>
                    </span>
                    <MatchSummary match={m} bots={state.bots} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No matches logged. Log a run’s net chips per seat to fill the table above.</Empty>
          )}
        </Panel>
      </div>
    </>
  );
}

function SectionLink({ section, children }: { section: Section; children: ReactNode }) {
  const route = { name: "apps", app: "pokerbot", section } as const;
  return (
    <a
      href={href(route)}
      onClick={(e) => {
        e.preventDefault();
        navigate(route);
      }}
      className="text-neutral-400 hover:text-neutral-100"
    >
      {children}
    </a>
  );
}

function HeadToHead({ state, className }: { state: PokerbotState; className?: string }) {
  const played = new Set(state.matches.filter((m) => m.seats.length === 2).flatMap((m) => m.seats.map((s) => s.botId)));
  const bots = state.bots.filter((b) => b.status !== "retired" || played.has(b.id));
  return (
    <Panel title="Heads-up results" meta="Row bot against column bot, mbb/hand" className={className}>
      {bots.length < 2 ? (
        <Empty>Add two bots to compare them.</Empty>
      ) : (
        <div className="overflow-x-auto pb-2">
          <table className="w-full min-w-max border-collapse">
            <thead>
              <tr>
                <th className={th}>
                  <span className="sr-only">Bot</span>
                </th>
                {bots.map((b) => (
                  <th key={b.id} className={clsx(th, "max-w-28 truncate text-right")} title={b.name}>
                    {b.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bots.map((row) => (
                <tr key={row.id} className="border-t border-wb-border">
                  <th scope="row" className={clsx(td, "whitespace-nowrap text-left font-normal text-neutral-200")}>
                    {row.name}
                  </th>
                  {bots.map((col) => (
                    <td key={col.id} className={clsx(td, "h-12 text-right", row.id === col.id && "bg-neutral-900/50")}>
                      {row.id !== col.id && <Result result={pokerHeadToHead(state.matches, row.id, col.id)} />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 pt-2 text-[12px] text-neutral-500">
            Grey figures are still inside their 95% interval, or have no standard deviation logged.
          </p>
        </div>
      )}
    </Panel>
  );
}

function Standings({ state, edit }: View) {
  const rows = pokerStandings(state.bots, state.matches)
    .filter((s) => s.bot.status !== "retired" || s.headsUp || s.table)
    .sort((a, b) => (b.headsUp?.mbb ?? -Infinity) - (a.headsUp?.mbb ?? -Infinity));
  return (
    <Panel title="Standings" meta="mbb/hand">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={th}>Bot</th>
            <th className={clsx(th, "text-right")}>Heads-up</th>
            <th className={clsx(th, "text-right")}>8-max</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ bot, headsUp, table }) => (
            <tr key={bot.id} {...rowButton(() => edit({ kind: "bot", id: bot.id }))}>
              <td className={clsx(td, "max-w-0 w-full")}>
                <span className="block truncate text-neutral-100">{bot.name}</span>
                <span className="block text-[12px] text-neutral-500">{bot.version || STATUS_LABEL[bot.status]}</span>
              </td>
              <td className={clsx(td, "text-right")}>
                <Result result={headsUp} />
              </td>
              <td className={clsx(td, "text-right")}>
                <Result result={table} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ---------------------------------------------------------------- experiments

function Filter<T extends string>({
  options,
  value,
  onChange,
  count,
  label,
}: {
  options: readonly T[];
  value: T | "all";
  onChange: (v: T | "all") => void;
  count: (v: T | "all") => number;
  label: string;
}) {
  return (
    <fieldset aria-label={label} className="-mx-4 mb-4 flex min-w-0 overflow-x-auto px-4 md:mx-0 md:px-0">
      <div className="flex border-b border-wb-border">
        {(["all", ...options] as const).map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={value === o}
            onClick={() => onChange(o)}
            className={clsx(
              "relative h-9 shrink-0 px-3 text-[13px] transition-colors first:pl-0",
              "after:absolute after:inset-x-3 after:-bottom-px after:h-px first:after:left-0",
              value === o ? "text-neutral-100 after:bg-neutral-100" : "text-neutral-500 hover:text-neutral-200",
            )}
          >
            {o === "all" ? "All" : STATUS_LABEL[o]} <span className="tabular-nums text-neutral-500">{count(o)}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Experiments({ state, edit }: View) {
  const [status, setStatus] = useState<(typeof experimentStatuses)[number] | "all">("all");
  const rows = state.experiments.filter((x) => status === "all" || x.status === status).reverse();
  const botNames = (ids: string[]) => ids.map((id) => state.bots.find((b) => b.id === id)?.name).join(", ");
  return (
    <>
      <TitleRow
        title="Experiments"
        sub="Small, single-question tests. Link matches to an experiment to collect its evidence."
      >
        <Button onClick={() => edit({ kind: "experiment", id: null })}>
          <Plus size={14} /> New experiment
        </Button>
      </TitleRow>
      <Filter
        label="Experiment status"
        options={experimentStatuses}
        value={status}
        onChange={setStatus}
        count={(s) => state.experiments.filter((x) => s === "all" || x.status === s).length}
      />
      <div className="rounded-lg border border-wb-border bg-wb-panel">
        {rows.length ? (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Experiment</th>
                <th className={clsx(th, "hidden md:table-cell")}>Bots</th>
                <th className={clsx(th, "hidden text-right sm:table-cell")}>Hands</th>
                <th className={th}>Status</th>
                <th className={clsx(th, "hidden text-right md:table-cell")}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const matches = state.matches.filter((m) => m.experimentId === x.id);
                return (
                  <tr key={x.id} {...rowButton(() => edit({ kind: "experiment", id: x.id }))}>
                    <td className={clsx(td, "w-full max-w-0")}>
                      <span className="block truncate text-neutral-100">{x.title}</span>
                      <span className="block truncate text-[12px] text-neutral-500">
                        {x.question || botNames(x.botIds) || "No question written"}
                      </span>
                    </td>
                    <td className={clsx(td, "hidden max-w-56 truncate text-neutral-400 md:table-cell")}>
                      {botNames(x.botIds) || "—"}
                    </td>
                    <td className={clsx(td, "hidden text-right tabular-nums sm:table-cell")}>
                      <span className="text-neutral-200">
                        {compact.format(matches.reduce((n, m) => n + m.hands, 0))}
                      </span>
                      <span className="block text-[11px] text-neutral-500">
                        {plural(matches.length, "match", "matches")}
                      </span>
                    </td>
                    <td className={td}>
                      <Status value={x.status} />
                    </td>
                    <td
                      className={clsx(
                        td,
                        "hidden whitespace-nowrap text-right text-neutral-500 tabular-nums md:table-cell",
                      )}
                    >
                      {shortDate(x.updatedAt.slice(0, 10))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="pt-4">
            <Empty>
              {state.experiments.length
                ? `No ${STATUS_LABEL[status]?.toLowerCase()} experiments.`
                : "No experiments yet. Start with one question, such as whether a 3x open beats a 2.5x open against Pot odds."}
            </Empty>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- matches

function Matches({ state, edit }: View) {
  const hands = state.matches.reduce((n, m) => n + m.hands, 0);
  return (
    <>
      <TitleRow
        title="Matches"
        sub={`${plural(state.matches.length, "match", "matches")}, ${plural(hands, "hand")}. Results in mbb/hand at 50/100 blinds.`}
      >
        <Button onClick={() => edit({ kind: "match", id: null })}>
          <Plus size={14} /> Log match
        </Button>
      </TitleRow>
      <HeadToHead state={state} className="mb-4" />
      <Panel title="Match log">
        {state.matches.length ? (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={clsx(th, "w-24")}>Date</th>
                <th className={th}>Table</th>
                <th className={clsx(th, "hidden md:table-cell")}>Experiment</th>
                <th className={clsx(th, "hidden text-right sm:table-cell")}>Hands</th>
                <th className={clsx(th, "text-right")}>Top seat</th>
              </tr>
            </thead>
            <tbody>
              {state.matches.map((m) => (
                <tr key={m.id} {...rowButton(() => edit({ kind: "match", id: m.id }))}>
                  <td className={clsx(td, "whitespace-nowrap tabular-nums text-neutral-400")}>{m.playedOn}</td>
                  <td className={clsx(td, "w-full max-w-0")}>
                    <span className="block truncate text-neutral-100">{matchLabel(m, state.bots)}</span>
                    {m.notes && <span className="block truncate text-[12px] text-neutral-500">{m.notes}</span>}
                  </td>
                  <td className={clsx(td, "hidden max-w-48 truncate text-neutral-400 md:table-cell")}>
                    {state.experiments.find((x) => x.id === m.experimentId)?.title ?? "—"}
                  </td>
                  <td className={clsx(td, "hidden text-right tabular-nums text-neutral-200 sm:table-cell")}>
                    {m.hands.toLocaleString()}
                  </td>
                  <td className={clsx(td, "text-right")}>
                    <MatchSummary match={m} bots={state.bots} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No matches logged yet.</Empty>
        )}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- bots

function Bots({ state, edit }: View) {
  const standings = pokerStandings(state.bots, state.matches);
  return (
    <>
      <TitleRow
        title="Bots"
        sub={`${plural(state.bots.filter((b) => b.status === "ready").length, "bot")} ready of ${state.bots.length}. Reference opponents belong here too.`}
      >
        <Button onClick={() => edit({ kind: "bot", id: null })}>
          <Plus size={14} /> New bot
        </Button>
      </TitleRow>
      <Lineage bots={state.bots} onEdit={(id) => edit({ kind: "bot", id })} />
      <div className="rounded-lg border border-wb-border bg-wb-panel">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={th}>Bot</th>
              <th className={th}>Status</th>
              <th className={clsx(th, "hidden lg:table-cell")}>Source</th>
              <th className={clsx(th, "text-right")}>Heads-up</th>
              <th className={clsx(th, "hidden text-right sm:table-cell")}>8-max</th>
            </tr>
          </thead>
          <tbody>
            {standings.map(({ bot, headsUp, table }) => (
              <tr key={bot.id} {...rowButton(() => edit({ kind: "bot", id: bot.id }))}>
                <td className={clsx(td, "w-full max-w-0")}>
                  <span className="block truncate text-neutral-100">
                    {bot.name} <span className="text-neutral-500">{bot.version}</span>
                  </span>
                  <span className="block truncate text-[12px] text-neutral-500">
                    {bot.approach || "No approach written"}
                  </span>
                </td>
                <td className={td}>
                  <Status value={bot.status} />
                </td>
                <td
                  className={clsx(td, "hidden max-w-56 truncate font-mono text-[12px] text-neutral-400 lg:table-cell")}
                >
                  {bot.source || "—"}
                </td>
                <td className={clsx(td, "text-right")}>
                  <Result result={headsUp} />
                </td>
                <td className={clsx(td, "hidden text-right sm:table-cell")}>
                  <Result result={table} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!state.bots.length && (
          <div className="pt-4">
            <Empty>No bots yet.</Empty>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- algorithms

function Algorithms({ state, edit }: View) {
  const [status, setStatus] = useState<(typeof algorithmStatuses)[number] | "all">("all");
  const rows = state.algorithms.filter((a) => status === "all" || a.status === status);
  const families = algorithmFamilies.filter((f) => rows.some((a) => a.family === f));
  return (
    <>
      <TitleRow title="Algorithms" sub="What to read, what is understood, and what made it into a bot.">
        <Button onClick={() => edit({ kind: "algorithm", id: null })}>
          <Plus size={14} /> Add
        </Button>
      </TitleRow>
      <Filter
        label="Reading status"
        options={algorithmStatuses}
        value={status}
        onChange={setStatus}
        count={(s) => state.algorithms.filter((a) => s === "all" || a.status === s).length}
      />
      {families.length ? (
        <div className="space-y-4">
          {families.map((family) => (
            <Panel
              key={family}
              title={family}
              meta={plural(rows.filter((a) => a.family === family).length, "entry", "entries")}
            >
              <ul className="pb-1">
                {rows
                  .filter((a) => a.family === family)
                  .map((a) => (
                    <li key={a.id} className="flex items-start gap-3 border-t border-wb-border">
                      <button
                        type="button"
                        onClick={() => edit({ kind: "algorithm", id: a.id })}
                        className="min-w-0 flex-1 py-2.5 pl-4 text-left hover:bg-neutral-900/60"
                      >
                        <span className="flex items-center gap-3">
                          <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-100">{a.name}</span>
                          <Status value={a.status} />
                        </span>
                        {a.summary && (
                          <span className="mt-0.5 line-clamp-2 block max-w-3xl text-[12px] leading-relaxed text-neutral-500">
                            {a.summary}
                          </span>
                        )}
                      </button>
                      <span className="flex w-12 shrink-0 justify-end pr-2 pt-1.5">
                        {a.links[0] && (
                          <a
                            href={a.links[0]}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open the reference for ${a.name}`}
                            title={a.links[0]}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-900 hover:text-neutral-100"
                          >
                            <ExternalLink size={14} />
                          </a>
                        )}
                      </span>
                    </li>
                  ))}
              </ul>
            </Panel>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-wb-border bg-wb-panel pt-4">
          <Empty>Nothing marked {STATUS_LABEL[status]?.toLowerCase()}.</Empty>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- event

const clock = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

function EventPlan({ state, edit }: View) {
  const steps = state.playbook.steps;
  const used = steps.reduce((n, s) => n + s.minutes, 0);
  let start = 0;
  return (
    <>
      <TitleRow title="Event" sub="No Limit, Sequoia’s bot-building tournament.">
        <a
          href={SITE}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-wb-border px-3 text-[13px] font-medium text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-100"
        >
          <ExternalLink size={14} /> Event site
        </a>
      </TitleRow>
      <div className="grid items-start gap-4 lg:grid-cols-5">
        <Panel title="60-minute plan" meta={`${used} of ${PLAYBOOK_MINUTES} minutes`} className="lg:col-span-3">
          <div className="px-4 pb-4">
            {/* The hour as a track: one segment per step, seams between them. */}
            <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-neutral-900">
              {steps.map((s, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: display-only; the plan is replaced whole on save.
                  key={i}
                  title={`${s.title}, ${s.minutes} min`}
                  style={{ width: `${(s.minutes / PLAYBOOK_MINUTES) * 100}%` }}
                  className={i % 2 ? "bg-neutral-500" : "bg-neutral-300"}
                />
              ))}
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-neutral-500">
              <span>0:00</span>
              <span>0:30</span>
              <span>1:00</span>
            </div>
          </div>
          {steps.length ? (
            <ol className="pb-2">
              {steps.map((s, i) => {
                const from = start;
                start += s.minutes;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: display-only; the plan is replaced whole on save.
                  <li key={i} className="flex gap-4 border-t border-wb-border px-4 py-2.5">
                    <span className="w-20 shrink-0 pt-px text-[12px] tabular-nums text-neutral-500">
                      {clock(from)}–{clock(start)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] text-neutral-100">{s.title}</span>
                      {s.detail && (
                        <span className="block text-[12px] leading-relaxed text-neutral-500">{s.detail}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-[12px] tabular-nums text-neutral-400">{s.minutes} min</span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <Empty>No steps yet.</Empty>
          )}
          <div className="border-t border-wb-border px-4 py-2.5">
            <Button variant="bare" size="xs" className="-ml-2" onClick={() => edit({ kind: "playbook" })}>
              Edit plan
            </Button>
          </div>
        </Panel>
        <div className="space-y-4 lg:col-span-2">
          <Panel title="Dates">
            <ul className="pb-1.5">
              {EVENTS.map((e) => {
                const past = daysUntil(e.date) < 0;
                return (
                  <li
                    key={e.label}
                    className="flex items-start gap-3 border-t border-wb-border px-4 py-2.5 text-[13px]"
                  >
                    <span className="w-14 shrink-0 tabular-nums text-neutral-400">{shortDate(e.date)}</span>
                    <span className="min-w-0 flex-1">
                      <span className={clsx("block", past ? "text-neutral-500" : "text-neutral-100")}>{e.label}</span>
                      {e.note && <span className="block text-[12px] text-neutral-500">{e.note}</span>}
                    </span>
                    <span className="shrink-0 text-[12px] tabular-nums text-neutral-500">{inDays(e.date)}</span>
                  </li>
                );
              })}
            </ul>
          </Panel>
          <Panel title="Format">
            <dl className="pb-1.5">
              {FORMAT.map(([k, v]) => (
                <div key={k} className="flex gap-3 border-t border-wb-border px-4 py-2 text-[13px]">
                  <dt className="w-32 shrink-0 text-neutral-500">{k}</dt>
                  <dd className="min-w-0 text-neutral-200">{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>
      </div>
    </>
  );
}
