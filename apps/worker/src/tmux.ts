// Thin wrapper over the dedicated tmux server (decision 0004). In production
// `workbench-tmux.service` owns the server; in development the worker starts
// it on demand.
import { join } from "node:path";
import type { Logger } from "@workbench/db";
import { exec, projectEnv } from "./util.ts";

export const TMUX_CONF = join(import.meta.dirname, "../../../deploy/tmux.conf");

export type PaneInfo = { session: string; dead: boolean; status: number | null; pid: number };

export class Tmux {
  readonly socket: string;
  private readonly log: Logger;

  constructor(socket: string, log: Logger) {
    this.socket = socket;
    this.log = log;
  }

  private run(args: string[]) {
    return exec("tmux", ["-L", this.socket, ...args], { env: projectEnv(), timeoutMs: 10_000 });
  }

  async ensureServer() {
    const r = await this.run(["list-sessions"]);
    if (r.code === 0 || /no sessions/i.test(r.stderr)) return;
    this.log.warn("tmux server not running; starting it (unsupervised outside systemd)", { socket: this.socket });
    const s = await this.run(["-f", TMUX_CONF, "start-server"]);
    if (s.code !== 0) throw new Error(`could not start tmux: ${s.stderr}`);
  }

  async newSession(name: string, cwd: string, env: Record<string, string>, command?: string) {
    await this.ensureServer();
    const args = ["new-session", "-d", "-s", name, "-c", cwd, "-x", "200", "-y", "50"];
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    if (command) args.push(command);
    const r = await this.run(args);
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim()}`);
  }

  async kill(name: string) {
    await this.run(["kill-session", "-t", `=${name}`]);
  }

  async panes(): Promise<PaneInfo[] | null> {
    const r = await this.run([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}",
    ]);
    // A server with no sessions reports "no current target"; a missing server, "no server running".
    if (r.code !== 0)
      return /no server running|no sessions|no current target|error connecting/i.test(r.stderr) ? [] : null;
    return r.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [session, dead, status, pid] = l.split("\t");
        return { session: session!, dead: dead === "1", status: status ? Number(status) : null, pid: Number(pid) };
      });
  }

  async capture(name: string, lines: number): Promise<string> {
    const r = await this.run(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", `=${name}:`]);
    return r.code === 0 ? r.stdout : "";
  }
}
