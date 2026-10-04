export { type ExecResult, exec, execOk } from "@workbench/runtime";

/** FIFO mutex per key, used to serialize mutations of one repository or conversation. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** Environment for project processes: drops agent credentials and Workbench settings. */
export function projectEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(WORKBENCH_|OPENAI_|ANTHROPIC_|CODEX_|CLAUDE)/.test(k)) continue;
    if (k === "INVOCATION_ID" || k === "JOURNAL_STREAM" || k === "NOTIFY_SOCKET") continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export function slugify(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "workspace"
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keep the end of a string within `max` characters. */
export function tail(s: string, max: number): { text: string; truncated: boolean } {
  return s.length > max ? { text: s.slice(s.length - max), truncated: true } : { text: s, truncated: false };
}
