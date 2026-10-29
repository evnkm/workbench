import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RolodexPlan } from "@workbench/contracts";
import { RolodexStore } from "../src/store.ts";

const person = (key: string, name: string, details: string[] = []): RolodexPlan["people"][number] => ({
  key,
  name,
  renameTo: null,
  existingId: null,
  headline: null,
  details,
  removeDetails: [],
  tags: [],
  aliases: [],
});
const plan = (people: RolodexPlan["people"], connections: RolodexPlan["connections"] = []): RolodexPlan => ({
  reply: "Network updated.",
  people,
  connections,
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-rolodex-test-"));
  const path = join(dir, "rolodex.sqlite");
  const store = new RolodexStore(path);
  const submit = (text: string, value: RolodexPlan) => {
    const id = crypto.randomUUID();
    store.enqueue(id, text, "codex");
    store.update(id, "running");
    store.propose(id, value);
    return id;
  };
  return {
    store,
    path,
    submit,
    cleanup: () => {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a note atomically creates people and connections; idempotent submission does not duplicate it", () => {
  const f = fixture();
  try {
    const id = f.submit(
      "Bob knows Alice",
      plan(
        [person("b", "Bob", ["Designer"]), person("a", "Alice", ["Engineer"])],
        [{ from: "b", to: "a", label: "knows", context: "Met at a meetup", action: "upsert" }],
      ),
    );
    assert.equal(f.store.state().people.length, 2);
    assert.equal(f.store.state().connections.length, 1);
    assert.equal(f.store.state().messages[0]!.status, "done");
    f.store.enqueue(id, "Bob knows Alice", "codex");
    assert.equal(f.store.state().messages.length, 1);
    assert.throws(() => f.store.enqueue(id, "Different note", "codex"), /already used/);
    assert.equal(f.store.next(), undefined);
  } finally {
    f.cleanup();
  }
});

test("ambiguous identity stages the whole note, exposes real cards, and merges only after confirmation", () => {
  const f = fixture();
  try {
    f.submit("Bob Smith is a designer", plan([person("b", "Bob Smith", ["Designer", "Likes climbing"])]));
    const bob = f.store.people()[0]!;
    const id = f.submit(
      "Bob knows Alice",
      plan(
        [person("b", "Bob", ["Met at a robotics meetup"]), person("a", "Alice")],
        [{ from: "b", to: "a", label: "colleague", context: "Robotics", action: "upsert" }],
      ),
    );
    assert.equal(f.store.state().people.length, 1);
    assert.equal(f.store.state().connections.length, 0);
    assert.equal(f.store.state().messages.at(-1)!.questions[0]!.candidates[0]!.details[1], "Likes climbing");
    assert.equal(f.store.state().messages.at(-1)!.questions[0]!.suggested, bob.id);
    assert.throws(() => f.store.resolve(id, {}), /Choose/);
    assert.throws(() => f.store.resolve(id, { b: "not-a-candidate" }), /Choose/);
    f.store.resolve(id, { b: bob.id });
    f.store.resolve(id, { b: bob.id });
    assert.equal(f.store.state().people.length, 2);
    assert.deepEqual(f.store.people().find((p) => p.id === bob.id)!.details, [
      "Designer",
      "Likes climbing",
      "Met at a robotics meetup",
    ]);
    assert.equal(f.store.state().connections.length, 1);
  } finally {
    f.cleanup();
  }
});

test("same-name people remain separate and future notes show both cards", () => {
  const f = fixture();
  try {
    f.submit("First Bob", plan([person("b", "Bob", ["Designer"])]));
    const second = f.submit("Another Bob", plan([person("b", "Bob", ["Engineer"])]));
    f.store.resolve(second, { b: null });
    assert.equal(f.store.people().length, 2);
    const third = f.submit("Bob likes music", plan([person("b", "Bob", ["Likes music"])]));
    assert.equal(f.store.state().messages.at(-1)!.questions[0]!.candidates.length, 2);
    assert.equal(f.store.state().messages.at(-1)!.questions[0]!.suggested, null);
    const revision = f.store.state().revision;
    const waiting = crypto.randomUUID();
    f.store.enqueue(waiting, "A later note", "claude");
    assert.equal(f.store.next(), undefined);
    f.store.resolve(third, {}, true);
    assert.equal(f.store.people().length, 2);
    assert.ok(f.store.state().revision > revision);
    assert.equal(f.store.next()!.id, waiting);
  } finally {
    f.cleanup();
  }
});

test("amendments preserve unrelated facts and explicit name corrections preserve aliases", () => {
  const f = fixture();
  try {
    f.submit("Bob Smith", plan([person("b", "Bob Smith", ["Works at Oldco", "Likes climbing"])]));
    const bob = f.store.people()[0]!;
    const incoming = {
      ...person("b", "Bob Smith", ["Works at Newco"]),
      renameTo: "Bob Jones",
      removeDetails: ["Works at Oldco"],
      headline: "Designer at Newco",
    };
    const id = f.submit("Correct Bob's name and company", plan([incoming]));
    f.store.resolve(id, { b: bob.id });
    const updated = f.store.people()[0]!;
    assert.equal(updated.id, bob.id);
    assert.equal(updated.name, "Bob Jones");
    assert.deepEqual(updated.details, ["Likes climbing", "Works at Newco"]);
    assert.ok(updated.aliases.includes("Bob Smith"));
  } finally {
    f.cleanup();
  }
});

test("bad references and self-connections cannot partially change the graph", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.submit(
          "Invalid",
          plan([person("b", "Bob")], [{ from: "b", to: "unknown", label: "knows", context: "", action: "upsert" }]),
        ),
      /invalid person references/,
    );
    assert.equal(f.store.people().length, 0);
    f.submit("Bob", plan([person("b", "Bob")]));
    const bob = f.store.people()[0]!;
    const id = f.submit(
      "Two references",
      plan(
        [person("a", "Bob"), person("b", "Bob")],
        [{ from: "a", to: "b", label: "knows", context: "", action: "upsert" }],
      ),
    );
    assert.throws(() => f.store.resolve(id, { a: bob.id, b: bob.id }), /same person/);
    assert.equal(f.store.people().length, 1);
    assert.equal(f.store.state().connections.length, 0);
    assert.equal(f.store.message(id)!.status, "confirm");
  } finally {
    f.cleanup();
  }
});

