import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type PokerRecordInput, pokerHeadToHead, pokerRecordInputSchema, pokerStandings } from "@workbench/contracts";
import { PokerbotStore } from "../src/pokerbot.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-pokerbot-test-"));
  const path = join(dir, "pokerbot.sqlite");
  let store = new PokerbotStore(path);
  return {
    get store() {
      return store;
    },
    reopen() {
      store.db.close();
      store = new PokerbotStore(path);
    },
    cleanup() {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const match = (seats: [string, number, number | null][], hands = 1000, experimentId: string | null = null) =>
  ({
    kind: "match",
    playedOn: "2026-10-27",
    hands,
    seats: seats.map(([botId, chips, sd]) => ({ botId, chips, sd })),
    experimentId,
    notes: "",
  }) satisfies PokerRecordInput;

test("a new tracker is seeded once, and deleted seeds stay deleted", () => {
  const f = fixture();
  try {
    const { bots, algorithms, playbook } = f.store.state();
    assert.equal(bots.length, 4);
    assert.ok(algorithms.length > 10);
    assert.equal(
      playbook.steps.reduce((n, s) => n + s.minutes, 0),
      60,
    );
    f.store.remove("random");
    f.reopen();
    assert.equal(f.store.state().bots.length, 3);
  } finally {
    f.cleanup();
  }
});

test("matches must be zero-sum between distinct, existing bots", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.store.put(
          "m1",
          match([
            ["pot-odds", 500, null],
            ["random", -400, null],
          ]),
        ),
      /total 0/,
    );
    assert.throws(
      () =>
        f.store.put(
          "m1",
          match([
            ["pot-odds", 500, null],
            ["pot-odds", -500, null],
          ]),
        ),
      /only once/,
    );
    assert.throws(
      () =>
        f.store.put(
          "m1",
          match([
            ["pot-odds", 500, null],
            ["ghost", -500, null],
          ]),
        ),
      /no longer exists/,
    );
    assert.throws(
      () =>
        f.store.put(
          "random",
          match([
            ["pot-odds", 500, null],
            ["always-call", -500, null],
          ]),
        ),
      /is a bot/,
    );
    assert.equal(f.store.state().matches.length, 0);
  } finally {
    f.cleanup();
  }
});

test("records in use cannot be deleted, and the playbook never can", () => {
  const f = fixture();
  try {
    f.store.put("x1", {
      kind: "experiment",
      title: "Open size",
      question: "",
      setup: "",
      status: "running",
      findings: "",
      botIds: ["pot-odds"],
    });
    f.store.put(
      "m1",
      match(
        [
          ["pot-odds", 500, null],
          ["random", -500, null],
        ],
        1000,
        "x1",
      ),
    );
    assert.throws(() => f.store.remove("pot-odds"), /Used by 1 match and 1 experiment/);
    assert.throws(() => f.store.remove("x1"), /Used by 1 match/);
    assert.throws(() => f.store.remove("playbook"), /cannot be deleted/);
    f.store.remove("m1");
    f.store.remove("x1");
    f.store.remove("pot-odds");
  } finally {
    f.cleanup();
  }
});

test("a plan over the hour is rejected at the boundary", () => {
  const steps = [
    { title: "Build", minutes: 50, detail: "" },
    { title: "Test", minutes: 15, detail: "" },
  ];
  assert.equal(pokerRecordInputSchema.safeParse({ kind: "playbook", steps }).success, false);
});

test("head-to-head results pool matches from each bot's side, with a pooled 95% interval", () => {
  const f = fixture();
  try {
    // 1,000 hands at +5 chips/hand and 3,000 at +1 chip/hand: 8,000 chips over 4,000 hands = +2 chips = +20 mbb/hand.
    f.store.put(
      "m1",
      match(
        [
          ["pot-odds", 5000, 100],
          ["random", -5000, 100],
        ],
        1000,
      ),
    );
    f.store.put(
      "m2",
      match(
        [
          ["random", -3000, 100],
          ["pot-odds", 3000, 100],
        ],
        3000,
      ),
    );
    const { bots, matches } = f.store.state();
    const r = pokerHeadToHead(matches, "pot-odds", "random")!;
    assert.equal(r.hands, 4000);
    assert.equal(r.mbb, 20);
    // sd 100 chips over 4,000 hands: 1.96 × 100 / √4000 chips = 31.0 mbb.
    assert.ok(Math.abs(r.ci! - 30.99) < 0.01);
    assert.equal(pokerHeadToHead(matches, "random", "pot-odds")!.mbb, -20);
    assert.equal(pokerHeadToHead(matches, "pot-odds", "always-call"), null);

    f.store.put(
      "m3",
      match(
        [
          ["pot-odds", 1000, null],
          ["random", -400, null],
          ["always-call", -600, null],
        ],
        500,
      ),
    );
    const standing = pokerStandings(bots, f.store.state().matches).find((s) => s.bot.id === "pot-odds")!;
    assert.equal(standing.headsUp!.mbb, 20);
    assert.deepEqual(standing.table, { hands: 500, chips: 1000, mbb: 20, ci: null });
  } finally {
    f.cleanup();
  }
});

test("lineage parents must exist and cannot loop back to the bot itself", () => {
  const f = fixture();
  try {
    const bot = (parents: { botId: string; kept: string }[]) =>
      ({ kind: "bot", name: "X", version: "", approach: "", status: "idea", source: "", notes: "", parents }) as const;
    f.store.put("child", bot([{ botId: "pot-odds", kept: "equity" }]));
    f.store.put("grandchild", bot([{ botId: "child", kept: "everything" }]));
    assert.throws(() => f.store.put("pot-odds", bot([{ botId: "grandchild", kept: "" }])), /own ancestor/);
    assert.throws(() => f.store.put("orphan", bot([{ botId: "ghost", kept: "" }])), /does not exist/);
    assert.throws(() => f.store.remove("child"), /1 derived bot/);
  } finally {
    f.cleanup();
  }
});
