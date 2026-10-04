// JSON-RPC client for one `codex app-server` child process over stdio.
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Logger } from "@workbench/db";
import type { RequestId } from "./protocol/RequestId.ts";

export type RpcMessage = {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export type AppServerEvents = {
  notification: [method: string, params: unknown];
  request: [id: RequestId, method: string, params: unknown];
  exit: [code: number | null, signal: NodeJS.Signals | null];
};

/**
 * One app-server process. `generation` distinguishes processes so replies to
 * server requests are never sent to a process that did not issue them.
 */
export class AppServer extends EventEmitter<AppServerEvents> {
  readonly generation: number;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    RequestId,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private exited = false;
  private readonly bin: string;
  private readonly log: Logger;

  constructor(bin: string, generation: number, log: Logger) {
    super();
    this.bin = bin;
    this.generation = generation;
    this.log = log;
  }

  get alive() {
    return this.child !== null && !this.exited;
  }

  async start(): Promise<{ userAgent: string }> {
    const child = spawn(this.bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.child = child;
    child.on("exit", (code, signal) => {
      this.exited = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Codex app-server exited"));
      }
      this.pending.clear();
      this.emit("exit", code, signal);
    });
    child.on("error", (e) => this.log.error("codex app-server spawn error", { err: e }));
    child.stdin!.on("error", () => {});
    createInterface({ input: child.stderr! }).on("line", (line) => {
      if (line.trim()) this.log.debug("codex stderr", { line: line.slice(0, 2000) });
    });
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));

    const init = (await this.request("initialize", {
      clientInfo: { name: "workbench", title: "Workbench", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })) as { userAgent: string };
    this.notify("initialized");
    return init;
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.warn("unparseable app-server output", { line: line.slice(0, 500) });
      return;
    }
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      this.emit("request", msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method !== undefined) this.emit("notification", msg.method, msg.params);
  }

  private write(msg: RpcMessage) {
    if (!this.alive) throw new Error("Codex app-server is not running");
    this.child!.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  /**
   * Send a request. Every request has a timeout: app-server does not answer
   * some requests at all (for example interrupting a finished turn).
   */
  request<T = unknown>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: RequestId, result: unknown) {
    this.write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string) {
    this.write({ id, error: { code, message } });
  }

  stop(signal: NodeJS.Signals = "SIGTERM") {
    if (this.alive) this.child!.kill(signal);
  }
}
