// Browser terminals: a WebSocket per attachment, relayed to a `tmux attach`
// client in a PTY. Closing the socket only detaches; the shell keeps running
// in the tmux server. Frames from the browser are JSON:
//   {"t":"i","d":"<input>"}   keyboard input
//   {"t":"r","c":cols,"r":rows} resize
// Frames to the browser are raw terminal output (text).
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type Config, type Database, getProcess, type Logger } from "@workbench/db";
import { exec } from "@workbench/runtime";
import { spawn as spawnPty } from "node-pty";
import { WebSocketServer } from "ws";
import type { Auth } from "./auth.ts";

const PATH = /^\/api\/processes\/([0-9a-f-]{36})\/terminal$/;

export function attachTerminals(server: Server, deps: { db: Database; config: Config; auth: Auth; log: Logger }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    const m = PATH.exec(url.pathname);
    if (!m) return; // other upgrade handlers (previews) may claim it
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!deps.auth.originAllowed(req.headers.origin, req.headers.host, true)) return reject(403, "Forbidden");
    if (!deps.auth.authenticatedCookieHeader(req.headers.cookie)) return reject(401, "Unauthorized");
    const proc = getProcess(deps.db, m[1]!);
    // Exited apps keep their final screen (remain-on-exit), so they can still be attached.
    if (!proc || (proc.kind === "shell" && !["running", "starting"].includes(proc.state)))
      return reject(404, "Not Found");
    const cols = clamp(Number(url.searchParams.get("cols")), 20, 500, 100);
    const rows = clamp(Number(url.searchParams.get("rows")), 5, 200, 30);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const pty = spawnPty("tmux", ["-L", deps.config.tmuxSocket, "attach-session", "-t", `=${proc.tmuxSession}`], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: proc.cwd,
        env: {
          TERM: "xterm-256color",
          LANG: process.env.LANG ?? "C.UTF-8",
          HOME: process.env.HOME ?? "/",
          PATH: process.env.PATH ?? "",
        },
      });
      deps.log.info("terminal attached", { processId: proc.id });
      pty.onData((d) => {
        if (ws.readyState === ws.OPEN) ws.send(d);
      });
      pty.onExit(() => ws.close(1000, "detached"));
      ws.on("message", (raw) => {
        let msg: { t: string; d?: string; c?: number; r?: number };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.t === "i" && typeof msg.d === "string") pty.write(msg.d);
        if (msg.t === "r") pty.resize(clamp(msg.c, 20, 500, cols), clamp(msg.r, 5, 200, rows));
      });
      ws.on("close", () => {
        try {
          pty.kill();
        } catch {}
      });
    });
  });
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt;
};

/** Scrollback of a session as plain text, for bounded replay on reattach. */
export async function captureHistory(config: Config, session: string, lines: number): Promise<string> {
  const r = await exec("tmux", [
    "-L",
    config.tmuxSocket,
    "capture-pane",
    "-p",
    "-J",
    "-S",
    `-${lines}`,
    "-t",
    `=${session}:`,
  ]);
  return r.code === 0 ? r.stdout.replace(/\n+$/, "\n") : "";
}
