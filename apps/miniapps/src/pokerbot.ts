import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type algorithmFamilies,
  PLAYBOOK_ID,
  type PokerAlgorithm,
  type PokerBot,
  type PokerbotState,
  type PokerExperiment,
  type PokerMatch,
  type PokerPlaybook,
  type PokerRecord,
  type PokerRecordInput,
  pokerRecordIdSchema,
  pokerRecordInputSchema,
} from "@workbench/contracts";
import { Database } from "@workbench/db";
import type { Hono } from "hono";

// Starting content for a new tracker: reference opponents every experiment
// needs, a reading list, and a first 60-minute plan. All of it is editable.
type Seed = { id: string; input: PokerRecordInput };
const bot = (id: string, name: string, approach: string): Seed => ({
  id,
  input: { kind: "bot", name, version: "v1", approach, status: "idea", source: "", notes: "", parents: [] },
});
const algorithm = (
  id: string,
  name: string,
  family: (typeof algorithmFamilies)[number],
  summary: string,
  links: string[] = [],
): Seed => ({ id, input: { kind: "algorithm", name, family, status: "queued", summary, notes: "", links } });
const seeds: Seed[] = [
  bot("always-call", "Always call", "Calls every bet; checks when it can."),
  bot("random", "Random", "Uniformly random legal action, with random raise sizes."),
  bot("raise-or-fold", "Raise or fold", "Raises with the top 20% of preflop hands, folds the rest."),
  bot("pot-odds", "Pot odds", "Monte Carlo equity against the table; calls when equity beats pot odds."),
  algorithm(
    "cfr",
    "Counterfactual regret minimization",
    "Equilibrium",
    "Self-play that accumulates regret for each action at each information set; the average strategy converges to a Nash equilibrium in two-player zero-sum games.",
    ["http://modelai.gettysburg.edu/2013/cfr/cfr.pdf"],
  ),
  algorithm(
    "mccfr",
    "Monte Carlo CFR",
    "Equilibrium",
    "Samples chance outcomes or opponent actions instead of traversing the whole tree, so each iteration is cheap enough for large games.",
  ),
  algorithm(
    "cfr-plus",
    "CFR+",
    "Equilibrium",
    "Floors cumulative regret at zero and weights later iterations more; used to solve heads-up limit hold'em.",
    ["https://arxiv.org/abs/1407.5042"],
  ),
  algorithm(
    "dcfr",
    "Discounted CFR",
    "Equilibrium",
    "Discounts early regrets and strategies; converges faster than CFR+ in no-limit games.",
    ["https://arxiv.org/abs/1809.04040"],
  ),
  algorithm(
    "deep-cfr",
    "Deep CFR",
    "Equilibrium",
    "Replaces the regret tables with neural networks trained on sampled traversals, so no hand-built abstraction is needed.",
    ["https://arxiv.org/abs/1811.00164"],
  ),
  algorithm(
    "nfsp",
    "Neural fictitious self-play",
    "Equilibrium",
    "Reinforcement learning toward an approximate equilibrium: a best-response network and an average-policy network trained together.",
    ["https://arxiv.org/abs/1603.01121"],
  ),
  algorithm(
    "subgame-solving",
    "Safe and nested subgame solving",
    "Search",
    "Re-solves the current subgame during play with a finer abstraction, without becoming exploitable against the blueprint.",
    ["https://arxiv.org/abs/1705.02955"],
  ),
  algorithm(
    "deepstack",
    "DeepStack",
    "Search",
    "Depth-limited re-solving at every decision, with a learned value function at the leaves instead of a precomputed strategy.",
    ["https://arxiv.org/abs/1701.01724"],
  ),
  algorithm(
    "rebel",
    "ReBeL",
    "Search",
    "Self-play reinforcement learning and search over public belief states; the AlphaZero idea carried to imperfect information.",
    ["https://arxiv.org/abs/2007.13544"],
  ),
  algorithm(
    "pluribus",
    "Pluribus",
    "Search",
    "Six-player no-limit: a blueprint from MCCFR plus depth-limited search that assumes opponents may switch strategies. The closest published system to an 8-bot table.",
    ["https://doi.org/10.1126/science.aay2400"],
  ),
  algorithm(
    "card-abstraction",
    "Card and action abstraction",
    "Abstraction",
    "Buckets hands by equity distribution and limits bet sizes to a few pot fractions so the game fits in memory; off-tree bets are mapped back by action translation.",
  ),
  algorithm(
    "monte-carlo-equity",
    "Monte Carlo equity",
    "Evaluation",
    "Deals random opponent hands and boards to estimate win probability; the core of a bot that can be built in an hour.",
    ["https://github.com/ihendley/treys"],
  ),
  algorithm(
    "pot-odds-rules",
    "Pot odds and bet sizing rules",
    "Heuristic",
    "Calls when equity exceeds the price, raises for value above a threshold, and sizes bets as fractions of the pot. Stacks of 100 big blinds make preflop all-ins expensive mistakes.",
  ),
  algorithm(
    "opponent-stats",
    "Frequency-based opponent modelling",
    "Opponent modelling",
    "Tracks how often each seat enters the pot, raises and folds to aggression, and shifts thresholds to exploit the outliers at the table.",
  ),
  {
    id: PLAYBOOK_ID,
    input: {
      kind: "playbook",
      steps: [
        { title: "Read the engine API and run the starter bot", minutes: 5, detail: "" },
        {
          title: "Hand strength",
          minutes: 15,
          detail: "Preflop chart, then Monte Carlo equity against the live seats.",
        },
        { title: "Betting rules", minutes: 15, detail: "Pot-odds calls, value raises by equity, pot-fraction sizes." },
        { title: "Run against the baselines", minutes: 10, detail: "Fix crashes, illegal actions and timeouts first." },
        { title: "Tune for eight seats", minutes: 10, detail: "Tighten ranges for the number of players still in." },
        { title: "Submit and keep a copy", minutes: 5, detail: "" },
      ],
    },
  },
];

