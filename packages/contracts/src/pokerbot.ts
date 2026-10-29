import { z } from "zod";

/** The competition's big blind (50/100 blinds, 10,000-chip stacks reset every hand). */
export const POKER_BIG_BLIND = 100;
export const PLAYBOOK_MINUTES = 60;
export const PLAYBOOK_ID = "playbook";
export const pokerRecordIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

const line = (max: number) => z.string().trim().max(max);
const name = (max: number) => z.string().trim().min(1).max(max);

export const botStatuses = ["idea", "building", "ready", "retired"] as const;
export const experimentStatuses = ["planned", "running", "done", "dropped"] as const;
export const algorithmStatuses = ["queued", "reading", "understood", "implemented"] as const;
export const algorithmFamilies = [
  "Equilibrium",
  "Search",
  "Abstraction",
  "Opponent modelling",
  "Heuristic",
  "Evaluation",
] as const;

export const pokerRecordInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bot"),
    name: name(80),
    version: line(40),
    approach: line(200),
    status: z.enum(botStatuses),
    source: line(300),
    notes: line(4000),
    // Lineage: the bots this one was derived from, and what it kept from each.
    parents: z.array(z.object({ botId: pokerRecordIdSchema, kept: line(300) })).max(4),
  }),
  z.object({
    kind: z.literal("experiment"),
    title: name(160),
    question: line(1000),
    setup: line(4000),
    status: z.enum(experimentStatuses),
    findings: line(4000),
    botIds: z.array(pokerRecordIdSchema).max(8),
  }),
  z.object({
    kind: z.literal("match"),
    playedOn: z.iso.date(),
    hands: z.int().min(1).max(10_000_000),
    // Net chips per seat; a match is zero-sum, so they total 0. sd is the
    // standard deviation of that seat's per-hand result, when the runner reports it.
    seats: z
      .array(
        z.object({
          botId: pokerRecordIdSchema,
          chips: z.int(),
          sd: z.number().positive().nullable(),
        }),
      )
      .min(2)
      .max(8),
    experimentId: pokerRecordIdSchema.nullable(),
    notes: line(2000),
  }),
  z.object({
    kind: z.literal("algorithm"),
    name: name(120),
    family: z.enum(algorithmFamilies),
    status: z.enum(algorithmStatuses),
    summary: line(2000),
    notes: line(8000),
    links: z.array(z.url()).max(10),
  }),
  z.object({
    kind: z.literal("playbook"),
    steps: z
      .array(z.object({ title: name(120), minutes: z.int().min(1).max(PLAYBOOK_MINUTES), detail: line(2000) }))
      .max(20)
      .refine((steps) => steps.reduce((sum, s) => sum + s.minutes, 0) <= PLAYBOOK_MINUTES, {
        message: `The plan must fit in ${PLAYBOOK_MINUTES} minutes.`,
      }),
  }),
]);
export type PokerRecordInput = z.infer<typeof pokerRecordInputSchema>;
export type PokerRecord = PokerRecordInput & { id: string; createdAt: string; updatedAt: string };
type Of<K extends PokerRecord["kind"]> = Extract<PokerRecord, { kind: K }>;
export type PokerBot = Of<"bot">;
export type PokerExperiment = Of<"experiment">;
export type PokerMatch = Of<"match">;
export type PokerAlgorithm = Of<"algorithm">;
export type PokerPlaybook = Of<"playbook">;
export type PokerbotState = {
  bots: PokerBot[];
  experiments: PokerExperiment[];
  matches: PokerMatch[];
  algorithms: PokerAlgorithm[];
  playbook: PokerPlaybook;
};

/** A result over some hands: milli-big-blinds per hand, with a 95% interval when every match reported sd. */
export type PokerResult = { hands: number; chips: number; mbb: number; ci: number | null };

export function pokerResult(parts: { hands: number; chips: number; sd: number | null }[]): PokerResult | null {
  const hands = parts.reduce((n, p) => n + p.hands, 0);
  if (!hands) return null;
  const chips = parts.reduce((n, p) => n + p.chips, 0);
  // Var(mean) = Σ nᵢ·sdᵢ² / N² for independent hands.
  const ci = parts.every((p) => p.sd !== null)
    ? (1.96 * Math.sqrt(parts.reduce((v, p) => v + p.hands * p.sd! ** 2, 0))) / hands
    : null;
  const mbb = (chip: number) => (chip / POKER_BIG_BLIND) * 1000;
  return { hands, chips, mbb: mbb(chips / hands), ci: ci === null ? null : mbb(ci) };
}

/** Each bot's results, split by heads-up and full-table matches. */
export function pokerStandings(bots: PokerBot[], matches: PokerMatch[]) {
  return bots.map((bot) => {
    const seats = (headsUp: boolean) =>
      matches
        .filter((m) => (m.seats.length === 2) === headsUp)
        .flatMap((m) => m.seats.filter((s) => s.botId === bot.id).map((s) => ({ ...s, hands: m.hands })));
    return { bot, headsUp: pokerResult(seats(true)), table: pokerResult(seats(false)) };
  });
}

/** The heads-up result of `row` against `column`, over every match between them. */
export function pokerHeadToHead(matches: PokerMatch[], row: string, column: string) {
  return pokerResult(
    matches.flatMap((m) => {
      if (m.seats.length !== 2) return [];
      const seat = m.seats.find((s) => s.botId === row);
      return seat && m.seats.some((s) => s.botId === column) ? [{ ...seat, hands: m.hands }] : [];
    }),
  );
}
