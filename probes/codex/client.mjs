// Minimal JSON-RPC client for `codex app-server` over stdio, used by the
// Phase 0 probes. Every inbound and outbound message is appended to a JSONL
// transcript so the observed protocol can be reviewed afterwards.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

export function startAppServer({ transcript, args = [], env = process.env } = {}) {
  const child = spawn("codex", ["app-server", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  const record = (dir, msg) => {
    if (transcript) appendFileSync(transcript, `${JSON.stringify({ t: Date.now(), dir, msg })}\n`);
  };

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      record("in-raw", line);
      return;
    }
    record("in", msg);
    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : p.resolve(msg.result);
      }
      return;
    }
    for (const l of listeners) l(msg);
  });
  child.stderr.on("data", (d) => record("stderr", d.toString()));

  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      record("exit", { code, signal });
      for (const p of pending.values()) p.reject(new Error("app-server exited"));
      resolve({ code, signal });
    }),
  );

  const send = (msg) => {
    record("out", msg);
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  return {
    child,
    exited,
    request(method, params) {
      const id = nextId++;
      send({ id, method, params });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method, params) {
      send(params === undefined ? { method } : { method, params });
    },
    respond(id, result) {
      send({ id, result });
    },
    respondError(id, code, message) {
      send({ id, error: { code, message } });
    },
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    waitFor(pred, timeoutMs = 300_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error("waitFor timed out"));
        }, timeoutMs);
        const off = this.onMessage((m) => {
          if (pred(m)) {
            clearTimeout(timer);
            off();
            resolve(m);
          }
        });
      });
    },
    async initialize() {
      const res = await this.request("initialize", {
        clientInfo: { name: "workbench_probe", title: "Workbench probe", version: "0.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.notify("initialized");
      return res;
    },
    close() {
      child.stdin.end();
    },
  };
}
