import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Connection,
  type IdentityQuestion,
  type Person,
  type RolodexMessage,
  type RolodexPlan,
  type RolodexState,
  rolodexPlanSchema,
} from "@workbench/contracts";
import { Database } from "@workbench/db";

type MessageRow = {
  id: string;
  text: string;
  provider: RolodexMessage["provider"];
  status: RolodexMessage["status"];
  reply: string;
  error: string | null;
  questions: string;
  plan: string | null;
  created_at: string;
};
const normalize = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const unique = (values: string[]) => [...new Map(values.filter(Boolean).map((v) => [normalize(v), v])).values()];

export class RolodexStore {
  readonly db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.raw.exec(`CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES people(id), to_id TEXT NOT NULL REFERENCES people(id), body TEXT NOT NULL, UNIQUE(from_id,to_id));
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, text TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL,
        reply TEXT NOT NULL DEFAULT '', error TEXT, questions TEXT NOT NULL DEFAULT '[]', plan TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES (1,0);`);
  }
  private bump() {
    this.db.run("UPDATE meta SET revision = revision + 1");
  }
  people() {
    return this.db
      .all<{ body: string }>("SELECT body FROM people ORDER BY rowid")
      .map((r) => JSON.parse(r.body) as Person);
  }
  message(id: string) {
    return this.db.get<MessageRow>("SELECT * FROM messages WHERE id = :id", { id });
  }
  revision() {
    return this.db.get<{ revision: number }>("SELECT revision FROM meta")!.revision;
  }
  state(): RolodexState {
    return this.db.read(() => ({
      revision: this.revision(),
      people: this.people(),
      connections: this.db
        .all<{ body: string }>("SELECT body FROM connections ORDER BY rowid")
        .map((r) => JSON.parse(r.body) as Connection),
      messages: this.db
        .all<MessageRow>(
          "SELECT * FROM (SELECT rowid AS sequence,* FROM messages ORDER BY rowid DESC LIMIT 100) ORDER BY sequence",
        )
        .map((r) => ({
          id: r.id,
          text: r.text,
          provider: r.provider,
          status: r.status,
          reply: r.reply,
          error: r.error,
          questions: JSON.parse(r.questions),
          createdAt: r.created_at,
        })),
    }));
  }
  enqueue(id: string, text: string, provider: RolodexMessage["provider"]) {
    this.db.tx(() => {
      const old = this.message(id);
      if (old) {
        if (old.text !== text || old.provider !== provider)
          throw new Error("This request ID was already used for another message.");
        return;
      }
      this.db.run(
        "INSERT INTO messages (id,text,provider,status,created_at) VALUES (:id,:text,:provider,'queued',:now)",
        { id, text, provider, now: new Date().toISOString() },
      );
      this.bump();
    });
  }
  update(id: string, status: RolodexMessage["status"], error: string | null = null) {
    this.db.tx(() => {
      this.db.run("UPDATE messages SET status=:status,error=:error WHERE id=:id", { id, status, error });
      this.bump();
    });
  }
  recover() {
    this.db.tx(() => {
      this.db.run(
        "UPDATE messages SET status='failed',error='The mini-app restarted during this request. Your message is saved; submit it again to retry.' WHERE status='running'",
      );
      this.bump();
    });
  }
  next() {
    // A pending identity decision blocks later notes, so their interpretation
    // cannot race with an unconfirmed person creation or amendment.
    const row = this.db.get<MessageRow>(
      "SELECT * FROM messages WHERE status IN ('queued','running','confirm') ORDER BY rowid LIMIT 1",
    );
    return row?.status === "queued" ? row : undefined;
  }
  propose(id: string, input: unknown) {
    const plan = rolodexPlanSchema.parse(input);
    const keys = new Set(plan.people.map((p) => p.key));
    if (
      keys.size !== plan.people.length ||
      plan.connections.some((c) => !keys.has(c.from) || !keys.has(c.to) || c.from === c.to)
    )
      throw new Error("The agent returned invalid person references. No changes were saved.");
    const people = this.people();
    const questions: IdentityQuestion[] = plan.people.flatMap((mention) => {
      if (mention.existingId && !people.some((p) => p.id === mention.existingId))
        throw new Error("The agent referenced a person who no longer exists. No changes were saved.");
      const terms = unique([mention.name, ...mention.aliases]).map(normalize);
      const candidates = people.filter(
        (person) =>
          person.id === mention.existingId ||
          [person.name, ...person.aliases].some((alias) => {
            const name = normalize(alias);
            return terms.some(
              (term) =>
                name === term ||
                name.startsWith(`${term} `) ||
                term.startsWith(`${name} `) ||
                (term.split(" ")[0] === name.split(" ")[0] &&
                  (term.split(" ").length === 1 || name.split(" ").length === 1)),
            );
          }),
      );
      if (!candidates.length) return [];
      const suggested = candidates.some((p) => p.id === mention.existingId)
        ? mention.existingId
        : candidates.length === 1
          ? candidates[0]!.id
          : null;
      candidates.sort((a, b) => Number(b.id === suggested) - Number(a.id === suggested));
      return [{ key: mention.key, name: mention.name, details: mention.details, candidates, suggested }];
    });
    this.db.tx(() => {
      this.db.run("UPDATE messages SET plan=:plan,questions=:questions,status='confirm' WHERE id=:id", {
        id,
        plan: JSON.stringify(plan),
        questions: JSON.stringify(questions),
      });
      this.bump();
      if (!questions.length) this.resolve(id, {});
    });
  }
  resolve(id: string, choices: Record<string, string | null>, cancel = false) {
    this.db.tx(() => {
      const message = this.message(id);
      if (!message) throw new Error("Message not found.");
      if (message.status === "done" || message.status === "cancelled") return;
      if (message.status !== "confirm" || !message.plan) throw new Error("This message is not waiting for a decision.");
      if (cancel) {
        this.update(id, "cancelled");
        return;
      }
      const questions = JSON.parse(message.questions) as IdentityQuestion[];
      for (const q of questions) {
        if (!(q.key in choices) || (choices[q.key] !== null && !q.candidates.some((p) => p.id === choices[q.key])))
          throw new Error(`Choose an existing person or create a new ${q.name}.`);
      }
      const plan = JSON.parse(message.plan) as RolodexPlan;
      const mapped = new Map<string, string>();
      const now = new Date().toISOString();
      for (const incoming of plan.people) {
        const selected = choices[incoming.key];
        const old = selected ? this.people().find((p) => p.id === selected) : undefined;
        if (selected && !old) throw new Error("That person was removed. Review the match again.");
        const person: Person = {
          id: old?.id ?? crypto.randomUUID(),
          name: incoming.renameTo ?? old?.name ?? incoming.name,
          headline: incoming.headline ?? old?.headline ?? "",
          details: unique([
            ...(old?.details ?? []).filter(
              (detail) => !incoming.removeDetails.some((r) => normalize(r) === normalize(detail)),
            ),
            ...incoming.details,
          ]),
          aliases: unique([
            ...(old?.aliases ?? []),
            ...(old && incoming.renameTo ? [old.name] : []),
            ...incoming.aliases,
            ...(old && normalize(old.name) !== normalize(incoming.name) ? [incoming.name] : []),
          ]),
          tags: unique([...(old?.tags ?? []), ...incoming.tags]),
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
        };
        this.db.run("INSERT INTO people VALUES (:id,:body) ON CONFLICT(id) DO UPDATE SET body=excluded.body", {
          id: person.id,
          body: JSON.stringify(person),
        });
        mapped.set(incoming.key, person.id);
      }
      for (const link of plan.connections) {
        const endpoints = [mapped.get(link.from)!, mapped.get(link.to)!].sort();
        if (endpoints[0] === endpoints[1])
          throw new Error("Both ends of this connection resolve to the same person. Choose distinct people.");
        const connection: Connection = {
          id: `${endpoints[0]}:${endpoints[1]}`,
          from: endpoints[0]!,
          to: endpoints[1]!,
          label: link.label,
          context: link.context,
          updatedAt: now,
        };
        if (link.action === "remove") this.db.run("DELETE FROM connections WHERE id=:id", { id: connection.id });
        else
          this.db.run(
            "INSERT INTO connections VALUES (:id,:from,:to,:body) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
            { id: connection.id, from: connection.from, to: connection.to, body: JSON.stringify(connection) },
          );
      }
      this.db.run("UPDATE messages SET status='done',reply=:reply,error=NULL WHERE id=:id", {
        id,
        reply: plan.reply || "Your network is up to date.",
      });
      this.bump();
    });
  }
}
