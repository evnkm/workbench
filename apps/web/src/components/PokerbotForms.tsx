import {
  algorithmFamilies,
  algorithmStatuses,
  botStatuses,
  experimentStatuses,
  PLAYBOOK_ID,
  PLAYBOOK_MINUTES,
  type PokerbotState,
  type PokerRecord,
  type PokerRecordInput,
  pokerResult,
  uuidv7,
} from "@workbench/contracts";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Result, STATUS_LABEL, shortDate, signed } from "./PokerbotView.tsx";
import { Button, Dialog, ErrorText, Field, IconButton, inputClass } from "./ui.tsx";

export type Editing =
  | { kind: "bot" | "experiment" | "algorithm"; id: string | null }
  | { kind: "match"; id: string | null; experimentId?: string }
  | { kind: "playbook" };
type Input<K extends PokerRecord["kind"]> = Extract<PokerRecordInput, { kind: K }>;
type Props = {
  state: PokerbotState;
  edit: (e: Editing | null) => void;
  save: (id: string, input: PokerRecordInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

const inputOf = <R extends PokerRecord>({ id: _id, createdAt: _c, updatedAt: _u, ...input }: R) => input;
const textarea = clsx(inputClass, "min-h-20 resize-y leading-relaxed");

export function PokerbotForm({ editing, ...props }: Props & { editing: Editing }) {
  switch (editing.kind) {
    case "bot":
      return <BotForm id={editing.id} {...props} />;
    case "experiment":
      return <ExperimentForm id={editing.id} {...props} />;
    case "match":
      return <MatchForm id={editing.id} experimentId={editing.experimentId} {...props} />;
    case "algorithm":
      return <AlgorithmForm id={editing.id} {...props} />;
    case "playbook":
      return <PlaybookForm {...props} />;
  }
}

function RecordDialog({
  title,
  id,
  input,
  name,
  valid = true,
  children,
  save,
  remove,
  edit,
}: Omit<Props, "state"> & {
  title: string;
  id: string | null;
  input: PokerRecordInput;
  /** Shown in the delete confirmation; omit when the record cannot be deleted. */
  name?: string;
  valid?: boolean;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => edit(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={close} wide>
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void run(() => save(id ?? uuidv7(), input));
        }}
      >
        {children}
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center gap-2 pt-1">
          {id && name && (
            <Button
              variant="bare"
              disabled={busy}
              className="-ml-2 px-2 text-red-400 hover:text-red-300"
              onClick={() => confirm(`Delete ${name}?`) && void run(() => remove(id))}
            >
              Delete
            </Button>
          )}
          <span className="flex-1" />
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !valid}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Text({
  label,
  value,
  onChange,
  long,
  hint,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  long?: boolean;
  hint?: ReactNode;
  required?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {long ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} className={textarea} />
      ) : (
        <input value={value} required={required} onChange={(e) => onChange(e.target.value)} className={inputClass} />
      )}
    </Field>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  names = STATUS_LABEL,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  names?: Record<string, string>;
}) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={inputClass}>
        {options.map((o) => (
          <option key={o} value={o}>
            {names[o] ?? o}
          </option>
        ))}
      </select>
    </Field>
  );
}

function useDraft<D extends PokerRecordInput>(initial: () => D) {
  const [draft, setDraft] = useState(initial);
  const set =
    <F extends keyof D>(field: F) =>
    (value: D[F]) =>
      setDraft((d) => ({ ...d, [field]: value }));
  return [draft, set, setDraft] as const;
}

function BotForm({ id, ...props }: Props & { id: string | null }) {
  const old = props.state.bots.find((b) => b.id === id);
  const [draft, set] = useDraft<Input<"bot">>(() =>
    old
      ? inputOf(old)
      : { kind: "bot", name: "", version: "v1", approach: "", status: "idea", source: "", notes: "", parents: [] },
  );
  return (
    <RecordDialog
      title={old ? old.name : "New bot"}
      id={id}
      input={draft}
      name={old?.name}
      valid={!!draft.name.trim()}
      {...props}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem_9rem]">
        <Text label="Name" value={draft.name} onChange={set("name")} required />
        <Text label="Version" value={draft.version} onChange={set("version")} />
        <Choice label="Status" value={draft.status} options={botStatuses} onChange={set("status")} />
      </div>
      <Text
        label="Approach"
        value={draft.approach}
        onChange={set("approach")}
        hint="One line, shown in the bot list."
      />
      <Text label="Source" value={draft.source} onChange={set("source")} hint="Repository path, branch or commit." />
      <Text label="Notes" value={draft.notes} onChange={set("notes")} long />
    </RecordDialog>
  );
}

