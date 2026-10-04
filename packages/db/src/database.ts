import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { migrations } from "./migrations.ts";

export type Params = Record<string, SQLInputValue>;

/**
 * Thin wrapper over `node:sqlite`. The API and the worker each open their own
 * connection to the same WAL database; transactions are short and use
 * BEGIN IMMEDIATE so writers queue on the busy timeout instead of failing.
 */
export class Database {
  readonly raw: DatabaseSync;
  readonly path: string;
  private depth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path, { timeout: 5000 });
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
  }

  migrate(): number {
    const current = this.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
    for (const m of migrations) {
      if (m.version <= current) continue;
      this.tx(() => {
        // Re-check inside the write lock in case another process migrated first.
        const v = this.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
        if (m.version <= v) return;
        this.raw.exec(m.sql);
        this.raw.exec(`PRAGMA user_version = ${m.version}`);
      });
    }
    return this.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
  }

  get<T>(sql: string, params: Params = {}): T | undefined {
    return this.raw.prepare(sql).get(params) as T | undefined;
  }

  all<T>(sql: string, params: Params = {}): T[] {
    return this.raw.prepare(sql).all(params) as T[];
  }

  run(sql: string, params: Params = {}): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /**
   * Run `fn` in a write transaction. Nested calls use a savepoint, so an
   * inner failure that the caller catches rolls back only the inner work.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      const sp = `sp${this.depth}`;
      this.raw.exec(`SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const result = fn();
        this.raw.exec(`RELEASE ${sp}`);
        return result;
      } catch (e) {
        this.raw.exec(`ROLLBACK TO ${sp}`);
        this.raw.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        this.depth--;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  /** Run `fn` in a read transaction so multiple queries see one snapshot. */
  read<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN DEFERRED");
    this.depth = 1;
    try {
      return fn();
    } finally {
      this.depth = 0;
      this.raw.exec("COMMIT");
    }
  }

  /** Consistent online copy using VACUUM INTO. */
  backupTo(target: string): void {
    mkdirSync(dirname(target), { recursive: true });
    this.raw.prepare("VACUUM INTO ?").run(target);
  }

  close(): void {
    this.raw.close();
  }
}