type Row = { id: string; kind: PokerRecord["kind"]; body: string; created_at: string; updated_at: string };

export class PokerbotStore {
  readonly db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.raw.exec(`CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), seeded INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES (1,0);`);
    this.db.tx(() => {
      // Bots recorded before lineage existed have no parents.
      this.db.run(
        "UPDATE records SET body=json_set(body,'$.parents',json('[]')) WHERE kind='bot' AND json_extract(body,'$.parents') IS NULL",
      );
      if (this.db.get<{ seeded: number }>("SELECT seeded FROM meta")!.seeded) return;
      for (const seed of seeds) this.put(seed.id, seed.input);
      this.db.run("UPDATE meta SET seeded=1");
    });
  }
  private records() {
    return this.db.all<Row>("SELECT * FROM records ORDER BY created_at, rowid").map(
      (r) =>
        ({
          ...JSON.parse(r.body),
          kind: r.kind,
          id: r.id,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }) as PokerRecord,
    );
  }
  state(): PokerbotState {
    const records = this.db.read(() => this.records());
    const of = <K extends PokerRecord["kind"]>(kind: K) =>
      records.filter((r): r is Extract<PokerRecord, { kind: K }> => r.kind === kind);
    return {
      bots: of("bot") as PokerBot[],
      experiments: of("experiment") as PokerExperiment[],
      matches: (of("match") as PokerMatch[]).sort((a, b) => b.playedOn.localeCompare(a.playedOn)),
      algorithms: of("algorithm") as PokerAlgorithm[],
      playbook: of("playbook")[0] as PokerPlaybook,
    };
  }
  put(id: string, input: PokerRecordInput) {
    this.db.tx(() => {
      const old = this.db.get<Row>("SELECT * FROM records WHERE id=:id", { id });
      if (old && old.kind !== input.kind) throw new Error(`${id} is a ${old.kind}, not a ${input.kind}.`);
      if (input.kind === "playbook" && id !== PLAYBOOK_ID) throw new Error("There is one playbook.");
      const kindOf = (ref: string) =>
        this.db.get<{ kind: string }>("SELECT kind FROM records WHERE id=:ref", { ref })?.kind;
      const bots =
        input.kind === "match" ? input.seats.map((s) => s.botId) : input.kind === "experiment" ? input.botIds : [];
      if (new Set(bots).size !== bots.length) throw new Error("A bot can appear only once.");
      if (bots.some((bot) => kindOf(bot) !== "bot")) throw new Error("That bot no longer exists.");
      if (input.kind === "bot") {
        const parents = input.parents.map((p) => p.botId);
        if (new Set(parents).size !== parents.length) throw new Error("A parent can appear only once.");
        if (parents.some((p) => kindOf(p) !== "bot")) throw new Error("That parent bot does not exist.");
        // A bot may not descend from itself.
        const seen = new Set<string>();
        const stack = [...parents];
        while (stack.length) {
          const next = stack.pop()!;
          if (next === id) throw new Error("A bot cannot be its own ancestor.");
          if (seen.has(next)) continue;
          seen.add(next);
          const row = this.db.get<{ body: string }>("SELECT body FROM records WHERE id=:next", { next });
          stack.push(...((row && (JSON.parse(row.body) as PokerBot).parents) ?? []).map((p) => p.botId));
        }
      }
      if (input.kind === "match") {
        if (input.seats.reduce((sum, s) => sum + s.chips, 0) !== 0)
          throw new Error("Net chips must total 0 across the seats.");
        if (input.experimentId && kindOf(input.experimentId) !== "experiment")
          throw new Error("That experiment no longer exists.");
      }
      const { kind, ...body } = input;
      const now = new Date().toISOString();
      this.db.run(
        `INSERT INTO records VALUES (:id,:kind,:body,:now,:now)
         ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`,
        { id, kind, body: JSON.stringify(body), now },
      );
    });
  }
  remove(id: string) {
    this.db.tx(() => {
      const row = this.db.get<Row>("SELECT * FROM records WHERE id=:id", { id });
      if (!row) throw new Error("Record not found.");
      if (row.kind === "playbook") throw new Error("The playbook cannot be deleted.");
      const { matches, experiments, bots } = this.state();
      const using =
        row.kind === "bot"
          ? [
              ...matches.filter((m) => m.seats.some((s) => s.botId === id)),
              ...experiments.filter((e) => e.botIds.includes(id)),
              ...bots.filter((b) => b.parents.some((p) => p.botId === id)),
            ]
          : row.kind === "experiment"
            ? matches.filter((m) => m.experimentId === id)
            : [];
      if (using.length) {
        const count = (k: string) => using.filter((r) => r.kind === k).length;
        const parts = [
          count("match") && `${count("match")} ${count("match") === 1 ? "match" : "matches"}`,
          count("experiment") && `${count("experiment")} ${count("experiment") === 1 ? "experiment" : "experiments"}`,
          count("bot") && `${count("bot")} derived ${count("bot") === 1 ? "bot" : "bots"}`,
        ].filter(Boolean);
        throw new Error(
          `Used by ${parts.join(" and ")}. Remove ${using.length === 1 ? "it" : "them"} first${row.kind === "bot" ? ", or mark the bot retired" : ""}.`,
        );
      }
      this.db.run("DELETE FROM records WHERE id=:id", { id });
    });
  }
}

export function mountPokerbot(app: Hono, store: PokerbotStore) {
  app.get("/pokerbot/state", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(store.state());
  });
  app.put("/pokerbot/records/:id", async (c) => {
    store.put(pokerRecordIdSchema.parse(c.req.param("id")), pokerRecordInputSchema.parse(await c.req.json()));
    return c.json(store.state());
  });
  app.delete("/pokerbot/records/:id", (c) => {
    store.remove(pokerRecordIdSchema.parse(c.req.param("id")));
    return c.json(store.state());
  });
}