function ExperimentForm({ id, ...props }: Props & { id: string | null }) {
  const { state, edit } = props;
  const old = state.experiments.find((x) => x.id === id);
  const [draft, set] = useDraft<Input<"experiment">>(() =>
    old
      ? inputOf(old)
      : { kind: "experiment", title: "", question: "", setup: "", status: "planned", findings: "", botIds: [] },
  );
  const matches = state.matches.filter((m) => m.experimentId === id);
  const toggle = (bot: string) =>
    set("botIds")(draft.botIds.includes(bot) ? draft.botIds.filter((b) => b !== bot) : [...draft.botIds, bot]);
  return (
    <RecordDialog
      title={old ? old.title : "New experiment"}
      id={id}
      input={draft}
      name={old?.title}
      valid={!!draft.title.trim()}
      {...props}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
        <Text label="Title" value={draft.title} onChange={set("title")} required />
        <Choice label="Status" value={draft.status} options={experimentStatuses} onChange={set("status")} />
      </div>
      <Text
        label="Question"
        value={draft.question}
        onChange={set("question")}
        hint="What result would change what you build?"
      />
      <fieldset>
        <legend className="mb-1.5 text-[12px] font-medium text-neutral-300">Bots</legend>
        <div className="flex flex-wrap gap-1.5">
          {state.bots.map((b) => (
            <button
              key={b.id}
              type="button"
              aria-pressed={draft.botIds.includes(b.id)}
              onClick={() => toggle(b.id)}
              className={clsx(
                "h-8 rounded-md border px-2.5 text-[13px] transition-colors",
                draft.botIds.includes(b.id)
                  ? "border-neutral-500 bg-neutral-800/70 text-neutral-100"
                  : "border-wb-border text-neutral-400 hover:border-neutral-700 hover:text-neutral-200",
              )}
            >
              {b.name}
            </button>
          ))}
        </div>
      </fieldset>
      <Text
        label="Setup"
        value={draft.setup}
        onChange={set("setup")}
        long
        hint="Seats, hands, seeds and what was held fixed."
      />
      <Text label="Findings" value={draft.findings} onChange={set("findings")} long />
      {old && (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[12px] font-medium text-neutral-300">Matches</span>
            <Button variant="bare" size="xs" onClick={() => edit({ kind: "match", id: null, experimentId: old.id })}>
              <Plus size={13} /> Log match
            </Button>
          </div>
          {matches.length ? (
            <ul className="rounded-md border border-wb-border">
              {matches.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 border-t border-wb-border px-3 py-2 text-[13px] first:border-t-0"
                >
                  <span className="w-14 shrink-0 tabular-nums text-neutral-500">{shortDate(m.playedOn)}</span>
                  <span className="min-w-0 flex-1 truncate text-neutral-300">
                    {m.seats.map((s) => state.bots.find((b) => b.id === s.botId)?.name).join(", ")}
                  </span>
                  <span className="tabular-nums text-neutral-500">{m.hands.toLocaleString()} hands</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed border-wb-border-strong px-3 py-2 text-[13px] text-neutral-500">
              No matches linked yet.
            </p>
          )}
        </div>
      )}
    </RecordDialog>
  );
}

type SeatDraft = { key: string; botId: string; chips: string; sd: string };
const int = (s: string) => (/^[-−]?\d+$/.test(s.trim()) ? Number(s.trim().replace("−", "-")) : null);
const positive = (s: string) => (s.trim() === "" ? null : Number(s) > 0 ? Number(s) : Number.NaN);

function MatchForm({ id, experimentId, ...props }: Props & { id: string | null; experimentId?: string }) {
  const { state } = props;
  const old = state.matches.find((m) => m.id === id);
  const experiment = state.experiments.find((x) => x.id === (old?.experimentId ?? experimentId));
  const [playedOn, setPlayedOn] = useState(old?.playedOn ?? new Date().toLocaleDateString("en-CA"));
  const [hands, setHands] = useState(String(old?.hands ?? 1000));
  const [experimentRef, setExperimentRef] = useState(experiment?.id ?? "");
  const [notes, setNotes] = useState(old?.notes ?? "");
  const [seats, setSeats] = useState<SeatDraft[]>(() =>
    old
      ? old.seats.map((s) => ({
          key: crypto.randomUUID(),
          botId: s.botId,
          chips: String(s.chips),
          sd: s.sd === null ? "" : String(s.sd),
        }))
      : (experiment?.botIds.length ? experiment.botIds : ["", ""])
          .slice(0, 8)
          .concat(experiment?.botIds.length === 1 ? [""] : [])
          .map((botId) => ({ key: crypto.randomUUID(), botId, chips: "", sd: "" })),
  );
  // Heads-up is zero-sum with one variance: the second seat mirrors the first.
  const headsUp = seats.length === 2;
  const shown = headsUp
    ? [
        seats[0]!,
        { ...seats[1]!, chips: int(seats[0]!.chips) === null ? "" : String(-int(seats[0]!.chips)!), sd: seats[0]!.sd },
      ]
    : seats;
  const parsed = shown.map((s) => ({ botId: s.botId, chips: int(s.chips), sd: positive(s.sd) }));
  const handCount = int(hands);
  const total = parsed.reduce((n, s) => n + (s.chips ?? 0), 0);
  const valid =
    handCount !== null &&
    handCount > 0 &&
    parsed.every((s) => s.botId && s.chips !== null && !Number.isNaN(s.sd)) &&
    new Set(parsed.map((s) => s.botId)).size === parsed.length &&
    total === 0;
  const input: Input<"match"> = {
    kind: "match",
    playedOn,
    hands: handCount ?? 0,
    seats: parsed.map((s) => ({ botId: s.botId, chips: s.chips ?? 0, sd: s.sd })),
    experimentId: experimentRef || null,
    notes,
  };
  const update = (i: number, patch: Partial<SeatDraft>) =>
    setSeats(seats.map((s, j) => (i === j ? { ...s, ...patch } : s)));
  const field =
    "h-9 w-full rounded-md border border-wb-border-strong bg-wb-bg px-2.5 text-[15px] tabular-nums text-neutral-100 focus:border-neutral-500 focus:outline-none disabled:text-neutral-400 md:text-sm";
  return (
    <RecordDialog title={old ? "Match" : "Log match"} id={id} input={input} name="this match" valid={valid} {...props}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Played on">
          <input type="date" value={playedOn} onChange={(e) => setPlayedOn(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Hands">
          <input
            inputMode="numeric"
            value={hands}
            onChange={(e) => setHands(e.target.value)}
            className={clsx(inputClass, "tabular-nums")}
          />
        </Field>
        <Field label="Experiment">
          <select value={experimentRef} onChange={(e) => setExperimentRef(e.target.value)} className={inputClass}>
            <option value="">None</option>
            {state.experiments.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-neutral-300 sm:hidden">Seats</div>
        <div className="mb-1.5 hidden grid-cols-[1fr_8rem_7rem_5rem_2rem] gap-2 text-[12px] font-medium text-neutral-300 sm:grid">
          <span>Seat</span>
          <span className="text-right">Net chips</span>
          <span className="text-right">sd per hand</span>
          <span className="hidden text-right sm:block">mbb/hand</span>
          <span />
        </div>
        <ul className="space-y-2">
          {shown.map((seat, i) => {
            const preview =
              handCount && parsed[i]!.chips !== null
                ? pokerResult([{ hands: handCount, chips: parsed[i]!.chips!, sd: null }])
                : null;
            return (
              <li
                key={seat.key}
                className="grid grid-cols-[1fr_1fr_2rem] items-center gap-2 rounded-md border border-wb-border p-2 sm:grid-cols-[1fr_8rem_7rem_5rem_2rem] sm:border-0 sm:p-0"
              >
                <select
                  aria-label={`Seat ${i + 1} bot`}
                  value={seat.botId}
                  onChange={(e) => update(i, { botId: e.target.value })}
                  className={clsx(field, "col-span-2 sm:col-span-1")}
                >
                  <option value="">Choose a bot</option>
                  {state.bots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} {b.version}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Seat ${i + 1} net chips`}
                  inputMode="numeric"
                  value={seat.chips}
                  placeholder="Net chips"
                  disabled={headsUp && i === 1}
                  onChange={(e) => update(i, { chips: e.target.value })}
                  className={clsx(field, "order-last text-right placeholder:text-neutral-600 sm:order-none")}
                />
                <input
                  aria-label={`Seat ${i + 1} standard deviation per hand, in chips`}
                  inputMode="decimal"
                  placeholder="sd, optional"
                  value={seat.sd}
                  disabled={headsUp && i === 1}
                  onChange={(e) => update(i, { sd: e.target.value })}
                  className={clsx(field, "order-last text-right placeholder:text-neutral-600 sm:order-none")}
                />
                <span className="hidden text-right text-[13px] sm:block">
                  <Result result={preview} detail={false} />
                </span>
                <IconButton
                  label={`Remove seat ${i + 1}`}
                  disabled={seats.length <= 2}
                  onClick={() => setSeats(seats.filter((_, j) => j !== i))}
                >
                  <X size={14} />
                </IconButton>
              </li>
            );
          })}
        </ul>
        <div className="mt-2 flex items-center justify-between gap-3">
          <Button
            variant="bare"
            size="xs"
            className="-ml-2"
            disabled={seats.length >= 8}
            onClick={() => setSeats([...shown, { key: crypto.randomUUID(), botId: "", chips: "", sd: "" }])}
          >
            <Plus size={13} /> Add seat
          </Button>
          <span className={clsx("text-[12px] tabular-nums", total ? "text-red-400" : "text-neutral-500")}>
            {total
              ? `Seats total ${signed(total)} chips; a match totals 0`
              : headsUp
                ? "Seat 2 mirrors seat 1"
                : "Seats total 0"}
          </span>
        </div>
      </div>
      <Text label="Notes" value={notes} onChange={setNotes} hint="Seeds, engine version, anything odd in the run." />
    </RecordDialog>
  );
}

function AlgorithmForm({ id, ...props }: Props & { id: string | null }) {
  const old = props.state.algorithms.find((a) => a.id === id);
  const [draft, set] = useDraft<Input<"algorithm">>(() =>
    old
      ? inputOf(old)
      : { kind: "algorithm", name: "", family: "Equilibrium", status: "queued", summary: "", notes: "", links: [] },
  );
  const [links, setLinks] = useState(draft.links.join("\n"));
  const input = {
    ...draft,
    links: links
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  };
  const families = Object.fromEntries(algorithmFamilies.map((f) => [f, f]));
  return (
    <RecordDialog
      title={old ? old.name : "Add algorithm"}
      id={id}
      input={input}
      name={old?.name}
      valid={!!draft.name.trim()}
      {...props}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_11rem_9rem]">
        <Text label="Name" value={draft.name} onChange={set("name")} required />
        <Choice
          label="Family"
          value={draft.family}
          options={algorithmFamilies}
          onChange={set("family")}
          names={families}
        />
        <Choice label="Status" value={draft.status} options={algorithmStatuses} onChange={set("status")} />
      </div>
      <Text label="Summary" value={draft.summary} onChange={set("summary")} long />
      <Text label="Notes" value={draft.notes} onChange={set("notes")} long hint="Derivations, gotchas, what to try." />
      <Field label="Links" hint="One URL per line.">
        <textarea value={links} onChange={(e) => setLinks(e.target.value)} className={clsx(textarea, "min-h-16")} />
      </Field>
    </RecordDialog>
  );
}

function PlaybookForm(props: Props) {
  const [steps, setSteps] = useState(() =>
    props.state.playbook.steps.map((s) => ({ ...s, key: crypto.randomUUID(), minutes: String(s.minutes) })),
  );
  const parsed = steps.map(({ key: _key, ...s }) => ({ ...s, minutes: int(s.minutes) ?? 0 }));
  const total = parsed.reduce((n, s) => n + s.minutes, 0);
  const valid = parsed.every((s) => s.title.trim() && s.minutes > 0) && total <= PLAYBOOK_MINUTES;
  const update = (i: number, patch: Partial<(typeof steps)[number]>) =>
    setSteps(steps.map((s, j) => (i === j ? { ...s, ...patch } : s)));
  const move = (i: number, by: number) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    setSteps(next);
  };
  return (
    <RecordDialog
      title="60-minute plan"
      id={PLAYBOOK_ID}
      input={{ kind: "playbook", steps: parsed }}
      valid={valid}
      {...props}
    >
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={s.key} className="rounded-md border border-wb-border p-3">
            <div className="flex items-center gap-2">
              <input
                aria-label={`Step ${i + 1} title`}
                value={s.title}
                onChange={(e) => update(i, { title: e.target.value })}
                className={clsx(inputClass, "min-w-0 flex-1")}
              />
              <input
                aria-label={`Step ${i + 1} minutes`}
                inputMode="numeric"
                value={s.minutes}
                onChange={(e) => update(i, { minutes: e.target.value })}
                className={clsx(inputClass, "w-16 text-right tabular-nums")}
              />
              <span className="text-[12px] text-neutral-500">min</span>
              <IconButton label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </IconButton>
              <IconButton
                label={`Move step ${i + 1} down`}
                disabled={i === steps.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown size={14} />
              </IconButton>
              <IconButton label={`Remove step ${i + 1}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                <X size={14} />
              </IconButton>
            </div>
            <input
              aria-label={`Step ${i + 1} detail`}
              placeholder="Detail"
              value={s.detail}
              onChange={(e) => update(i, { detail: e.target.value })}
              className={clsx(inputClass, "mt-2")}
            />
          </li>
        ))}
      </ol>
      <div className="flex items-center justify-between">
        <Button
          variant="bare"
          size="xs"
          className="-ml-2"
          disabled={steps.length >= 20}
          onClick={() => setSteps([...steps, { key: crypto.randomUUID(), title: "", minutes: "5", detail: "" }])}
        >
          <Plus size={13} /> Add step
        </Button>
        <span
          className={clsx("text-[12px] tabular-nums", total > PLAYBOOK_MINUTES ? "text-red-400" : "text-neutral-500")}
        >
          {total} of {PLAYBOOK_MINUTES} minutes
        </span>
      </div>
    </RecordDialog>
  );
}