test("SQLite survives reopening; restarts preserve pending decisions and fail interrupted extraction visibly", () => {
  const f = fixture();
  try {
    f.submit("Bob", plan([person("b", "Bob")]));
    const decision = f.submit("Bob's note", plan([person("b", "Bob", ["Likes music"])]));
    const interrupted = crypto.randomUUID();
    f.store.enqueue(interrupted, "A running note", "codex");
    f.store.update(interrupted, "running");
    const reopened = new RolodexStore(f.path);
    try {
      reopened.recover();
      assert.equal(reopened.message(decision)!.status, "confirm");
      assert.equal(reopened.message(interrupted)!.status, "failed");
      assert.equal(reopened.people().length, 1);
      assert.match(reopened.message(interrupted)!.error!, /restarted/);
    } finally {
      reopened.db.close();
    }
  } finally {
    f.cleanup();
  }
});

test("the agent's existing-person hint is the suggested match and listed first", () => {
  const f = fixture();
  try {
    f.submit("First Bob", plan([person("b", "Bob", ["Designer"])]));
    const second = f.submit("Another Bob", plan([person("b", "Bob", ["Engineer"])]));
    f.store.resolve(second, { b: null });
    const engineer = f.store.people().find((p) => p.details.includes("Engineer"))!;
    f.submit(
      "Bob the engineer likes music",
      plan([{ ...person("b", "Bob", ["Likes music"]), existingId: engineer.id }]),
    );
    const question = f.store.state().messages.at(-1)!.questions[0]!;
    assert.equal(question.suggested, engineer.id);
    assert.equal(question.candidates[0]!.id, engineer.id);
  } finally {
    f.cleanup();
  }
});
